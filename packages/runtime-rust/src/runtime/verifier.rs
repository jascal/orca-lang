use std::collections::{HashMap, HashSet, VecDeque};
use super::types::*;

/// Verify a machine definition. Returns warnings on success, or an error on failure.
pub fn verify(def: &MachineDef) -> Result<Vec<VerifyWarning>, VerifyError> {
    let mut warnings = Vec::new();

    // 1. Exactly one initial state
    let initial_states: Vec<&StateDef> = def.states.iter().filter(|s| s.is_initial).collect();
    if initial_states.is_empty() {
        return Err(VerifyError {
            message: "No initial state found".to_string(),
            code: VerifyCode::NoInitialState,
        });
    }
    if initial_states.len() > 1 {
        return Err(VerifyError {
            message: format!(
                "Multiple initial states: {}",
                initial_states.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
            ),
            code: VerifyCode::MultipleInitialStates,
        });
    }

    // Build state name set
    let state_names: HashSet<&str> = def.states.iter().map(|s| s.name.as_str()).collect();

    // 2. All transition sources/targets reference defined states
    for t in &def.transitions {
        if !state_names.contains(t.source.as_str()) {
            return Err(VerifyError {
                message: format!(
                    "Transition source '{}' is not a defined state",
                    t.source
                ),
                code: VerifyCode::InvalidTransitionSource,
            });
        }
        if !state_names.contains(t.target.as_str()) {
            return Err(VerifyError {
                message: format!(
                    "Transition target '{}' is not a defined state",
                    t.target
                ),
                code: VerifyCode::InvalidTransitionTarget,
            });
        }
    }

    // 3. Determinism check: no multiple unguarded transitions for same (state, event)
    check_determinism(def, &mut warnings);

    // 4. Guard-aware reachability from initial state (BFS)
    let initial_name = &initial_states[0].name;
    let mut reachable: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(initial_name.as_str());
    reachable.insert(initial_name.as_str());

    while let Some(current) = queue.pop_front() {
        for t in &def.transitions {
            if t.source == current && !reachable.contains(t.target.as_str()) {
                // Skip transitions with statically-false guards
                if let Some(ref guard_name) = t.guard {
                    if let Some(expr) = resolve_guard(def, guard_name) {
                        if is_statically_false(&expr) {
                            continue;
                        }
                    }
                }
                reachable.insert(t.target.as_str());
                queue.push_back(t.target.as_str());
            }
        }
    }

    for state in &def.states {
        if !reachable.contains(state.name.as_str()) {
            warnings.push(VerifyWarning {
                message: format!("State '{}' is unreachable from initial state", state.name),
                code: VerifyCode::UnreachableState,
            });
        }
    }

    // 5. Deadlock detection: non-final state with no outgoing transitions
    let states_with_outgoing: HashSet<&str> =
        def.transitions.iter().map(|t| t.source.as_str()).collect();

    for state in &def.states {
        if !state.is_final && !states_with_outgoing.contains(state.name.as_str()) {
            warnings.push(VerifyWarning {
                message: format!(
                    "State '{}' has no outgoing transitions (potential deadlock)",
                    state.name
                ),
                code: VerifyCode::Deadlock,
            });
        }
    }

    Ok(warnings)
}

