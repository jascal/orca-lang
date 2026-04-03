use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use serde_json::Value;
use super::types::*;

/// C-compatible action callback type
pub type ActionCallback = unsafe extern "C" fn(
    context_json: *const c_char,
    event_json: *const c_char,
) -> *const c_char;

/// Internal Rust action handler (for testing without FFI)
pub type RustActionHandler = Box<dyn Fn(&Value, &Value) -> Value>;

/// Action handler that can be either a C callback or a Rust closure
enum ActionHandler {
    C(ActionCallback),
    Rust(RustActionHandler),
}

/// Orca state machine executor
pub struct OrcaMachine {
    definition: MachineDef,
    context: Value,
    state: String,
    active: bool,
    action_handlers: HashMap<String, ActionHandler>,
}

impl OrcaMachine {
    /// Create a new machine from a definition.
    /// Does NOT start the machine — call start() after registering actions.
    pub fn new(definition: MachineDef) -> Result<Self, OrcaError> {
        // Find initial state
        let initial = definition
            .states
            .iter()
            .find(|s| s.is_initial)
            .ok_or_else(|| OrcaError {
                message: "No initial state found".to_string(),
            })?;

        let state = initial.name.clone();

        // Clone context from definition
        let context = definition.context.clone();

        Ok(Self {
            definition,
            context,
            state,
            active: false,
            action_handlers: HashMap::new(),
        })
    }

    /// Start the machine: set active, run on_entry for initial state.
    pub fn start(&mut self) -> Result<(), OrcaError> {
        self.active = true;

        // Execute on_entry for initial state
        let initial_state = self.state.clone();
        if let Some(action_name) = self.find_on_entry(&initial_state) {
            self.execute_action(&action_name, &Value::Null)?;
        }

        Ok(())
    }

    /// Register a C function pointer as an action handler.
    pub fn register_action_c(&mut self, name: &str, callback: ActionCallback) {
        self.action_handlers
            .insert(name.to_string(), ActionHandler::C(callback));
    }

    /// Register a Rust closure as an action handler (for testing).
    pub fn register_action_rust(&mut self, name: &str, handler: RustActionHandler) {
        self.action_handlers
            .insert(name.to_string(), ActionHandler::Rust(handler));
    }

    /// Send an event to the machine. Synchronous — processes immediately.
    pub fn send(&mut self, event_json: &str) -> Result<(), OrcaError> {
        if !self.active {
            return Err(OrcaError {
                message: "Machine is not active".to_string(),
            });
        }

        // Parse event JSON
        let event: Value = serde_json::from_str(event_json).map_err(|e| OrcaError {
            message: format!("Invalid event JSON: {}", e),
        })?;

        let event_type = event
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OrcaError {
                message: "Event must have a 'type' field".to_string(),
            })?
            .to_string();

        // Find all matching transitions (same source + event)
        let candidates: Vec<&Transition> = self
            .definition
            .transitions
            .iter()
            .filter(|t| t.source == self.state && t.event == event_type)
            .collect();

        if candidates.is_empty() {
            // No transitions for this event in this state — ignore silently
            return Ok(());
        }

        // Find first transition whose guard passes
        let matched = candidates.iter().find(|t| {
            match &t.guard {
                None => true,
                Some(guard_name) => {
                    match self.definition.guards.get(guard_name) {
                        Some(expr) => self.evaluate_guard(expr),
                        None => true, // Unknown guard defaults to true
                    }
                }
            }
        });

        let transition = match matched {
            Some(t) => (*t).clone(),
            None => {
                // No guard matched — silently ignore
                return Ok(());
            }
        };

        // Execute the transition
        let old_state = self.state.clone();

        // 1. Execute on_exit for old state
        if let Some(action_name) = self.find_on_exit(&old_state) {
            self.execute_action(&action_name, &event)?;
        }

        // 2. Execute transition action
        if let Some(ref action_name) = transition.action {
            self.execute_action(action_name, &event)?;
        }

        // 3. Update state
        self.state = transition.target.clone();

        // 4. Execute on_entry for new state
        let new_state = self.state.clone();
        if let Some(action_name) = self.find_on_entry(&new_state) {
            self.execute_action(&action_name, &event)?;
        }

        // 5. Check if we reached a final state
        if self.is_final_state(&self.state) {
            self.active = false;
        }

