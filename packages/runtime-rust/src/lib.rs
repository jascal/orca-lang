pub mod runtime;

use std::ffi::{c_char, c_int, CStr, CString};
use std::ptr;

use runtime::executor::{ActionCallback, OrcaMachine, TransitionCallback};
use runtime::logging::FileSink;
use runtime::parser::{parse_orca_md, parse_orca_md_multi};
use runtime::verifier::verify;
use runtime::effects::EffectHandlerFn;

// Re-exports for public API
pub use runtime::persistence::{FilePersistence, PersistenceAdapter, Snapshot};

// Error codes matching run_orca_ffi.h
const ORCA_OK: c_int = 0;
const ORCA_ERR_PARSE: c_int = -1;
const ORCA_ERR_VERIFY: c_int = -2;
const ORCA_ERR_RUNTIME: c_int = -3;
const ORCA_ERR_INVALID: c_int = -4;

/// Opaque handle exposed to C callers.
pub struct OrcaHandle {
    machine: OrcaMachine,
    last_error: CString,
}

impl OrcaHandle {
    fn set_error(&mut self, msg: &str) {
        self.last_error = CString::new(msg).unwrap_or_default();
    }
}

// -- FFI exports --

/// Initialize an Orca machine from a .orca.md markdown string.
/// Parses, verifies, and starts the machine. Returns a handle via handle_ptr.
#[no_mangle]
pub unsafe extern "C" fn orca_init(
    orca_md_source: *const c_char,
    source_len: usize,
    handle_ptr: *mut *mut OrcaHandle,
) -> c_int {
    if orca_md_source.is_null() || handle_ptr.is_null() {
        return ORCA_ERR_INVALID;
    }

    // Convert source to &str
    let source_bytes = std::slice::from_raw_parts(orca_md_source as *const u8, source_len);
    let source_str = match std::str::from_utf8(source_bytes) {
        Ok(s) => s,
        Err(_) => return ORCA_ERR_INVALID,
    };

    // Parse
    let machine_def = match parse_orca_md(source_str) {
        Ok(def) => def,
        Err(_e) => return ORCA_ERR_PARSE,
    };

    // Verify
    if let Err(_e) = verify(&machine_def) {
        return ORCA_ERR_VERIFY;
    }

    // Create executor
    let mut machine = match OrcaMachine::new(machine_def) {
        Ok(m) => m,
        Err(_e) => return ORCA_ERR_RUNTIME,
    };

    // Start
    if let Err(_e) = machine.start() {
        return ORCA_ERR_RUNTIME;
    }

    let handle = Box::new(OrcaHandle {
        machine,
        last_error: CString::default(),
    });

    *handle_ptr = Box::into_raw(handle);
    ORCA_OK
}

/// Initialize multiple Orca machines from a multi-machine .orca.md source
/// (machines separated by `---`).
/// On success, writes array pointer to handles_ptr and count to count_ptr.
/// Caller must free each handle with orca_free, then free the array with orca_free_multi.
#[no_mangle]
pub unsafe extern "C" fn orca_init_multi(
    orca_md_source: *const c_char,
    source_len: usize,
    handles_ptr: *mut *mut *mut OrcaHandle,
    count_ptr: *mut usize,
) -> c_int {
    if orca_md_source.is_null() || handles_ptr.is_null() || count_ptr.is_null() {
        return ORCA_ERR_INVALID;
    }

    let source_bytes = std::slice::from_raw_parts(orca_md_source as *const u8, source_len);
    let source_str = match std::str::from_utf8(source_bytes) {
        Ok(s) => s,
        Err(_) => return ORCA_ERR_INVALID,
    };

    let machine_defs = match parse_orca_md_multi(source_str) {
        Ok(defs) => defs,
        Err(_e) => return ORCA_ERR_PARSE,
    };

    let mut handle_vec: Vec<*mut OrcaHandle> = Vec::with_capacity(machine_defs.len());

    for def in machine_defs {
        if let Err(_e) = verify(&def) {
            for h in &handle_vec {
                drop(Box::from_raw(*h));
            }
            return ORCA_ERR_VERIFY;
        }

        let mut machine = match OrcaMachine::new(def) {
            Ok(m) => m,
            Err(_e) => {
                for h in &handle_vec {
                    drop(Box::from_raw(*h));
                }
                return ORCA_ERR_RUNTIME;
            }
        };

        if let Err(_e) = machine.start() {
            for h in &handle_vec {
                drop(Box::from_raw(*h));
            }
            return ORCA_ERR_RUNTIME;
        }

        let handle = Box::new(OrcaHandle {
            machine,
            last_error: CString::default(),
        });
        handle_vec.push(Box::into_raw(handle));
    }

    let count = handle_vec.len();
    let array = handle_vec.into_boxed_slice();
    let array_ptr = Box::into_raw(array) as *mut *mut OrcaHandle;

    *handles_ptr = array_ptr;
    *count_ptr = count;
    ORCA_OK
}

