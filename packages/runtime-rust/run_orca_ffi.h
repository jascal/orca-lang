#ifndef RUN_ORCA_FFI_H
#define RUN_ORCA_FFI_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handle to an Orca machine instance */
typedef struct orca_handle orca_handle_t;

/* Error codes */
#define ORCA_OK           0
#define ORCA_ERR_PARSE   -1
#define ORCA_ERR_VERIFY  -2
#define ORCA_ERR_RUNTIME -3
#define ORCA_ERR_INVALID  -4

/* Initialize an Orca machine from a .orca.md markdown string.
 * Parses and verifies the machine. Returns a handle via handle_ptr. */
int orca_init(
    const char* orca_md_source,
    size_t source_len,
    orca_handle_t** handle_ptr
);

/* Initialize multiple Orca machines from a multi-machine .orca.md source
 * (machines separated by ---).
 * On success, writes array pointer to handles_ptr and count to count_ptr.
 * Caller must free each handle with orca_free, then free the array with orca_free_multi. */
int orca_init_multi(
    const char* orca_md_source,
    size_t source_len,
    orca_handle_t*** handles_ptr,
    size_t* count_ptr
);

/* Free the array returned by orca_init_multi (does NOT free individual handles).
 * Call orca_free on each handle first, then call this to free the array itself. */
void orca_free_multi(
    orca_handle_t** handles,
    size_t count
);

/* Initialize a single Orca machine by name from a multi-machine .orca.md source.
 * Parses all machines, selects the one matching machine_name, verifies and starts it. */
int orca_init_named(
    const char* orca_md_source,
    size_t source_len,
    const char* machine_name,
    size_t name_len,
    orca_handle_t** handle_ptr
);

/* Free a machine handle and all associated resources. */
void orca_free(orca_handle_t* handle);

/* Dispatch an event to the machine. Synchronous — processes immediately.
 * Returns ORCA_OK on success. */
int orca_send(
    orca_handle_t* handle,
    const char* event_json,
    size_t event_len
);

/* Block until the machine reaches an idle state.
 * No-op for synchronous executor — always returns ORCA_OK. */
int orca_wait(orca_handle_t* handle);

/* Convenience: send an event and block until idle.
 * Equivalent to orca_send + orca_wait. */
int orca_send_and_wait(
    orca_handle_t* handle,
    const char* event_json,
    size_t event_len
);

/* Poll the machine.
 * Returns: 0 = idle/done, 1 = busy, negative = error.
 * Synchronous executor always returns 0. */
int32_t orca_poll(orca_handle_t* handle);

/* Get current machine state as JSON.
 * Caller provides buf[buf_len]; actual size written to *actual_len.
 * Buffer is null-terminated if space allows. */
int orca_state(
    orca_handle_t* handle,
    char* buf,
    size_t buf_len,
    size_t* actual_len
);

/* Action callback type.
 * Receives context and event as JSON C strings.
 * Returns a JSON C string with context delta (merged into context).
 * Returned pointer must remain valid until the next call. */
typedef const char* (*orca_action_fn)(
    const char* context_json,
    const char* event_json
);

/* Register an action callback (C function pointer). */
int orca_register_action(
    orca_handle_t* handle,
    const char* action_name,
    orca_action_fn callback
);

/* Effect handler callback type.
 * Takes effect name + input JSON, returns a JSON result string.
 * Returned pointer is owned by callee — caller must not retain it. */
typedef char* (*orca_effect_fn)(
    const char* effect_name,
    const char* input_json
);

/* Register an effect handler with the machine's effect registry. */
int orca_register_effect(
    orca_handle_t* handle,
    const char* effect_name,
    orca_effect_fn handler_fn
);

/* Serialize the current machine state to a JSON snapshot string.
 * Caller owns the returned string — free with orca_free_string. */
char* orca_snapshot(orca_handle_t* handle);

/* Restore machine state from a JSON snapshot string. */
int orca_restore(
    orca_handle_t* handle,
    const char* snapshot_json,
    size_t json_len
);

/* Free a string allocated by orca_snapshot. */
void orca_free_string(char* s);

/* Transition callback type.
 * Called after every successful state transition.
 * All strings are null-terminated and valid only for the duration of the call. */
typedef void (*orca_transition_fn)(
    const char* from_state,
    const char* to_state,
    const char* event
);

/* Register a transition callback (C function pointer).
 * Called after every successful state transition with (from, to, event). */
int orca_on_transition(
    orca_handle_t* handle,
    orca_transition_fn callback
);

/* Set a JSONL log file for audit logging of transitions.
 * Creates parent directories and opens in append mode. */
int orca_set_log_file(
    orca_handle_t* handle,
    const char* path,
    size_t path_len
);

/* Set the run ID used in log entries. */
int orca_set_run_id(
    orca_handle_t* handle,
    const char* id,
    size_t id_len
);

/* Get the last error message (valid until next call on this handle). */
const char* orca_last_error(orca_handle_t* handle);

#ifdef __cplusplus
}
#endif

#endif /* RUN_ORCA_FFI_H */