/// Check for non-deterministic transitions (multiple unguarded or guards not mutually exclusive).
fn check_determinism(def: &MachineDef, warnings: &mut Vec<VerifyWarning>) {
    // Group transitions by (source, event)
    let mut by_key: HashMap<(String, String), Vec<&Transition>> = HashMap::new();
    for t in &def.transitions {
        by_key
            .entry((t.source.clone(), t.event.clone()))
            .or_default()
            .push(t);
    }

    for ((source, event), transitions) in by_key {
        if transitions.len() <= 1 {
            continue;
        }

        let unguarded_count = transitions.iter().filter(|t| t.guard.is_none()).count();
        if unguarded_count > 1 {
            warnings.push(VerifyWarning {
                message: format!(
                    "State '{}' has multiple unguarded transitions for event '{}'",
                    source, event
                ),
                code: VerifyCode::NonDeterministic,
            });
            continue;
        }

        // Check guards are mutually exclusive
        let guarded: Vec<&Transition> = transitions.iter().cloned().filter(|t| t.guard.is_some()).collect();
        if guarded.len() <= 1 {
            continue;
        }

        // Try to resolve all guards; if any fail, skip exhaustive check
        let mut guard_exprs: Vec<GuardExpression> = Vec::new();
        for t in &guarded {
            match resolve_guard(def, t.guard.as_ref().unwrap()) {
                Some(expr) => guard_exprs.push(expr),
                None => {
                    // Can't resolve all guards — skip exhaustive check
                    break;
                }
            }
        }
        if guard_exprs.len() != guarded.len() {
            continue;
        }

        let all_exclusive = guard_exprs
            .iter()
            .enumerate()
            .all(|(i, expr_i)| {
                guard_exprs[i + 1..]
                    .iter()
                    .all(|expr_j| are_mutually_exclusive(expr_i, expr_j))
            });

        if !all_exclusive {
            warnings.push(VerifyWarning {
                message: format!(
                    "State '{}' transitions for event '{}' may not be exhaustive: {}",
                    source,
                    event,
                    guarded
                        .iter()
                        .map(|t| format!("[{}]", t.guard.as_ref().unwrap()))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                code: VerifyCode::GuardExhaustiveness,
            });
        }
    }
}

/// Resolve a guard name to its GuardExpression.
fn resolve_guard(def: &MachineDef, name: &str) -> Option<GuardExpression> {
    // Handle negation prefix
    let (negated, name) = if let Some(rest) = name.strip_prefix('!') {
        (true, rest)
    } else {
        (false, name)
    };

    let expr = def.guards.get(name)?.clone();

    if negated {
        Some(GuardExpression::Not(Box::new(expr)))
    } else {
        Some(expr)
    }
}

/// Returns true if a guard expression is statically false (always evaluates to false).
fn is_statically_false(expr: &GuardExpression) -> bool {
    match expr {
        GuardExpression::False => true,
        GuardExpression::Not(inner) => {
            // not(false) = true — not statically false
            // not(true) = false — statically false
            matches!(**inner, GuardExpression::True)
        }
        GuardExpression::And(left, right) => {
            // AND is false if either branch is false
            is_statically_false(left) || is_statically_false(right)
        }
        GuardExpression::Or(left, right) => {
            // OR is false only if both branches are false
            is_statically_false(left) && is_statically_false(right)
        }
        _ => false,
    }
}

/// Returns true if two guard expressions are mutually exclusive (can never both be true).
fn are_mutually_exclusive(a: &GuardExpression, b: &GuardExpression) -> bool {
    // Unwrap NOT layers
    let a_norm = unwrap_not(a);
    let b_norm = unwrap_not(b);

    // Same expression with opposite negation
    if a_norm.negated != b_norm.negated && exprs_equal(&a_norm.expr, &b_norm.expr) {
        return true;
    }

    match (&a_norm.expr, &b_norm.expr) {
        // true vs false
        (GuardExpression::True, GuardExpression::False) => true,
        (GuardExpression::False, GuardExpression::True) => true,

        // Complementary comparisons on the same variable
        (
            GuardExpression::Compare { op: op1, left: la, right: va },
            GuardExpression::Compare { op: op2, left: lb, right: vb },
        ) if var_refs_equal(la, lb) => comparisons_exclusive(*op1, va, *op2, vb),

        // Complementary nullchecks on the same variable
        (
            GuardExpression::Nullcheck { expr: na, is_null: ia },
            GuardExpression::Nullcheck { expr: nb, is_null: ib },
        ) if var_refs_equal(na, nb) && ia != ib => true,

        // Compare vs nullcheck: ctx.x == value vs ctx.x is null
        (
            GuardExpression::Compare { left: lc, .. },
            GuardExpression::Nullcheck { expr: nn, is_null: true },
        ) if var_refs_equal(lc, nn) => true,
        (
            GuardExpression::Nullcheck { expr: nn, is_null: true },
            GuardExpression::Compare { left: lc, .. },
        ) if var_refs_equal(nn, lc) => true,

        _ => false,
    }
}

struct UnwrappedExpr<'a> {
    expr: &'a GuardExpression,
    negated: bool,
}

fn unwrap_not(expr: &GuardExpression) -> UnwrappedExpr {
    let mut negated = false;
    let mut current = expr;
    while let GuardExpression::Not(inner) = current {
        negated = !negated;
        current = inner;
    }
    UnwrappedExpr { expr: current, negated }
}

