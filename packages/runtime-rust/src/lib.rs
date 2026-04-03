pub mod runtime;

use std::ffi::{c_char, c_int, CStr, CString};
use std::ptr;

use runtime::executor::{ActionCallback, OrcaMachine};
use runtime::parser::parse_orca_md;
use runtime::verifier::verify;

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

/// Register an effect handler. No-op stub for v1.
#[no_mangle]
pub unsafe extern "C" fn orca_register_effect(
    handle: *mut OrcaHandle,
    _effect_name: *const c_char,
    _handler_fn: *const (),
) -> c_int {
    if handle.is_null() {
        return ORCA_ERR_INVALID;
    }
    ORCA_OK
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
}