        Ok(())
    }

    /// Get the current state name.
    pub fn state(&self) -> &str {
        &self.state
    }

    /// Get the current context.
    pub fn context(&self) -> &Value {
        &self.context
    }

    /// Whether the machine is active.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Set a context field (for testing).
    #[cfg(test)]
    pub fn set_context_field(&mut self, key: &str, value: serde_json::Value) {
        if let Value::Object(ref mut ctx) = self.context {
            ctx.insert(key.to_string(), value);
        }
    }

    /// Serialize current state + context to JSON.
    pub fn state_json(&self) -> String {
        let obj = serde_json::json!({
            "state": self.state,
            "context": self.context,
        });
        serde_json::to_string(&obj).unwrap_or_else(|_| "{}".to_string())
    }

    // -- Internal helpers --

    fn evaluate_guard(&self, expr: &GuardExpression) -> bool {
        match expr {
            GuardExpression::True => true,
            GuardExpression::False => false,
            GuardExpression::Not(inner) => !self.evaluate_guard(inner),
            GuardExpression::And(left, right) => {
                self.evaluate_guard(left) && self.evaluate_guard(right)
            }
            GuardExpression::Or(left, right) => {
                self.evaluate_guard(left) || self.evaluate_guard(right)
            }
            GuardExpression::Compare { op, left, right } => {
                let ctx_val = self.resolve_variable(&left.path);
                compare_values(ctx_val, right, *op)
            }
            GuardExpression::Nullcheck { expr: var, is_null } => {
                let val = self.resolve_variable(&var.path);
                let val_is_null = val.is_null();
                if *is_null { val_is_null } else { !val_is_null }
            }
        }
    }

    fn resolve_variable(&self, path: &[String]) -> &Value {
        let mut current = &self.context;
        for segment in path {
            match current.get(segment.as_str()) {
                Some(v) => current = v,
                None => return &Value::Null,
            }
        }
        current
    }

    fn execute_action(&mut self, action_name: &str, event: &Value) -> Result<(), OrcaError> {
        let handler = match self.action_handlers.get(action_name) {
            Some(h) => h,
            None => return Ok(()), // No handler registered — silently succeed
        };

        let result_value = match handler {
            ActionHandler::Rust(func) => func(&self.context, event),
            ActionHandler::C(callback) => {
                let ctx_str =
                    CString::new(serde_json::to_string(&self.context).unwrap_or_default())
                        .unwrap_or_default();
                let event_str =
                    CString::new(serde_json::to_string(event).unwrap_or_default())
                        .unwrap_or_default();

                let result_ptr =
                    unsafe { callback(ctx_str.as_ptr(), event_str.as_ptr()) };

                if result_ptr.is_null() {
                    return Ok(());
                }

                let result_cstr = unsafe { CStr::from_ptr(result_ptr) };
                let result_json = result_cstr.to_str().unwrap_or("{}");

                serde_json::from_str(result_json).unwrap_or(Value::Null)
            }
        };

        // Merge result into context (shallow merge of top-level keys)
        if let Value::Object(delta) = result_value {
            if let Value::Object(ref mut ctx) = self.context {
                for (k, v) in delta {
                    ctx.insert(k, v);
                }
            }
        }

        Ok(())
    }

    fn find_on_entry(&self, state_name: &str) -> Option<String> {
        self.definition
            .states
            .iter()
            .find(|s| s.name == state_name)
            .and_then(|s| s.on_entry.clone())
    }

    fn find_on_exit(&self, state_name: &str) -> Option<String> {
        self.definition
            .states
            .iter()
            .find(|s| s.name == state_name)
            .and_then(|s| s.on_exit.clone())
    }

    fn is_final_state(&self, state_name: &str) -> bool {
        self.definition
            .states
            .iter()
            .any(|s| s.name == state_name && s.is_final)
    }
}

fn compare_values(ctx_val: &Value, right: &ValueRef, op: CompareOp) -> bool {
    // Extract numeric value from context
    let ctx_num = value_as_f64(ctx_val);
    let right_num = value_ref_as_f64(right);

    // Numeric comparison if both sides are numbers
    if let (Some(l), Some(r)) = (ctx_num, right_num) {
        return match op {
            CompareOp::Eq => (l - r).abs() < f64::EPSILON,
            CompareOp::Ne => (l - r).abs() >= f64::EPSILON,
            CompareOp::Lt => l < r,
            CompareOp::Gt => l > r,
            CompareOp::Le => l <= r,
            CompareOp::Ge => l >= r,
        };
    }

    // String comparison
    let ctx_str = value_as_string(ctx_val);
    let right_str = value_ref_as_string(right);
    match op {
        CompareOp::Eq => ctx_str == right_str,
        CompareOp::Ne => ctx_str != right_str,
        CompareOp::Lt => ctx_str < right_str,
        CompareOp::Gt => ctx_str > right_str,
        CompareOp::Le => ctx_str <= right_str,
        CompareOp::Ge => ctx_str >= right_str,
    }
}

fn value_as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn value_ref_as_f64(v: &ValueRef) -> Option<f64> {
    match v {
        ValueRef::Number(f) => Some(*f),
        ValueRef::Integer(i) => Some(*i as f64),
        _ => None,
    }
}

fn value_as_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => String::new(),
    }
}

