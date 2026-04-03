use std::collections::HashMap;
use serde_json::Value;
use super::types::*;

// -- Phase 1: Markdown structure parsing --

#[derive(Debug, Clone)]
enum MdElement {
    Heading { level: u8, text: String },
    Table { headers: Vec<String>, rows: Vec<Vec<String>> },
    BulletList { items: Vec<String> },
    Blockquote { text: String },
    Separator,
}

fn parse_markdown_structure(source: &str) -> Vec<MdElement> {
    let mut elements = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;
    let mut in_code_block = false;

    while i < lines.len() {
        let line = lines[i];

        // Toggle code blocks
        if line.trim_start().starts_with("```") {
            in_code_block = !in_code_block;
            i += 1;
            continue;
        }
        if in_code_block {
            i += 1;
            continue;
        }

        let trimmed = line.trim();

        // Skip empty lines
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Separator: ---
        if trimmed.starts_with("---") && trimmed.chars().all(|c| c == '-') {
            elements.push(MdElement::Separator);
            i += 1;
            continue;
        }

        // Heading: # ... or ## ... etc
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|&c| c == '#').count() as u8;
            let text = trimmed[level as usize..].trim().to_string();
            elements.push(MdElement::Heading { level, text });
            i += 1;
            continue;
        }

        // Blockquote: >
        if trimmed.starts_with('>') {
            let text = trimmed[1..].trim().to_string();
            elements.push(MdElement::Blockquote { text });
            i += 1;
            continue;
        }

        // Table: |
        if trimmed.starts_with('|') {
            let mut table_rows: Vec<Vec<String>> = Vec::new();
            while i < lines.len() {
                let tl = lines[i].trim();
                if !tl.starts_with('|') {
                    break;
                }
                // Skip separator rows (|---|---|)
                if is_table_separator(tl) {
                    i += 1;
                    continue;
                }
                let cells: Vec<String> = tl
                    .split('|')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.trim().to_string())
                    .collect();
                table_rows.push(cells);
                i += 1;
            }
            if !table_rows.is_empty() {
                let headers = table_rows.remove(0);
                elements.push(MdElement::Table {
                    headers,
                    rows: table_rows,
                });
            }
            continue;
        }

        // Bullet list: - item
        if trimmed.starts_with("- ") {
            let mut items = Vec::new();
            while i < lines.len() {
                let bl = lines[i].trim();
                if bl.starts_with("- ") {
                    items.push(bl[2..].trim().to_string());
                } else {
                    break;
                }
                i += 1;
            }
            elements.push(MdElement::BulletList { items });
            continue;
        }

        // Skip other lines
        i += 1;
    }

    elements
}

fn is_table_separator(line: &str) -> bool {
    let stripped = line.replace('|', "").replace('-', "").replace(':', "").replace(' ', "");
    stripped.is_empty()
}

// -- Phase 2: Build MachineDef from elements --

pub fn parse_orca_md(source: &str) -> Result<MachineDef, ParseError> {
    let elements = parse_markdown_structure(source);
    parse_machine_from_elements(&elements)
}

