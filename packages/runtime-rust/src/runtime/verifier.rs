use std::collections::{HashSet, VecDeque};
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

    // 3. Reachability from initial state (BFS)
    let initial_name = &initial_states[0].name;
    let mut reachable: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(initial_name.as_str());
    reachable.insert(initial_name.as_str());

    while let Some(current) = queue.pop_front() {
        for t in &def.transitions {
            if t.source == current && !reachable.contains(t.target.as_str()) {
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

    // 4. Deadlock detection: non-final state with no outgoing transitions
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
}