/// Free the array returned by orca_init_multi (does NOT free individual handles).
/// Call orca_free on each handle first, then call this to free the array itself.
#[no_mangle]
pub unsafe extern "C" fn orca_free_multi(
    handles: *mut *mut OrcaHandle,
    count: usize,
) {
    if !handles.is_null() && count > 0 {
        let _ = Box::from_raw(std::slice::from_raw_parts_mut(handles, count) as *mut [*mut OrcaHandle]);
    }
}

/// Initialize a single Orca machine by name from a multi-machine .orca.md source.
/// Parses all machines, selects the one matching machine_name, verifies and starts it.
#[no_mangle]
pub unsafe extern "C" fn orca_init_named(
    orca_md_source: *const c_char,
    source_len: usize,
    machine_name: *const c_char,
    name_len: usize,
    handle_ptr: *mut *mut OrcaHandle,
) -> c_int {
    if orca_md_source.is_null() || machine_name.is_null() || handle_ptr.is_null() {
        return ORCA_ERR_INVALID;
    }

    let source_bytes = std::slice::from_raw_parts(orca_md_source as *const u8, source_len);
    let source_str = match std::str::from_utf8(source_bytes) {
        Ok(s) => s,
        Err(_) => return ORCA_ERR_INVALID,
    };

    let name_bytes = std::slice::from_raw_parts(machine_name as *const u8, name_len);
    let name_str = match std::str::from_utf8(name_bytes) {
        Ok(s) => s,
        Err(_) => return ORCA_ERR_INVALID,
    };

    let machine_defs = match parse_orca_md_multi(source_str) {
        Ok(defs) => defs,
        Err(_e) => return ORCA_ERR_PARSE,
    };

    let machine_def = match machine_defs.into_iter().find(|d| d.name == name_str) {
        Some(def) => def,
        None => return ORCA_ERR_PARSE,
    };

    if let Err(_e) = verify(&machine_def) {
        return ORCA_ERR_VERIFY;
    }

    let mut machine = match OrcaMachine::new(machine_def) {
        Ok(m) => m,
        Err(_e) => return ORCA_ERR_RUNTIME,
    };

    if let Err(_e) = machine.start() {
        return ORCA_ERR_RUNTIME;
    }

    let handle = Box::new(OrcaHandle {
        machine,
        last_error: CString::default(),
    });

    *handle_ptr = Box::into_raw(handle);
    ORCA_OK
}