fn exprs_equal(a: &GuardExpression, b: &GuardExpression) -> bool {
    use GuardExpression::*;
    match (a, b) {
        (True, True) | (False, False) => true,
        (Not(a1), Not(b1)) => exprs_equal(a1, b1),
        (And(a1, a2), And(b1, b2)) => exprs_equal(a1, b1) && exprs_equal(a2, b2),
        (Or(a1, a2), Or(b1, b2)) => exprs_equal(a1, b1) && exprs_equal(a2, b2),
        (
            Compare { op: o1, left: l1, right: r1 },
            Compare { op: o2, left: l2, right: r2 },
        ) => o1 == o2 && var_refs_equal(l1, l2) && values_equal(r1, r2),
        (
            Nullcheck { expr: e1, is_null: n1 },
            Nullcheck { expr: e2, is_null: n2 },
        ) => var_refs_equal(e1, e2) && n1 == n2,
        _ => false,
    }
}

fn var_refs_equal(a: &VariableRef, b: &VariableRef) -> bool {
    a.path.len() == b.path.len() && a.path.iter().eq(b.path.iter())
}

fn values_equal(a: &ValueRef, b: &ValueRef) -> bool {
    use ValueRef::*;
    match (a, b) {
        (Str(a), Str(b)) => a == b,
        (Number(a), Number(b)) => (a - b).abs() < 1e-10,
        (Integer(a), Integer(b)) => a == b,
        (Boolean(a), Boolean(b)) => a == b,
        (Null, Null) => true,
        _ => false,
    }
}

