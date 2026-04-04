use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use serde_json::Value;
use super::types::*;
use super::logging::{LogSink, make_entry};
use super::effects::EffectRegistry;
use super::persistence::Snapshot;

/// C-compatible action callback type
pub type ActionCallback = unsafe extern "C" fn(
    context_json: *const c_char,
    event_json: *const c_char,
) -> *const c_char;

/// Internal Rust action handler (for testing without FFI)
pub type RustActionHandler = Box<dyn Fn(&Value, &Value) -> Value>;

/// Callback invoked after every successful transition.
/// Arguments: (from_state, to_state, event)
pub type TransitionCallback = Box<dyn Fn(&str, &str, &str) -> ()>;

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
    transition_callback: Option<TransitionCallback>,
    log_sink: Option<Box<dyn LogSink>>,
    effect_registry: Option<EffectRegistry>,
    pub run_id: String,
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
            transition_callback: None,
            log_sink: None,
            effect_registry: None,
            run_id: String::new(),
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

    /// Register a callback that fires after every successful transition.
    pub fn on_transition(&mut self, callback: TransitionCallback) {
        self.transition_callback = Some(callback);
    }

    /// Set a log sink for audit logging of transitions.
    pub fn set_log_sink(&mut self, sink: Box<dyn LogSink>) {
        self.log_sink = Some(sink);
    }

    /// Set the run ID used in log entries.
    pub fn set_run_id(&mut self, id: String) {
        self.run_id = id;
    }

    /// Set the effect registry for handling side-effect actions.
    pub fn set_effect_registry(&mut self, registry: EffectRegistry) {
        self.effect_registry = Some(registry);
    }

    /// Get a mutable reference to the effect registry, creating it if absent.
    pub fn effect_registry_mut(&mut self) -> &mut EffectRegistry {
        self.effect_registry.get_or_insert_with(EffectRegistry::new)
    }

    /// Serialize the current machine state to a JSON string.
    pub fn snapshot(&self) -> Result<String, String> {
        let snap = Snapshot {
            definition: self.definition.clone(),
            state: self.state.clone(),
            context: self.context.clone(),
            run_id: self.run_id.clone(),
            active: self.active,
        };
        serde_json::to_string(&snap)
            .map_err(|e| format!("snapshot serialization failed: {}", e))
    }

    /// Restore machine state from a JSON snapshot string.
    pub fn restore(&mut self, json: &str) -> Result<(), String> {
        let snap: Snapshot = serde_json::from_str(json)
            .map_err(|e| format!("snapshot deserialize failed: {}", e))?;

        if snap.definition.name != self.definition.name {
            return Err(format!(
                "snapshot definition name '{}' does not match machine '{}'",
                snap.definition.name, self.definition.name
            ));
        }

        self.state = snap.state;
        self.context = snap.context;
        self.run_id = snap.run_id;
        self.active = snap.active;

        Ok(())
    }

    /// Resume the machine from a snapshot, cold-starting without re-running
    /// on_entry actions. Use this instead of start() when resuming a crashed
    /// run from a saved checkpoint.
    ///
    /// Unlike restore() (a live-machine primitive), resume() is the cold-start
    /// path: the machine was inactive, a snapshot was found on disk, and we
    /// want to continue from where we left off without re-executing the actions
    /// that already ran before the crash.
    pub fn resume(&mut self, snap: &Snapshot) -> Result<(), String> {
        if self.active {
            return Err("machine is already active".to_string());
        }

        if snap.definition.name != self.definition.name {
            return Err(format!(
                "snapshot definition name '{}' does not match machine '{}'",
                snap.definition.name, self.definition.name
            ));
        }

        self.state = snap.state.clone();
        self.context = snap.context.clone();
        self.run_id = snap.run_id.clone();
        self.active = snap.active;

        Ok(())
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

        // Check if the event is ignored for the current state
        if self.is_event_ignored(&event_type) {
            return Ok(());
        }

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

        // Snapshot context before transition (for computing delta)
        let ctx_before = self.context.clone();

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

        // 3a. Fire transition callback
        if let Some(ref callback) = self.transition_callback {
            callback(&old_state, &self.state, &event_type);
        }

        // 4. Execute on_entry for new state
        let new_state = self.state.clone();
        if let Some(action_name) = self.find_on_entry(&new_state) {
            self.execute_action(&action_name, &event)?;
        }

        // 5. Check if we reached a final state
        if self.is_final_state(&self.state) {
            self.active = false;
        }

        // 6. Log the transition (don't fail the transition on log errors)
        if let Some(ref mut sink) = self.log_sink {
            let context_delta = compute_context_delta(&ctx_before, &self.context);
            let entry = make_entry(
                &self.run_id,
                &self.definition.name,
                &event_type,
                &old_state,
                &self.state,
                context_delta,
            );
            let _ = sink.write(&entry);
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

    fn is_event_ignored(&self, event: &str) -> bool {
        if let Some(state_def) = self.definition.states.iter().find(|s| s.name == self.state) {
            if state_def.ignored_events.iter().any(|e| e == event || e == "*") {
                return true;
            }
        }
        false
    }

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
        // Check effect registry first — registered effects take precedence
        if let Some(ref registry) = self.effect_registry {
            if registry.has_effect(action_name) {
                // Pass event + current context so effect handlers can read state
                let payload = serde_json::json!({
                    "event": event,
                    "context": self.context,
                });
                match registry.invoke(action_name, &payload) {
                    Ok(result_value) => {
                        // Merge result into context (shallow merge of top-level keys)
                        if let Value::Object(delta) = result_value {
                            if let Value::Object(ref mut ctx) = self.context {
                                for (k, v) in delta {
                                    ctx.insert(k, v);
                                }
                            }
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        return Err(OrcaError {
                            message: format!("effect '{}' failed: {}", action_name, e),
                        });
                    }
                }
            }
        }

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

/// Compute the context delta: keys whose values changed between before and after.
fn compute_context_delta(before: &Value, after: &Value) -> HashMap<String, Value> {
    let mut delta = HashMap::new();
    if let (Value::Object(b), Value::Object(a)) = (before, after) {
        for (key, new_val) in a {
            match b.get(key) {
                Some(old_val) if old_val == new_val => {} // unchanged
                _ => {
                    delta.insert(key.clone(), new_val.clone());
                }
            }
        }
    }
    delta
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
    use crate::runtime::logging::{LogEntry, LogSink};

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

    // -- Ignored events tests --

    #[test]
    fn test_ignored_event_single() {
        let md = r#"# machine IgnoreTest
## state idle [initial]
- ignore: toggle

## state done [final]

## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle   | toggle |      | done   |        |
| idle   | go     |      | done   |        |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.start().unwrap();

        // toggle is ignored — should NOT transition
        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(machine.state(), "idle");

        // go is NOT ignored — should transition
        machine.send(r#"{"type":"go"}"#).unwrap();
        assert_eq!(machine.state(), "done");
    }

    #[test]
    fn test_ignored_event_wildcard() {
        let md = r#"# machine WildcardIgnore
## state idle [initial]
- ignore: *

## state done [final]

## transitions
| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle   | toggle |      | done   |        |
| idle   | go     |      | done   |        |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.start().unwrap();

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(machine.state(), "idle");

        machine.send(r#"{"type":"go"}"#).unwrap();
        assert_eq!(machine.state(), "idle");
    }

    #[test]
    fn test_ignored_event_still_allows_other_events() {
        let md = r#"# machine SelectiveIgnore
## state idle [initial]
- ignore: toggle, reset

## state done [final]

## transitions
| Source | Event  | Guard | Target | Action |
|--------|--------|-------|--------|--------|
| idle   | toggle |       | done   |        |
| idle   | reset  |       | done   |        |
| idle   | go     |       | done   |        |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.start().unwrap();

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(machine.state(), "idle");
        machine.send(r#"{"type":"reset"}"#).unwrap();
        assert_eq!(machine.state(), "idle");

        machine.send(r#"{"type":"go"}"#).unwrap();
        assert_eq!(machine.state(), "done");
    }

    // -- Transition callback tests --

    #[test]
    fn test_transition_callback_fires() {
        use std::sync::{Arc, Mutex};

        let mut machine = OrcaMachine::new(make_toggle()).unwrap();
        let log: Arc<Mutex<Vec<(String, String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let log_clone = log.clone();

        machine.on_transition(Box::new(move |from, to, event| {
            log_clone.lock().unwrap().push((
                from.to_string(),
                to.to_string(),
                event.to_string(),
            ));
        }));
        machine.start().unwrap();

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        machine.send(r#"{"type":"toggle"}"#).unwrap();

        let entries = log.lock().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], ("off".to_string(), "on".to_string(), "toggle".to_string()));
        assert_eq!(entries[1], ("on".to_string(), "off".to_string(), "toggle".to_string()));
    }

    #[test]
    fn test_transition_callback_not_called_on_ignored() {
        use std::sync::{Arc, Mutex};

        let md = r#"# machine IgnoreCb
## state idle [initial]
- ignore: toggle

## state done [final]

## transitions
| Source | Event  | Guard | Target | Action |
|--------|--------|-------|--------|--------|
| idle   | toggle |       | done   |        |
| idle   | go     |       | done   |        |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        let log: Arc<Mutex<Vec<(String, String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let log_clone = log.clone();

        machine.on_transition(Box::new(move |from, to, event| {
            log_clone.lock().unwrap().push((
                from.to_string(),
                to.to_string(),
                event.to_string(),
            ));
        }));
        machine.start().unwrap();

        machine.send(r#"{"type":"toggle"}"#).unwrap();
        assert_eq!(log.lock().unwrap().len(), 0);

        machine.send(r#"{"type":"go"}"#).unwrap();
        let entries = log.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], ("idle".to_string(), "done".to_string(), "go".to_string()));
    }

    // -- Logging tests --

    use std::sync::{Arc, Mutex};

    struct CollectorSink {
        entries: Arc<Mutex<Vec<LogEntry>>>,
    }

    impl CollectorSink {
        fn new() -> (Self, Arc<Mutex<Vec<LogEntry>>>) {
            let entries = Arc::new(Mutex::new(Vec::new()));
            (Self { entries: entries.clone() }, entries)
        }
    }

    impl LogSink for CollectorSink {
        fn write(&mut self, entry: &LogEntry) -> Result<(), std::io::Error> {
            self.entries.lock().unwrap().push(entry.clone());
            Ok(())
        }
        fn close(&mut self) -> Result<(), std::io::Error> {
            Ok(())
        }
    }

    unsafe impl Send for CollectorSink {}

    #[test]
    fn test_log_sink_fires_on_transition() {
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

        let (sink, entries) = CollectorSink::new();
        machine.set_log_sink(Box::new(sink));
        machine.set_run_id("test-run-42".to_string());
        machine.start().unwrap();

        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();

        let log = entries.lock().unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].run_id, "test-run-42");
        assert_eq!(log[0].machine, "Counter");
        assert_eq!(log[0].event, "inc");
        assert_eq!(log[0].from, "running");
        assert_eq!(log[0].to, "running");
        assert!(!log[0].ts.is_empty());
        assert!(log[0].context_delta.contains_key("count"));
        assert_eq!(log[0].context_delta["count"], serde_json::json!(1));
        assert_eq!(log[1].context_delta["count"], serde_json::json!(2));
        assert_eq!(log[2].context_delta["count"], serde_json::json!(3));
    }

    // -- Snapshot / Restore tests --

    #[test]
    fn test_snapshot_restore_roundtrip() {
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
        machine.set_run_id("run-42".to_string());
        machine.start().unwrap();

        // Advance to count=3
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();

        // Snapshot
        let json = machine.snapshot().unwrap();
        let snap: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snap.state, "running");
        assert_eq!(snap.context["count"], 3);
        assert_eq!(snap.run_id, "run-42");
        assert!(snap.active);

        // Create a new machine from the same definition
        let def2 = parse_orca_md(md).unwrap();
        let mut machine2 = OrcaMachine::new(def2).unwrap();
        machine2.register_action_rust(
            "increment",
            Box::new(|ctx, _| {
                let count = ctx.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"count": count + 1})
            }),
        );
        machine2.set_run_id("other-run".to_string());
        machine2.start().unwrap();

        // Restore
        machine2.restore(&json).unwrap();
        assert_eq!(machine2.state(), "running");
        assert_eq!(machine2.context["count"], 3);
        assert_eq!(machine2.run_id, "run-42");
        assert!(machine2.is_active());
    }

    #[test]
    fn test_resume_cold_boot() {
        // Test that resume() cold-starts without re-running on_entry actions.
        // We use a counter that increments on entry — if resume() accidentally
        // re-runs on_entry, the count will be higher than expected.
        let md = r#"# machine Counter
## context
| Field | Type | Default |
|-------|------|---------|
| count | int  | 0       |

## state running [initial]
- on_entry: increment

## transitions
| Source  | Event | Guard | Target  | Action    |
|---------|-------|-------|---------|-----------|
| running | inc   |       | running |           |
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
        machine.set_run_id("run-99".to_string());
        machine.start().unwrap();

        // on_entry runs once at start, count = 1
        assert_eq!(machine.context["count"], 1);

        // Advance counter to count=4
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        machine.send(r#"{"type":"inc"}"#).unwrap();
        assert_eq!(machine.context["count"], 4);

        // Snapshot and resume into a new machine
        let json = machine.snapshot().unwrap();
        let snap: Snapshot = serde_json::from_str(&json).unwrap();

        let def2 = parse_orca_md(md).unwrap();
        let mut machine2 = OrcaMachine::new(def2).unwrap();
        machine2.register_action_rust(
            "increment",
            Box::new(|ctx, _| {
                let count = ctx.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"count": count + 1})
            }),
        );
        machine2.resume(&snap).unwrap();

        // resume() should NOT re-run on_entry — count stays at 4 (not 5)
        assert_eq!(machine2.context["count"], 4);
        assert_eq!(machine2.state(), "running");
        assert_eq!(machine2.run_id, "run-99");
        assert!(machine2.is_active());
    }

    #[test]
    fn test_resume_after_final_state() {
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
        machine.send(r#"{"type":"go"}"#).unwrap();

        assert_eq!(machine.state(), "end");
        assert!(!machine.is_active());

        let json = machine.snapshot().unwrap();
        let snap: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snap.state, "end");
        assert!(!snap.active);
    }

    #[test]
    fn test_restore_malformed_json() {
        let md = r#"# machine Counter
## context
| Field | Type | Default |
|-------|------|---------|
| count | int  | 0       |
## state running [initial]
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.start().unwrap();

        let result = machine.restore("not valid json at all");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("deserialize failed"));
    }

    // -- Effects tests --

    #[test]
    fn test_effect_registry_basic() {
        use crate::runtime::effects::EffectRegistry;

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

        let mut registry = EffectRegistry::new();
        registry.register("increment".to_string(), Box::new(|name, payload| {
            // Effects ignore the name when invoked via registry (already dispatched by name)
            let count = payload
                .get("context")
                .and_then(|v| v.get("count"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            Ok(serde_json::json!({"count": count + 1}))
        }));

        machine.set_effect_registry(registry);
        machine.start().unwrap();

        machine.send(r#"{"type":"inc"}"#).unwrap();
        assert_eq!(machine.context["count"], 1);

        machine.send(r#"{"type":"inc"}"#).unwrap();
        assert_eq!(machine.context["count"], 2);
    }

    #[test]
    fn test_effect_registry_not_found_falls_through() {
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

        // Register a different effect name — "increment" not in registry,
        // so it falls through to regular action handler
        let mut registry = EffectRegistry::new();
        registry.register("other_effect".to_string(), Box::new(|_, _| {
            Ok(serde_json::json!({"count": 99}))
        }));
        machine.set_effect_registry(registry);

        machine.register_action_rust(
            "increment",
            Box::new(|ctx, _| {
                let count = ctx.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"count": count + 10})
            }),
        );
        machine.start().unwrap();

        // "increment" not in registry, falls through to action_handlers
        machine.send(r#"{"type":"inc"}"#).unwrap();
        assert_eq!(machine.context["count"], 10);
    }

    #[test]
    fn test_effect_registry_effect_wins_over_action_handler() {
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

        // Register both an effect and an action handler for "increment"
        let mut registry = EffectRegistry::new();
        registry.register("increment".to_string(), Box::new(|_, _| {
            Ok(serde_json::json!({"count": 999}))
        }));
        machine.set_effect_registry(registry);

        // This should NOT be called since effect registry takes precedence
        machine.register_action_rust(
            "increment",
            Box::new(|_, _| {
                serde_json::json!({"count": 10})
            }),
        );
        machine.start().unwrap();

        machine.send(r#"{"type":"inc"}"#).unwrap();
        // Effect handler should have been called
        assert_eq!(machine.context["count"], 999);
    }
}
