use std::collections::HashMap;
use serde_json::Value;

/// C-compatible effect handler callback.
/// Takes effect name + input JSON, returns a JSON string result (caller-owned).
/// The returned pointer must be allocated via a mechanism the caller expects
/// (for Rust->C FFI, returning a C-allocated string via Box::into_raw + CString).
pub type EffectHandlerFn = unsafe extern "C" fn(
    effect_name: *const std::os::raw::c_char,
    payload_json: *const std::os::raw::c_char,
) -> *mut std::os::raw::c_char;

/// Internal Rust effect handler.
pub type EffectHandler = Box<dyn Fn(&str, &Value) -> Result<Value, String> + Send>;

/// Effect registry — maps effect names to handlers.
pub struct EffectRegistry {
    handlers: HashMap<String, EffectHandler>,
}

impl Default for EffectRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl EffectRegistry {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Register an effect handler.
    pub fn register(&mut self, name: String, handler: EffectHandler) {
        self.handlers.insert(name, handler);
    }

    /// Returns true if an effect with this name is registered.
    pub fn has_effect(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }

    /// Invoke a registered effect. Returns error if not found.
    pub fn invoke(&self, name: &str, payload: &Value) -> Result<Value, String> {
        match self.handlers.get(name) {
            Some(handler) => handler(name, payload),
            None => Err(format!("no effect registered: {}", name)),
        }
    }

    /// List all registered effect names.
    pub fn effect_names(&self) -> Vec<&String> {
        self.handlers.keys().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_effect_registry_basic() {
        let mut registry = EffectRegistry::new();

        registry.register("log".to_string(), Box::new(|name, payload| {
            assert_eq!(name, "log");
            Ok(serde_json::json!({"logged": true}))
        }));

        assert!(registry.has_effect("log"));
        assert!(!registry.has_effect("unknown"));

        let result = registry.invoke("log", &serde_json::json!({"msg": "hello"}));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), serde_json::json!({"logged": true}));
    }

    #[test]
    fn test_effect_registry_not_found() {
        let registry = EffectRegistry::new();
        let result = registry.invoke("missing", &Value::Null);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no effect registered"));
    }

    #[test]
    fn test_effect_registry_multiple() {
        let mut registry = EffectRegistry::new();

        registry.register("add".to_string(), Box::new(|_, payload| {
            let a = payload.get("a").and_then(|v| v.as_i64()).unwrap_or(0);
            let b = payload.get("b").and_then(|v| v.as_i64()).unwrap_or(0);
            Ok(serde_json::json!({"result": a + b }))
        }));

        registry.register("mul".to_string(), Box::new(|_, payload| {
            let a = payload.get("a").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let b = payload.get("b").and_then(|v| v.as_f64()).unwrap_or(0.0);
            Ok(serde_json::json!({"result": a * b }))
        }));

        assert_eq!(
            registry.invoke("add", &serde_json::json!({"a": 2, "b": 3})).unwrap(),
            serde_json::json!({"result": 5})
        );
        assert_eq!(
            registry.invoke("mul", &serde_json::json!({"a": 4.0, "b": 3.0})).unwrap(),
            serde_json::json!({"result": 12.0})
        );
    }
}