/// Check if two comparisons on the same variable are mutually exclusive.
fn comparisons_exclusive(op1: CompareOp, v1: &ValueRef, op2: CompareOp, v2: &ValueRef) -> bool {
    use CompareOp::*;
    use ValueRef::*;

    // Same variable, same value: == vs != are exclusive
    if values_equal(v1, v2) {
        match (op1, op2) {
            (Eq, Ne) | (Ne, Eq) => return true,
            _ => {}
        }
    }

    // Numeric range exclusion
    if let (Number(n1), Number(n2)) = (v1, v2) {
        match (op1, op2) {
            // x < A vs x >= A (complementary)
            (Lt, Ge) | (Ge, Lt) => *n1 <= *n2,
            // x <= A vs x > A (complementary)
            (Le, Gt) | (Gt, Le) => *n1 <= *n2,
            // x <= A vs x >= B where ranges don't overlap
            (Le, Ge) | (Ge, Le) => *n1 < *n2,
            // x < A vs x <= B where A <= B (non-overlapping at integer boundaries)
            (Lt, Le) | (Le, Lt) => *n1 < *n2,
            _ => false,
        }
    } else if let (Integer(n1), Integer(n2)) = (v1, v2) {
        match (op1, op2) {
            // x < A vs x >= A (complementary)
            (Lt, Ge) | (Ge, Lt) => *n1 <= *n2,
            // x <= A vs x > A (complementary)
            (Le, Gt) | (Gt, Le) => *n1 <= *n2,
            // x <= A vs x >= B where ranges don't overlap
            (Le, Ge) | (Ge, Le) => *n1 < *n2,
            // x < A vs x <= B where A <= B (non-overlapping)
            (Lt, Le) | (Le, Lt) => *n1 < *n2,
            _ => false,
        }
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::parser::parse_orca_md;

    #[test]
    fn test_verify_valid_machine() {
        let md = r#"# machine Toggle
## state off [initial]
## state on
## transitions
| Source | Event  | Guard | Target | Action |
|--------|--------|-------|--------|--------|
| off    | toggle |       | on     |        |
| on     | toggle |       | off    |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_verify_no_initial_state() {
        let md = r#"# machine Bad
## state a
## state b
"#;
        let machine = parse_orca_md(md).unwrap();
        let result = verify(&machine);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, VerifyCode::NoInitialState);
    }

    #[test]
    fn test_verify_invalid_target() {
        let md = r#"# machine Bad
## state a [initial]
## transitions
| Source | Event | Guard | Target  | Action |
|--------|-------|-------|---------|--------|
| a      | go    |       | missing |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let result = verify(&machine);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, VerifyCode::InvalidTransitionTarget);
    }

    #[test]
    fn test_verify_unreachable_state() {
        let md = r#"# machine WithUnreachable
## state start [initial]
## state reachable
## state orphan
## transitions
| Source   | Event | Guard | Target    | Action |
|----------|-------|-------|-----------|--------|
| start    | go    |       | reachable |        |
| reachable| back  |       | start     |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        let unreachable: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::UnreachableState)
            .collect();
        assert_eq!(unreachable.len(), 1);
        assert!(unreachable[0].message.contains("orphan"));
    }

    #[test]
    fn test_verify_deadlock() {
        let md = r#"# machine WithDeadlock
## state start [initial]
## state stuck
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start  | go    |       | stuck  |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        let deadlocks: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::Deadlock)
            .collect();
        assert_eq!(deadlocks.len(), 1);
        assert!(deadlocks[0].message.contains("stuck"));
    }

    #[test]
    fn test_verify_non_deterministic_multiple_unguarded() {
        // Multiple unguarded transitions for same state+event → NonDeterministic warning
        let md = r#"# machine Bad
## state start [initial]
## state a
## state b
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start  | go    |       | a      |        |
| start  | go    |       | b      |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        let nondet: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::NonDeterministic)
            .collect();
        assert_eq!(nondet.len(), 1);
        assert!(nondet[0].message.contains("multiple unguarded"));
    }

    #[test]
    fn test_verify_guard_exhaustiveness_incomplete() {
        // Guards that don't cover all cases (score < 50 and score <= 50 overlap at 50)
        // → not mutually exclusive, score == 50 not covered → GuardExhaustiveness warning
        let md = r#"# machine BadGuards
## context
| Field | Type | Default |
|-------|------|---------|
| score | int  | 0       |

## guards
| Name | Expression |
|------|------------|
| low  | score < 50 |
| mid  | score <= 50 |

## state start [initial]
## state done
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start  | eval  | low   | done   |        |
| start  | eval  | mid   | done   |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        let exh: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::GuardExhaustiveness)
            .collect();
        // score == 50 is covered by both (not exclusive), and together they don't
        // cover score > 50, so not exhaustive
        assert_eq!(exh.len(), 1);
        assert!(exh[0].message.contains("may not be exhaustive"));
    }

    #[test]
    fn test_verify_guard_exhaustiveness_complete() {
        // Guards that ARE mutually exclusive and exhaustive → no warning
        let md = r#"# machine GoodGuards
## context
| Field | Type | Default |
|-------|------|---------|
| score | int  | 0       |

## guards
| Name | Expression |
|------|------------|
| low  | score < 50  |
| high | score >= 50  |

## state start [initial]
## state done
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start  | eval  | low   | done   |        |
| start  | eval  | high  | done   |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        let warnings = verify(&machine).unwrap();
        let exh: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::GuardExhaustiveness)
            .collect();
        assert!(exh.is_empty(), "guards < 50 and >= 50 are exhaustive, expected no warning");
    }

    #[test]
    fn test_verify_reachability_skips_statically_false_guard() {
        // A statically-false guard (not true) makes that transition unreachable
        let md = r#"# machine GuardReach
## guards
| Name | Expression |
|------|------------|
| bad  | not true   |

## state start [initial]
## state target
## state orphan
## transitions
| Source | Event | Guard | Target  | Action |
|--------|-------|-------|---------|--------|
| start | go    |       | target  |        |
| start | skip  | bad   | orphan  |        |
"#;
        let machine = parse_orca_md(md).unwrap();
        eprintln!("all guards = {:?}", machine.guards);
        let bad_guard = machine.guards.get("bad");
        eprintln!("bad_guard = {:?}", bad_guard);
        if let Some(g) = bad_guard {
            eprintln!("is_statically_false(bad) = {}", is_statically_false(g));
        }
        let warnings = verify(&machine).unwrap();
        eprintln!("all warnings = {:?}", warnings);
        let orphan_warnings: Vec<_> = warnings
            .iter()
            .filter(|w| w.code == VerifyCode::UnreachableState)
            .collect();
        // 'orphan' should be unreachable because 'bad' guard is always false
        assert_eq!(orphan_warnings.len(), 1, "expected orphan unreachable warning, got: {:?}", warnings);
        assert!(orphan_warnings[0].message.contains("orphan"));
    }
}
