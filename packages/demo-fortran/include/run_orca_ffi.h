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

/* Effect handler callback type. */
typedef const char* (*orca_effect_fn)(
    const char* effect_name,
    const char* input_json
);

/* Register an effect handler. No-op stub in v1. */
int orca_register_effect(
    orca_handle_t* handle,
    const char* effect_name,
    orca_effect_fn handler_fn
);

/* Get the last error message (valid until next call on this handle). */
const char* orca_last_error(orca_handle_t* handle);

#ifdef __cplusplus
}
#endif

#endif /* RUN_ORCA_FFI_H */