fn parse_machine_from_elements(elements: &[MdElement]) -> Result<MachineDef, ParseError> {
    let mut name = String::new();
    let mut context = serde_json::Map::new();
    let mut events = Vec::new();
    let mut states = Vec::new();
    let mut transitions = Vec::new();
    let mut guards: HashMap<String, GuardExpression> = HashMap::new();
    let mut actions = Vec::new();

    let mut current_section: Option<String> = None;

    for element in elements {
        match element {
            MdElement::Heading { level: 1, text } => {
                // # machine Name
                let t = text.trim();
                if let Some(n) = t.strip_prefix("machine ") {
                    name = n.trim().to_string();
                } else {
                    name = t.to_string();
                }
                current_section = None;
            }
            MdElement::Heading { level: 2, text } => {
                let t = text.trim();

                // ## state Name [initial] [final]
                if t.starts_with("state ") {
                    let rest = &t[6..];
                    let (state_name, is_initial, is_final) = parse_state_annotation(rest);
                    states.push(StateDef {
                        name: state_name,
                        is_initial,
                        is_final,
                        description: None,
                        on_entry: None,
                        on_exit: None,
                    });
                    current_section = Some("state".to_string());
                } else {
                    current_section = Some(t.to_lowercase());
                }
            }
            MdElement::Blockquote { text } => {
                // Description for last state
                if current_section.as_deref() == Some("state") {
                    if let Some(state) = states.last_mut() {
                        state.description = Some(text.clone());
                    }
                }
            }
            MdElement::BulletList { items } => {
                match current_section.as_deref() {
                    Some("events") => {
                        for item in items {
                            // Events can be comma-separated
                            for e in item.split(',') {
                                let ev = e.trim().to_string();
                                if !ev.is_empty() {
                                    events.push(ev);
                                }
                            }
                        }
                    }
                    Some("state") => {
                        // State properties: on_entry:, on_exit:
                        if let Some(state) = states.last_mut() {
                            for item in items {
                                let item_trimmed = item.trim();
                                if let Some(v) = item_trimmed.strip_prefix("on_entry:") {
                                    state.on_entry = Some(v.trim().to_string());
                                } else if let Some(v) = item_trimmed.strip_prefix("on_exit:") {
                                    state.on_exit = Some(v.trim().to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            MdElement::Table { headers, rows } => {
                match current_section.as_deref() {
                    Some("context") => {
                        parse_context_table(&headers, &rows, &mut context);
                    }
                    Some("transitions") => {
                        parse_transitions_table(&headers, &rows, &mut transitions, &mut guards);
                    }
                    Some("guards") => {
                        parse_guards_table(&headers, &rows, &mut guards);
                    }
                    Some("actions") => {
                        parse_actions_table(&headers, &rows, &mut actions);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if name.is_empty() {
        return Err(ParseError {
            message: "No machine name found (expected '# machine Name')".to_string(),
        });
    }

    Ok(MachineDef {
        name,
        context: Value::Object(context),
        events,
        states,
        transitions,
        guards,
        actions,
    })
}

fn parse_state_annotation(s: &str) -> (String, bool, bool) {
    let mut name = String::new();
    let mut is_initial = false;
    let mut is_final = false;

    for part in s.split_whitespace() {
        match part {
            "[initial]" => is_initial = true,
            "[final]" => is_final = true,
            _ => {
                if name.is_empty() {
                    name = part.to_string();
                }
            }
        }
    }

    (name, is_initial, is_final)
}

fn parse_context_table(
    headers: &[String],
    rows: &[Vec<String>],
    context: &mut serde_json::Map<String, Value>,
) {
    // Find column indices
    let name_idx = find_column(headers, &["name", "field"]);
    let default_idx = find_column(headers, &["default"]);

    for row in rows {
        let field_name = row.get(name_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if field_name.is_empty() {
            continue;
        }
        let default_str = row.get(default_idx).map(|s| s.trim()).unwrap_or("");
        let value = parse_default_value(default_str);
        context.insert(field_name, value);
    }
}

fn parse_default_value(s: &str) -> Value {
    let s = s.trim();
    if s.is_empty() {
        return Value::Null;
    }
    match s {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => {
            // Try integer
            if let Ok(i) = s.parse::<i64>() {
                return Value::Number(serde_json::Number::from(i));
            }
            // Try float
            if let Ok(f) = s.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return Value::Number(n);
                }
            }
            // Strip quotes if present
            if (s.starts_with('"') && s.ends_with('"'))
                || (s.starts_with('\'') && s.ends_with('\''))
            {
                return Value::String(s[1..s.len() - 1].to_string());
            }
            Value::String(s.to_string())
        }
    }
}

fn parse_transitions_table(
    headers: &[String],
    rows: &[Vec<String>],
    transitions: &mut Vec<Transition>,
    guards: &mut HashMap<String, GuardExpression>,
) {
    let source_idx = find_column(headers, &["source"]);
    let event_idx = find_column(headers, &["event"]);
    let guard_idx = find_column(headers, &["guard"]);
    let target_idx = find_column(headers, &["target"]);
    let action_idx = find_column(headers, &["action"]);

    for row in rows {
        let source = cell_str(row, source_idx);
        let event = cell_str(row, event_idx);
        let guard_str = cell_str(row, guard_idx);
        let target = cell_str(row, target_idx);
        let action = cell_str(row, action_idx);

        if source.is_empty() || event.is_empty() || target.is_empty() {
            continue;
        }

        let guard = if guard_str.is_empty() {
            None
        } else {
            // Auto-register inline guard expression
            let expr = parse_guard_expression(&guard_str);
            guards.insert(guard_str.clone(), expr);
            Some(guard_str)
        };

        let action = if action.is_empty() { None } else { Some(action) };

        transitions.push(Transition {
            source,
            event,
            guard,
            target,
            action,
        });
    }
}

fn parse_guards_table(
    headers: &[String],
    rows: &[Vec<String>],
    guards: &mut HashMap<String, GuardExpression>,
) {
    let name_idx = find_column(headers, &["name"]);
    let expr_idx = find_column(headers, &["expression", "condition"]);

    for row in rows {
        let name = cell_str(row, name_idx);
        let expr_str = cell_str(row, expr_idx);
        if name.is_empty() || expr_str.is_empty() {
            continue;
        }
        let expr = parse_guard_expression(&expr_str);
        guards.insert(name, expr);
    }
}

fn parse_actions_table(
    headers: &[String],
    rows: &[Vec<String>],
    actions: &mut Vec<ActionSignature>,
) {
    let name_idx = find_column(headers, &["name"]);
    let sig_idx = find_column(headers, &["signature"]);

    for row in rows {
        let name = cell_str(row, name_idx);
        let sig = cell_str(row, sig_idx);
        if name.is_empty() {
            continue;
        }
        actions.push(ActionSignature {
            name,
            signature: sig,
        });
    }
}

// -- Guard expression parser --

pub fn parse_guard_expression(s: &str) -> GuardExpression {
    let s = s.trim();

    if s.is_empty() || s == "true" || s == "else" {
        return GuardExpression::True;
    }
    if s == "false" {
        return GuardExpression::False;
    }

    // Try to parse as a compound expression with and/or
    // Split by " and " or " or " at the top level
    if let Some(expr) = try_parse_binary_logic(s) {
        return expr;
    }

    // Handle "not <expr>"
    if let Some(rest) = s.strip_prefix("not ") {
        let inner = parse_guard_expression(rest.trim());
        return GuardExpression::Not(Box::new(inner));
    }
    if let Some(rest) = s.strip_prefix('!') {
        let inner = parse_guard_expression(rest.trim());
        return GuardExpression::Not(Box::new(inner));
    }

    // Try comparison: <variable> <op> <value>
    if let Some(expr) = try_parse_comparison(s) {
        return expr;
    }

    // Null checks: <variable> is null / <variable> is not null
    if let Some(expr) = try_parse_nullcheck(s) {
        return expr;
    }

    // Fallback: treat as true (unknown guard)
    GuardExpression::True
}

fn try_parse_binary_logic(s: &str) -> Option<GuardExpression> {
    // Find " and " or " or " outside parentheses (simple: no paren handling for v1)
    if let Some(idx) = find_logic_op(s, " and ") {
        let left = parse_guard_expression(&s[..idx]);
        let right = parse_guard_expression(&s[idx + 5..]);
        return Some(GuardExpression::And(Box::new(left), Box::new(right)));
    }
    if let Some(idx) = find_logic_op(s, " or ") {
        let left = parse_guard_expression(&s[..idx]);
        let right = parse_guard_expression(&s[idx + 4..]);
        return Some(GuardExpression::Or(Box::new(left), Box::new(right)));
    }
    None
}

fn find_logic_op(s: &str, op: &str) -> Option<usize> {
    s.find(op)
}

fn try_parse_comparison(s: &str) -> Option<GuardExpression> {
    // Operators ordered by length (longest first to avoid partial matches)
    let operators = [
        ("==", CompareOp::Eq),
        ("!=", CompareOp::Ne),
        (">=", CompareOp::Ge),
        ("<=", CompareOp::Le),
        (">", CompareOp::Gt),
        ("<", CompareOp::Lt),
    ];

    for (op_str, op) in &operators {
        if let Some(idx) = s.find(op_str) {
            let left_str = s[..idx].trim();
            let right_str = s[idx + op_str.len()..].trim();

            let left = parse_variable_ref(left_str);
            let right = parse_value_ref(right_str);

            return Some(GuardExpression::Compare {
                op: *op,
                left,
                right,
            });
        }
    }

    None
}

fn try_parse_nullcheck(s: &str) -> Option<GuardExpression> {
    if let Some(idx) = s.find(" is not null") {
        let var_str = s[..idx].trim();
        let var = parse_variable_ref(var_str);
        return Some(GuardExpression::Nullcheck {
            expr: var,
            is_null: false,
        });
    }
    if let Some(idx) = s.find(" is null") {
        let var_str = s[..idx].trim();
        let var = parse_variable_ref(var_str);
        return Some(GuardExpression::Nullcheck {
            expr: var,
            is_null: true,
        });
    }
    None
}

fn parse_variable_ref(s: &str) -> VariableRef {
    let parts: Vec<String> = s
        .split('.')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && p != "ctx" && p != "context")
        .collect();
    VariableRef { path: parts }
}

fn parse_value_ref(s: &str) -> ValueRef {
    let s = s.trim();
    if s == "null" {
        return ValueRef::Null;
    }
    if s == "true" {
        return ValueRef::Boolean(true);
    }
    if s == "false" {
        return ValueRef::Boolean(false);
    }
    // Quoted string
    if (s.starts_with('"') && s.ends_with('"'))
        || (s.starts_with('\'') && s.ends_with('\''))
    {
        return ValueRef::Str(s[1..s.len() - 1].to_string());
    }
    // Integer
    if let Ok(i) = s.parse::<i64>() {
        return ValueRef::Integer(i);
    }
    // Float
    if let Ok(f) = s.parse::<f64>() {
        return ValueRef::Number(f);
    }
    // Unquoted string
    ValueRef::Str(s.to_string())
}

// -- Helpers --

fn find_column(headers: &[String], names: &[&str]) -> usize {
    for (i, h) in headers.iter().enumerate() {
        let lower = h.to_lowercase();
        for name in names {
            if lower == *name {
                return i;
            }
        }
    }
    // Default to positional fallback
    0
}

fn cell_str(row: &[String], idx: usize) -> String {
    row.get(idx)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOGGLE_MD: &str = r#"# machine Toggle

## state off [initial]
> The machine is off

## state on
> The machine is on

## events
- toggle

## transitions
| Source | Event  | Guard | Target | Action    |
|--------|--------|-------|--------|-----------|
| off    | toggle |       | on     | increment |
| on     | toggle |       | off    | increment |

## actions
| Name      | Signature           |
|-----------|---------------------|
| increment | `(ctx) -> Context` |
"#;

    #[test]
    fn test_parse_simple_toggle() {
        let machine = parse_orca_md(TOGGLE_MD).unwrap();
        assert_eq!(machine.name, "Toggle");
        assert_eq!(machine.states.len(), 2);
        assert_eq!(machine.events.len(), 1);
        assert_eq!(machine.events[0], "toggle");
        assert_eq!(machine.transitions.len(), 2);
        assert!(machine.states[0].is_initial);
        assert_eq!(machine.states[0].name, "off");
        assert_eq!(machine.states[1].name, "on");
        assert_eq!(machine.actions.len(), 1);
        assert_eq!(machine.actions[0].name, "increment");
    }

    #[test]
    fn test_parse_context_defaults() {
        let md = r#"# machine WithContext

## context
| Field     | Type   | Default |
|-----------|--------|---------|
| count     | int    | 42      |
| price     | float  | 10.5    |
| name      | string | hello   |
| active    | bool   | true    |

## state idle [initial]
"#;
        let machine = parse_orca_md(md).unwrap();
        let ctx = machine.context.as_object().unwrap();
        assert_eq!(ctx["count"], 42);
        assert_eq!(ctx["price"], 10.5);
        assert_eq!(ctx["name"], "hello");
        assert_eq!(ctx["active"], true);
    }

    #[test]
    fn test_parse_inline_guards() {
        let md = r#"# machine Producer

## state active [initial]

## transitions
| Source  | Event        | Guard        | Target  | Action      |
|---------|--------------|--------------|---------|-------------|
| active  | tick         |              | active  | produce     |
| active  | price_signal | price > 15.0 | active  | cut_price   |
| active  | price_signal | price < 5.0  | active  | raise_price |

## actions
| Name        | Signature           |
|-------------|---------------------|
| produce     | `(ctx) -> Context` |
| cut_price   | `(ctx) -> Context` |
| raise_price | `(ctx) -> Context` |
"#;
        let machine = parse_orca_md(md).unwrap();
        assert_eq!(machine.transitions.len(), 3);
        assert!(machine.transitions[0].guard.is_none());
        assert_eq!(
            machine.transitions[1].guard.as_deref(),
            Some("price > 15.0")
        );
        assert_eq!(
            machine.transitions[2].guard.as_deref(),
            Some("price < 5.0")
        );
        // Guards auto-registered
        assert!(machine.guards.contains_key("price > 15.0"));
        assert!(machine.guards.contains_key("price < 5.0"));
    }

    #[test]
    fn test_parse_guard_expression_compare() {
        let expr = parse_guard_expression("price > 15.0");
        match expr {
            GuardExpression::Compare { op, left, right } => {
                assert_eq!(op, CompareOp::Gt);
                assert_eq!(left.path, vec!["price"]);
                assert_eq!(right, ValueRef::Number(15.0));
            }
            _ => panic!("Expected Compare, got {:?}", expr),
        }
    }

    #[test]
    fn test_parse_guard_expression_else() {
        let expr = parse_guard_expression("else");
        assert_eq!(expr, GuardExpression::True);
    }

    #[test]
    fn test_parse_guard_expression_and() {
        let expr = parse_guard_expression("price >= 8.0 and price <= 12.0");
        match expr {
            GuardExpression::And(left, right) => {
                match *left {
                    GuardExpression::Compare { op, .. } => assert_eq!(op, CompareOp::Ge),
                    _ => panic!("Expected Compare"),
                }
                match *right {
                    GuardExpression::Compare { op, .. } => assert_eq!(op, CompareOp::Le),
                    _ => panic!("Expected Compare"),
                }
            }
            _ => panic!("Expected And, got {:?}", expr),
        }
    }

    #[test]
    fn test_parse_guard_nullcheck() {
        let expr = parse_guard_expression("ctx.result is null");
        match expr {
            GuardExpression::Nullcheck { expr: var, is_null } => {
                assert_eq!(var.path, vec!["result"]);
                assert!(is_null);
            }
            _ => panic!("Expected Nullcheck, got {:?}", expr),
        }
    }

    #[test]
    fn test_parse_state_description() {
        let md = r#"# machine Test

## state idle [initial]
> Waiting for input

## state done [final]
> All done
"#;
        let machine = parse_orca_md(md).unwrap();
        assert_eq!(
            machine.states[0].description.as_deref(),
            Some("Waiting for input")
        );
        assert_eq!(
            machine.states[1].description.as_deref(),
            Some("All done")
        );
        assert!(machine.states[1].is_final);
    }

    #[test]
    fn test_parse_on_entry_exit() {
        let md = r#"# machine Test

## state idle [initial]
- on_entry: setup
- on_exit: teardown
"#;
        let machine = parse_orca_md(md).unwrap();
        assert_eq!(machine.states[0].on_entry.as_deref(), Some("setup"));
        assert_eq!(machine.states[0].on_exit.as_deref(), Some("teardown"));
    }
}