/// Free a machine handle and all associated resources.
#[no_mangle]
pub unsafe extern "C" fn orca_free(handle: *mut OrcaHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Dispatch an event to the machine. Synchronous — processes immediately.
#[no_mangle]
pub unsafe extern "C" fn orca_send(
    handle: *mut OrcaHandle,
    event_json: *const c_char,
    event_len: usize,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if event_json.is_null() {
        h.set_error("event_json is null");
        return ORCA_ERR_INVALID;
    }

    let event_bytes = std::slice::from_raw_parts(event_json as *const u8, event_len);
    let event_str = match std::str::from_utf8(event_bytes) {
        Ok(s) => s,
        Err(_) => {
            h.set_error("Invalid UTF-8 in event JSON");
            return ORCA_ERR_INVALID;
        }
    };

    match h.machine.send(event_str) {
        Ok(()) => ORCA_OK,
        Err(e) => {
            h.set_error(&e.message);
            ORCA_ERR_RUNTIME
        }
    }
}

/// Block until idle. No-op for synchronous executor.
#[no_mangle]
pub unsafe extern "C" fn orca_wait(handle: *mut OrcaHandle) -> c_int {
    if handle.is_null() {
        return ORCA_ERR_INVALID;
    }
    ORCA_OK
}

/// Convenience: send + wait. For synchronous executor, equivalent to orca_send.
#[no_mangle]
pub unsafe extern "C" fn orca_send_and_wait(
    handle: *mut OrcaHandle,
    event_json: *const c_char,
    event_len: usize,
) -> c_int {
    orca_send(handle, event_json, event_len)
}

/// Poll the machine. Always returns 0 (idle) for synchronous executor.
#[no_mangle]
pub unsafe extern "C" fn orca_poll(handle: *mut OrcaHandle) -> i32 {
    if handle.is_null() {
        return ORCA_ERR_INVALID;
    }
    0 // Always idle
}

/// Get current machine state as JSON.
/// Writes into caller-provided buffer. Actual length returned via actual_len.
#[no_mangle]
pub unsafe extern "C" fn orca_state(
    handle: *mut OrcaHandle,
    buf: *mut c_char,
    buf_len: usize,
    actual_len: *mut usize,
) -> c_int {
    let h = match handle.as_ref() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    let json = h.machine.state_json();
    let json_bytes = json.as_bytes();

    if !actual_len.is_null() {
        *actual_len = json_bytes.len();
    }

    if !buf.is_null() && buf_len > 0 {
        let copy_len = json_bytes.len().min(buf_len - 1);
        ptr::copy_nonoverlapping(json_bytes.as_ptr(), buf as *mut u8, copy_len);
        // Null-terminate
        *buf.add(copy_len) = 0;
    }

    ORCA_OK
}

/// Register an action callback (C function pointer).
#[no_mangle]
pub unsafe extern "C" fn orca_register_action(
    handle: *mut OrcaHandle,
    action_name: *const c_char,
    callback: ActionCallback,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if action_name.is_null() {
        h.set_error("action_name is null");
        return ORCA_ERR_INVALID;
    }

    let name = match CStr::from_ptr(action_name).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => {
            h.set_error("Invalid UTF-8 in action name");
            return ORCA_ERR_INVALID;
        }
    };

    h.machine.register_action_c(&name, callback);
    ORCA_OK
}

/// C-compatible transition callback type.
/// Arguments: (from_state, to_state, event) — all null-terminated C strings.
pub type TransitionCallbackC = unsafe extern "C" fn(
    from_state: *const c_char,
    to_state: *const c_char,
    event: *const c_char,
);

/// Register a transition callback (C function pointer).
/// Called after every successful state transition with (from_state, to_state, event).
#[no_mangle]
pub unsafe extern "C" fn orca_on_transition(
    handle: *mut OrcaHandle,
    callback: TransitionCallbackC,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    let rust_callback: TransitionCallback = Box::new(move |from: &str, to: &str, event: &str| {
        let from_c = CString::new(from).unwrap_or_default();
        let to_c = CString::new(to).unwrap_or_default();
        let event_c = CString::new(event).unwrap_or_default();
        unsafe {
            callback(from_c.as_ptr(), to_c.as_ptr(), event_c.as_ptr());
        }
    });

    h.machine.on_transition(rust_callback);
    ORCA_OK
}

/// Set a JSONL log file for audit logging of transitions.
/// Creates parent directories and opens in append mode.
#[no_mangle]
pub unsafe extern "C" fn orca_set_log_file(
    handle: *mut OrcaHandle,
    path: *const c_char,
    path_len: usize,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if path.is_null() {
        h.set_error("path is null");
        return ORCA_ERR_INVALID;
    }

    let path_bytes = std::slice::from_raw_parts(path as *const u8, path_len);
    let path_str = match std::str::from_utf8(path_bytes) {
        Ok(s) => s,
        Err(_) => {
            h.set_error("Invalid UTF-8 in path");
            return ORCA_ERR_INVALID;
        }
    };

    match FileSink::new(path_str) {
        Ok(sink) => {
            h.machine.set_log_sink(Box::new(sink));
            ORCA_OK
        }
        Err(e) => {
            h.set_error(&format!("Failed to open log file: {}", e));
            ORCA_ERR_RUNTIME
        }
    }
}

/// Set the run ID used in log entries.
#[no_mangle]
pub unsafe extern "C" fn orca_set_run_id(
    handle: *mut OrcaHandle,
    id: *const c_char,
    id_len: usize,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if id.is_null() {
        h.set_error("id is null");
        return ORCA_ERR_INVALID;
    }

    let id_bytes = std::slice::from_raw_parts(id as *const u8, id_len);
    let id_str = match std::str::from_utf8(id_bytes) {
        Ok(s) => s,
        Err(_) => {
            h.set_error("Invalid UTF-8 in run_id");
            return ORCA_ERR_INVALID;
        }
    };

    h.machine.set_run_id(id_str.to_string());
    ORCA_OK
}