fn value_ref_as_string(v: &ValueRef) -> String {
    match v {
        ValueRef::Str(s) => s.clone(),
        ValueRef::Number(f) => f.to_string(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Boolean(b) => b.to_string(),
        ValueRef::Null => "null".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::parser::parse_orca_md;

    fn make_toggle() -> MachineDef {
        parse_orca_md(
            r#"# machine Toggle
## state off [initial]
## state on
## transitions
| Source | Event  | Guard | Target | Action    |
|--------|--------|-------|--------|-----------|
| off    | toggle |       | on     | increment |
| on     | toggle |       | off    | increment |
"#,
        )
        .unwrap()
    }

    #[test]
    fn test_initial_state() {
        let machine = OrcaMachine::new(make_toggle()).unwrap();
        assert_eq!(machine.state(), "off");
        assert!(!machine.is_active());
    }

    #[test]
    fn test_basic_transition() {
        let mut machine = OrcaMachine::new(make_toggle()).unwrap();
        machine.start().unwrap();
        assert!(machine.is_active());

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(machine.state(), "on");

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(machine.state(), "off");
    }

    #[test]
    fn test_guard_evaluation() {
        let md = r#"# machine Guarded
## context
| Field | Type  | Default |
|-------|-------|---------|
| price | float | 20.0    |

## state active [initial]

## transitions
| Source | Event  | Guard        | Target | Action    |
|--------|--------|--------------|--------|-----------|
| active | check  | price > 15.0 | active | cut_price |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.register_action_rust(
            "cut_price",
            Box::new(|ctx, _event| {
                let price = ctx.get("price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                serde_json::json!({"price": price - 1.0})
            }),
        );
        machine.start().unwrap();

        machine.send(r#"{"type":"check"}"#).unwrap();
        let price = machine.context().get("price").unwrap().as_f64().unwrap();
        assert!((price - 19.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_guard_fallthrough() {
        let md = r#"# machine Consumer
## context
| Field | Type  | Default |
|-------|-------|---------|
| price | float | 5.0     |
| goods | int   | 0       |
| cash  | float | 1000.0  |

## state active [initial]

## transitions
| Source | Event | Guard        | Target | Action |
|--------|-------|--------------|--------|--------|
| active | tick  | price < 8.0  | active | buy    |
| active | tick  | price > 12.0 | active | sell   |
| active | tick  | else         | active | hold   |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.register_action_rust(
            "buy",
            Box::new(|ctx, _| {
                let goods = ctx.get("goods").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"goods": goods + 1})
            }),
        );
        machine.register_action_rust("sell", Box::new(|_, _| serde_json::json!({})));
        machine.register_action_rust("hold", Box::new(|_, _| serde_json::json!({})));
        machine.start().unwrap();

        // price=5.0 < 8.0 → buy
        machine.send(r#"{"type":"tick"}"#).unwrap();
        assert_eq!(machine.context().get("goods").unwrap().as_i64().unwrap(), 1);
    }

    #[test]
    fn test_context_update() {
        let md = r#"# machine Counter
## context
| Field | Type | Default |
|-------|------|---------|
| count | int  | 0       |

## state running [initial]

## transitions
| Source  | Event | Guard | Target  | Action    |
|---------|-------|-------|---------|-----------|
| running | inc   |       | running | increment |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.register_action_rust(
            "increment",
            Box::new(|ctx, _| {
                let count = ctx.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"count": count + 1})
            }),
        );
        machine.start().unwrap();

        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        assert_eq!(
            machine.context().get("count").unwrap().as_i64().unwrap(),
            3
        );
    }

    #[test]
    fn test_final_state() {
        let md = r#"# machine Linear
## state start [initial]
## state end [final]
## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| start  | go    |       | end    |        |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.start().unwrap();
        assert!(machine.is_active());

        machine.send(r#"{"type":"go"}"#).unwrap();
        assert_eq!(machine.state(), "end");
        assert!(!machine.is_active());
    }

    #[test]
    fn test_state_json() {
        let md = r#"# machine Test
## context
| Field | Type | Default |
|-------|------|---------|
| x     | int  | 42      |
## state idle [initial]
"#;
        let def = parse_orca_md(md).unwrap();
        let machine = OrcaMachine::new(def).unwrap();
        let json: Value = serde_json::from_str(&machine.state_json()).unwrap();
        assert_eq!(json["state"], "idle");
        assert_eq!(json["context"]["x"], 42);
    }

    #[test]
    fn test_unknown_event_ignored() {
        let mut machine = OrcaMachine::new(make_toggle()).unwrap();
        machine.start().unwrap();
        // Sending an event with no matching transition should succeed silently
        machine.send(r#"{"type":"unknown_event"}"#).unwrap();
        assert_eq!(machine.state(), "off");
    }
}