/// Register an effect handler with the machine's effect registry.
#[no_mangle]
pub unsafe extern "C" fn orca_register_effect(
    handle: *mut OrcaHandle,
    effect_name: *const c_char,
    handler_fn: Option<EffectHandlerFn>,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if effect_name.is_null() {
        h.set_error("effect_name is null");
        return ORCA_ERR_INVALID;
    }

    let handler_fn = match handler_fn {
        Some(f) => f,
        None => {
            h.set_error("handler_fn is null");
            return ORCA_ERR_INVALID;
        }
    };

    let name = match CStr::from_ptr(effect_name).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => {
            h.set_error("Invalid UTF-8 in effect name");
            return ORCA_ERR_INVALID;
        }
    };

    // Wrap the C callback in a Rust closure
    let name_for_cb = name.clone();
    let handler = move |_effect_name: &str, payload: &serde_json::Value| {
        let payload_json =
            CString::new(serde_json::to_string(payload).unwrap_or_default())
                .unwrap_or_default();
        // Pass the effect name as the first argument to the C callback
        let name_c = CString::new(name_for_cb.as_str()).unwrap_or_default();
        let result_ptr = handler_fn(name_c.as_ptr(), payload_json.as_ptr());

        if result_ptr.is_null() {
            Ok(serde_json::Value::Null)
        } else {
            let result_cstr = unsafe { CStr::from_ptr(result_ptr) };
            let result_str = result_cstr.to_str().unwrap_or("{}");
            Ok(serde_json::from_str(result_str).unwrap_or(serde_json::Value::Null))
        }
    };

    // Get or create the effect registry
    let registry = h.machine.effect_registry_mut();
    registry.register(name, Box::new(handler));

    ORCA_OK
}

/// Serialize the current machine state to a JSON snapshot string.
/// Caller owns the returned string — must free with orca_free_string.
#[no_mangle]
pub unsafe extern "C" fn orca_snapshot(handle: *mut OrcaHandle) -> *mut c_char {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ptr::null_mut(),
    };

    match h.machine.snapshot() {
        Ok(json) => CString::into_raw(CString::new(json).unwrap_or_default()),
        Err(_) => ptr::null_mut(),
    }
}

/// Restore machine state from a JSON snapshot string.
#[no_mangle]
pub unsafe extern "C" fn orca_restore(
    handle: *mut OrcaHandle,
    snapshot_json: *const c_char,
    json_len: usize,
) -> c_int {
    let h = match handle.as_mut() {
        Some(h) => h,
        None => return ORCA_ERR_INVALID,
    };

    if snapshot_json.is_null() {
        h.set_error("snapshot_json is null");
        return ORCA_ERR_INVALID;
    }

    let json_bytes = std::slice::from_raw_parts(snapshot_json as *const u8, json_len);
    let json_str = match std::str::from_utf8(json_bytes) {
        Ok(s) => s,
        Err(_) => {
            h.set_error("Invalid UTF-8 in snapshot JSON");
            return ORCA_ERR_INVALID;
        }
    };

    match h.machine.restore(json_str) {
        Ok(()) => ORCA_OK,
        Err(e) => {
            h.set_error(&e);
            ORCA_ERR_RUNTIME
        }
    }
}

/// Free a string allocated by orca_snapshot.
#[no_mangle]
pub unsafe extern "C" fn orca_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// Get the last error message. Valid until next call on this handle.
#[no_mangle]
pub unsafe extern "C" fn orca_last_error(handle: *mut OrcaHandle) -> *const c_char {
    match handle.as_ref() {
        Some(h) => h.last_error.as_ptr(),
        None => ptr::null(),
    }
}

// -- Integration tests --

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    const TOGGLE_MD: &str = r#"# machine Toggle
## state off [initial]
## state on
## transitions
| Source | Event  | Guard | Target | Action |
|--------|--------|-------|--------|--------|
| off    | toggle |       | on     |        |
| on     | toggle |       | off    |        |
"#;

    #[test]
    fn test_ffi_init_and_free() {
        unsafe {
            let source = CString::new(TOGGLE_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(source.as_ptr(), TOGGLE_MD.len(), &mut handle);
            assert_eq!(rc, ORCA_OK);
            assert!(!handle.is_null());
            orca_free(handle);
        }
    }

    #[test]
    fn test_ffi_send_and_state() {
        unsafe {
            let source = CString::new(TOGGLE_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(source.as_ptr(), TOGGLE_MD.len(), &mut handle);
            assert_eq!(rc, ORCA_OK);

            // Check initial state
            let mut buf = vec![0u8; 1024];
            let mut actual: usize = 0;
            orca_state(
                handle,
                buf.as_mut_ptr() as *mut c_char,
                buf.len(),
                &mut actual,
            );
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "off");

            // Send toggle event
            let event = r#"{"type":"toggle"}"#;
            let rc = orca_send(handle, event.as_ptr() as *const c_char, event.len());
            assert_eq!(rc, ORCA_OK);

            // Check new state
            orca_state(
                handle,
                buf.as_mut_ptr() as *mut c_char,
                buf.len(),
                &mut actual,
            );
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "on");

            orca_free(handle);
        }
    }

    #[test]
    fn test_ffi_parse_error() {
        unsafe {
            let bad_source = CString::new("not valid orca").unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(bad_source.as_ptr(), 14, &mut handle);
            assert_eq!(rc, ORCA_ERR_PARSE);
            assert!(handle.is_null());
        }
    }

    #[test]
    fn test_ffi_wait_and_poll() {
        unsafe {
            let source = CString::new(TOGGLE_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            orca_init(source.as_ptr(), TOGGLE_MD.len(), &mut handle);

            assert_eq!(orca_wait(handle), ORCA_OK);
            assert_eq!(orca_poll(handle), 0);

            orca_free(handle);
        }
    }

    #[test]
    fn test_producer_end_to_end() {
        let md = r#"# machine Producer
## context
| Field     | Type   | Default |
|-----------|--------|---------|
| inventory | int    | 100     |
| price     | float  | 10.0    |

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
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.register_action_rust(
            "produce",
            Box::new(|ctx, _| {
                let inv = ctx.get("inventory").and_then(|v| v.as_i64()).unwrap_or(0);
                serde_json::json!({"inventory": inv + 10})
            }),
        );
        machine.register_action_rust(
            "cut_price",
            Box::new(|ctx, _| {
                let price = ctx.get("price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                serde_json::json!({"price": price - 1.0})
            }),
        );
        machine.register_action_rust(
            "raise_price",
            Box::new(|ctx, _| {
                let price = ctx.get("price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                serde_json::json!({"price": price + 1.0})
            }),
        );
        machine.start().unwrap();

        // Tick: inventory 100 -> 110
        machine.send(r#"{"type":"tick"}"#).unwrap();
        assert_eq!(machine.context()["inventory"], 110);

        // Price signal with price 10.0 — no guard matches (10 is not > 15 or < 5)
        machine
            .send(r#"{"type":"price_signal"}"#)
            .unwrap();
        assert_eq!(machine.context()["price"], 10.0);
    }

    #[test]
    fn test_consumer_update_price_then_buy() {
        // Simulate the full consumer flow: update_price via price_signal, then buy via tick
        let md = r#"# machine Consumer
## context
| Field | Type  | Default |
|-------|-------|---------|
| cash  | float | 1000.0  |
| goods | int   | 0       |
| price | float | 10.0    |

## state active [initial]

## transitions
| Source | Event        | Guard        | Target | Action       |
|--------|-------------|--------------|--------|--------------|
| active | tick         | price < 8.0  | active | buy          |
| active | tick         | price > 12.0 | active | sell         |
| active | tick         | else         | active | hold         |
| active | price_signal |              | active | update_price |
"#;
        let def = parse_orca_md(md).unwrap();
        let mut machine = OrcaMachine::new(def).unwrap();
        machine.register_action_rust("buy", Box::new(|ctx, _| {
            let goods = ctx.get("goods").and_then(|v| v.as_i64()).unwrap_or(0);
            serde_json::json!({"goods": goods + 1})
        }));
        machine.register_action_rust("sell", Box::new(|_, _| serde_json::json!({})));
        machine.register_action_rust("hold", Box::new(|_, _| serde_json::json!({})));
        machine.register_action_rust("update_price", Box::new(|_, _| {
            serde_json::json!({"price": 5.0})
        }));
        machine.start().unwrap();

        // Initial: price=10.0, tick → hold (10 is not < 8)
        machine.send(r#"{"type":"tick"}"#).unwrap();
        assert_eq!(machine.context()["goods"], 0);

        // Update price to 5.0 via price_signal
        machine.send(r#"{"type":"price_signal"}"#).unwrap();
        assert_eq!(machine.context()["price"], 5.0, "price should be updated to 5.0");

        // Now tick: price=5.0 < 8.0 → buy
        machine.send(r#"{"type":"tick"}"#).unwrap();
        assert_eq!(machine.context()["goods"], 1, "consumer should have bought");
    }

    #[test]
    fn test_consumer_guard_fallthrough() {
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
        assert_eq!(machine.context()["goods"], 1);

        // Update price to 10.0 (between 8 and 12 — neither guard passes, falls to else → hold)
        machine.set_context_field("price", serde_json::json!(10.0));
        machine.send(r#"{"type":"tick"}"#).unwrap();
        // goods should still be 1 (hold is no-op)
        assert_eq!(machine.context()["goods"], 1);
    }

    // -- Multi-machine FFI tests --

    const MULTI_MD: &str = r#"# machine Toggle
## state off [initial]
## state on
## transitions
| Source | Event  | Guard | Target | Action |
|--------|--------|-------|--------|--------|
| off    | toggle |       | on     |        |
| on     | toggle |       | off    |        |

---

# machine Counter
## state counting [initial]
## state done [final]
## transitions
| Source   | Event | Guard | Target   | Action |
|----------|-------|-------|----------|--------|
| counting | inc   |       | counting |        |
| counting | stop  |       | done     |        |
"#;

    #[test]
    fn test_ffi_init_multi() {
        unsafe {
            let source = CString::new(MULTI_MD).unwrap();
            let mut handles: *mut *mut OrcaHandle = ptr::null_mut();
            let mut count: usize = 0;
            let rc = orca_init_multi(
                source.as_ptr(),
                MULTI_MD.len(),
                &mut handles,
                &mut count,
            );
            assert_eq!(rc, ORCA_OK);
            assert_eq!(count, 2);
            assert!(!handles.is_null());

            let h0 = *handles.add(0);
            let mut buf = vec![0u8; 1024];
            let mut actual: usize = 0;
            orca_state(h0, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "off");

            let h1 = *handles.add(1);
            orca_state(h1, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "counting");

            let toggle_evt = r#"{"type":"toggle"}"#;
            let rc = orca_send(h0, toggle_evt.as_ptr() as *const c_char, toggle_evt.len());
            assert_eq!(rc, ORCA_OK);

            orca_state(h0, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "on");

            orca_free(h0);
            orca_free(h1);
            orca_free_multi(handles, count);
        }
    }

    #[test]
    fn test_ffi_init_named() {
        unsafe {
            let source = CString::new(MULTI_MD).unwrap();
            let name = "Counter";
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init_named(
                source.as_ptr(),
                MULTI_MD.len(),
                name.as_ptr() as *const c_char,
                name.len(),
                &mut handle,
            );
            assert_eq!(rc, ORCA_OK);
            assert!(!handle.is_null());

            let mut buf = vec![0u8; 1024];
            let mut actual: usize = 0;
            orca_state(handle, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "counting");

            orca_free(handle);
        }
    }

    #[test]
    fn test_ffi_init_named_not_found() {
        unsafe {
            let source = CString::new(MULTI_MD).unwrap();
            let name = "NonExistent";
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init_named(
                source.as_ptr(),
                MULTI_MD.len(),
                name.as_ptr() as *const c_char,
                name.len(),
                &mut handle,
            );
            assert_eq!(rc, ORCA_ERR_PARSE);
            assert!(handle.is_null());
        }
    }

    #[test]
    fn test_ffi_init_named_toggle() {
        unsafe {
            let source = CString::new(MULTI_MD).unwrap();
            let name = "Toggle";
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init_named(
                source.as_ptr(),
                MULTI_MD.len(),
                name.as_ptr() as *const c_char,
                name.len(),
                &mut handle,
            );
            assert_eq!(rc, ORCA_OK);
            assert!(!handle.is_null());

            let mut buf = vec![0u8; 1024];
            let mut actual: usize = 0;
            orca_state(handle, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            assert_eq!(json["state"], "off");

            orca_free(handle);
        }
    }

    // -- Snapshot / Restore FFI tests --

    #[test]
    fn test_ffi_action_callback_direct() {
        // Direct test of the C callback
        unsafe {
            let ctx_json = CString::new(r#"{"count":5}"#).unwrap();
            let event_json = CString::new(r#"{"type":"inc"}"#).unwrap();
            let result = counter_increment_callback(ctx_json.as_ptr(), event_json.as_ptr());
            assert!(!result.is_null());
            let result_cstr = CStr::from_ptr(result);
            let result_str = result_cstr.to_str().unwrap();
            let result_val: serde_json::Value = serde_json::from_str(result_str).unwrap();
            assert_eq!(result_val["count"], 6);
        }
    }

    const COUNTER_MD: &str = r#"# machine Counter
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

    #[test]
    fn test_ffi_action_callback_via_machine() {
        // Test the full path: init machine, register C callback, send event, check context
        unsafe {
            let source = CString::new(COUNTER_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(source.as_ptr(), COUNTER_MD.len(), &mut handle);
            assert_eq!(rc, ORCA_OK);

            let action_name = CString::new("increment").unwrap();
            let rc = orca_register_action(
                handle,
                action_name.as_ptr(),
                counter_increment_callback,
            );
            assert_eq!(rc, ORCA_OK);

            // Check state BEFORE send
            let mut buf = vec![0u8; 256];
            let mut actual: usize = 0;
            orca_state(handle, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_before: serde_json::Value =
                serde_json::from_str(std::str::from_utf8(&buf[..actual]).unwrap()).unwrap();
            assert_eq!(json_before["state"], "running");
            assert_eq!(json_before["context"]["count"], 0);

            // Note: CString includes null terminator in its length, so we use the
            // string's byte length directly (12 bytes for '{"type":"inc"}')
            let inc_str = r#"{"type":"inc"}"#;
            let inc = CString::new(inc_str).unwrap();
            let rc_send = orca_send(handle, inc.as_ptr(), inc_str.len());
            if rc_send != ORCA_OK {
                let err_ptr = orca_last_error(handle);
                let err_str = CStr::from_ptr(err_ptr).to_string_lossy();
                panic!("orca_send failed with {}: {}", rc_send, err_str);
            }
            assert_eq!(rc_send, ORCA_OK);

            // Check state AFTER send
            orca_state(handle, buf.as_mut_ptr() as *mut c_char, buf.len(), &mut actual);
            let json_after: serde_json::Value =
                serde_json::from_str(std::str::from_utf8(&buf[..actual]).unwrap()).unwrap();
            assert_eq!(json_after["context"]["count"], 1, "count should be 1 after one inc");

            orca_free(handle);
        }
    }

    #[test]
    fn test_ffi_snapshot_restore() {
        unsafe {
            // Create and advance machine to count=2
            let source = CString::new(COUNTER_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(source.as_ptr(), COUNTER_MD.len(), &mut handle);
            assert_eq!(rc, ORCA_OK);

            // Register action then advance
            let action_name = CString::new("increment").unwrap();
            let rc = orca_register_action(
                handle,
                action_name.as_ptr(),
                counter_increment_callback,
            );
            assert_eq!(rc, ORCA_OK);

            let inc = CString::new(r#"{"type":"inc"}"#).unwrap();
            let inc_len = CStr::from_ptr(inc.as_ptr()).to_bytes().len();
            orca_send(handle, inc.as_ptr(), inc_len);
            orca_send(handle, inc.as_ptr(), inc_len);

            // Snapshot
            let snap_ptr = orca_snapshot(handle);
            assert!(!snap_ptr.is_null());
            let snap_cstr = CStr::from_ptr(snap_ptr);
            let snap_bytes = snap_cstr.to_bytes();
            eprintln!("snap raw bytes len = {}, content prefix = {:?}",
                snap_bytes.len(),
                &snap_bytes[..snap_bytes.len().min(50)]);
            let snap_json: serde_json::Value =
                serde_json::from_str(snap_cstr.to_str().unwrap()).unwrap();
            assert_eq!(snap_json["state"], "running");
            assert_eq!(snap_json["context"]["count"], 2);

            // Create a second machine from same source
            let mut handle2: *mut OrcaHandle = ptr::null_mut();
            let rc2 = orca_init(source.as_ptr(), COUNTER_MD.len(), &mut handle2);
            assert_eq!(rc2, ORCA_OK);
            let rc_reg2 = orca_register_action(
                handle2,
                action_name.as_ptr(),
                counter_increment_callback,
            );
            assert_eq!(rc_reg2, ORCA_OK);

            // Advance the second machine to count=5
            for _ in 0..5 {
                orca_send(handle2, inc.as_ptr(), inc_len);
            }
            let mut buf2 = vec![0u8; 1024];
            let mut actual2: usize = 0;
            orca_state(
                handle2,
                buf2.as_mut_ptr() as *mut c_char,
                buf2.len(),
                &mut actual2,
            );
            let json_str2 = std::str::from_utf8(&buf2[..actual2]).unwrap();
            let json2: serde_json::Value = serde_json::from_str(json_str2).unwrap();
            assert_eq!(json2["context"]["count"], 5);

            // Restore snapshot into handle2
            // CStr::to_bytes() does NOT include the null terminator
            let snap_bytes = snap_cstr.to_bytes();
            let snap_len = snap_bytes.len();
            let rc_restore = orca_restore(handle2, snap_ptr as *const c_char, snap_len);
            if rc_restore != ORCA_OK {
                let err_ptr = orca_last_error(handle2);
                let err_str = CStr::from_ptr(err_ptr).to_string_lossy();
                panic!("orca_restore failed with {}: {}", rc_restore, err_str);
            }
            assert_eq!(rc_restore, ORCA_OK);

            // Now handle2 should be at count=2
            orca_state(
                handle2,
                buf2.as_mut_ptr() as *mut c_char,
                buf2.len(),
                &mut actual2,
            );
            let json_str2b = std::str::from_utf8(&buf2[..actual2]).unwrap();
            let json2b: serde_json::Value = serde_json::from_str(json_str2b).unwrap();
            assert_eq!(json2b["context"]["count"], 2);
            assert_eq!(json2b["state"], "running");

            // Clean up
            orca_free_string(snap_ptr);
            orca_free(handle);
            orca_free(handle2);
        }
    }

    #[test]
    fn test_ffi_snapshot_null_handle() {
        unsafe {
            let ptr = orca_snapshot(ptr::null_mut());
            assert!(ptr.is_null());
        }
    }

    #[test]
    fn test_ffi_restore_null_handle() {
        unsafe {
            let json = CString::new(r#"{"state":"idle","context":{}}"#).unwrap();
            let rc = orca_restore(ptr::null_mut(), json.as_ptr(), json.as_bytes().len());
            assert_eq!(rc, ORCA_ERR_INVALID);
        }
    }

    // -- Effect FFI tests --

    #[test]
    fn test_ffi_register_effect() {
        unsafe {
            let source = CString::new(COUNTER_MD).unwrap();
            let mut handle: *mut OrcaHandle = ptr::null_mut();
            let rc = orca_init(source.as_ptr(), COUNTER_MD.len(), &mut handle);
            assert_eq!(rc, ORCA_OK);

            // Register an effect that doubles the count
            let effect_name = CString::new("increment").unwrap();
            let rc = orca_register_effect(
                handle,
                effect_name.as_ptr(),
                Some(double_effect_callback),
            );
            assert_eq!(rc, ORCA_OK);

            // Send inc — should invoke the effect (count 0 -> 2)
            let inc_str = r#"{"type":"inc"}"#;
            let inc = CString::new(inc_str).unwrap();
            orca_send(handle, inc.as_ptr(), inc_str.len());

            let mut buf = vec![0u8; 1024];
            let mut actual: usize = 0;
            orca_state(
                handle,
                buf.as_mut_ptr() as *mut c_char,
                buf.len(),
                &mut actual,
            );
            let json_str = std::str::from_utf8(&buf[..actual]).unwrap();
            let json: serde_json::Value = serde_json::from_str(json_str).unwrap();
            // Effect doubled: 0 -> 2
            assert_eq!(json["context"]["count"], 2);

            orca_free(handle);
        }
    }

    // C callback used by FFI action tests
    // Returns a pointer to CString data. Caller must use CString::from_raw to reclaim.
    unsafe extern "C" fn counter_increment_callback(
        ctx_json: *const c_char,
        _event_json: *const c_char,
    ) -> *const c_char {
        let ctx_str = CStr::from_ptr(ctx_json);
        let ctx: serde_json::Value =
            serde_json::from_str(ctx_str.to_str().unwrap_or("{}")).unwrap();
        let count = ctx
            .get("count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let result = serde_json::json!({"count": count + 1}).to_string();
        let cstr = CString::new(result).unwrap();
        // Cast mut to const — caller (execute_action) borrows via CStr::from_ptr,
        // then the Box::from_raw + drop in execute_action will deallocate.
        cstr.into_raw() as *const c_char
    }

    // C callback used by FFI effect tests — doubles the count
    unsafe extern "C" fn double_effect_callback(
        _effect_name: *const c_char,
        payload_json: *const c_char,
    ) -> *mut c_char {
        let payload_str = CStr::from_ptr(payload_json);
        let event: serde_json::Value =
            serde_json::from_str(payload_str.to_str().unwrap_or("{}")).unwrap();
        let count = event
            .get("context")
            .and_then(|v| v.get("count"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let result = serde_json::json!({"count": count + 2}).to_string();
        let cstr = CString::new(result).unwrap();
        cstr.into_raw()
    }
}
