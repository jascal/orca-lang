# machine KeyExchangeCoordinator

## context

| Field          | Type   | Default |
|----------------|--------|---------|
| sessionId      | string |         |
| exchangeStatus | string | "idle"  |
| error          | string |         |

## events

- start_exchange
- exchange_complete
- exchange_failed

## state idle [initial]
> Waiting to start the key exchange
- ignore: exchange_complete, exchange_failed

## state coordinating
> Invoking client and server machines for key exchange
- invoke: KeyExchangeClient
- on_done: exchange_complete
- on_error: exchange_failed
- ignore: start_exchange

## state done [final]
> Key exchange completed successfully

## state failed [final]
> Key exchange failed

## transitions

| Source       | Event             | Guard | Target       | Action       |
|--------------|-------------------|-------|--------------|--------------|
| idle         | start_exchange    |       | coordinating | init_session |
| coordinating | exchange_complete |       | done         | mark_success |
| coordinating | exchange_failed   |       | failed       | mark_failed  |

## actions

| Name         | Signature          |
|--------------|--------------------|
| init_session | `(ctx) -> Context` |
| mark_success | `(ctx) -> Context` |
| mark_failed  | `(ctx) -> Context` |

---

# machine KeyExchangeClient

## context

| Field           | Type   | Default |
|-----------------|--------|---------|
| sessionId       | string |         |
| serverPublicKey | string |         |
| sessionKey      | string |         |

## events

- start
- server_hello_ack
- client_key_sent
- ack_received
- error

## state idle [initial]
> Client idle, ready to start
- ignore: server_hello_ack, client_key_sent, ack_received, error

## state waiting_server_key
> Sent hello, waiting for server public key
- on_entry: send_hello
- timeout: 10s -> error_state
- ignore: start, client_key_sent, ack_received

## state sending_client_key
> Received server key, sending encrypted client key
- on_entry: send_encrypted_key
- timeout: 10s -> error_state
- ignore: start, server_hello_ack, ack_received

## state waiting_final_ack
> Sent client key, waiting for acknowledgment
- timeout: 10s -> error_state
- ignore: start, server_hello_ack, client_key_sent

## state established [final]
> Key exchange complete

## state error_state [final]
> Key exchange failed

## transitions

| Source             | Event            | Guard | Target             | Action             |
|--------------------|------------------|-------|--------------------|--------------------|
| idle               | start            |       | waiting_server_key |                    |
| waiting_server_key | server_hello_ack |       | sending_client_key | receive_server_key |
| waiting_server_key | error            |       | error_state        |                    |
| sending_client_key | client_key_sent  |       | waiting_final_ack  |                    |
| sending_client_key | error            |       | error_state        |                    |
| waiting_final_ack  | ack_received     |       | established        | finalize_exchange  |
| waiting_final_ack  | error            |       | error_state        |                    |

## actions

| Name               | Signature                                  |
|--------------------|--------------------------------------------|
| send_hello         | `(ctx) -> Context + Effect<SendHello>`     |
| receive_server_key | `(ctx, event) -> Context`                  |
| send_encrypted_key | `(ctx) -> Context + Effect<SendClientKey>` |
| finalize_exchange  | `(ctx, event) -> Context`                  |

---

# machine KeyExchangeServer

## context

| Field            | Type   | Default |
|------------------|--------|---------|
| serverPrivateKey | string |         |
| serverPublicKey  | string |         |
| clientPublicKey  | string |         |
| sessionKey       | string |         |

## events

- hello_received
- client_key_received
- ack_sent
- error

## state listening [initial]
> Listening for client hello
- ignore: client_key_received, ack_sent, error

## state waiting_client_key
> Sent public key, waiting for encrypted client key
- on_entry: send_public_key
- timeout: 10s -> error_state
- ignore: hello_received, ack_sent

## state sending_ack
> Received client key, sending acknowledgment
- on_entry: send_ack
- timeout: 10s -> error_state
- ignore: hello_received, client_key_received

## state established [final]
> Key exchange complete

## state error_state [final]
> Key exchange failed

## transitions

| Source             | Event               | Guard | Target             | Action              |
|--------------------|---------------------|-------|--------------------|---------------------|
| listening          | hello_received      |       | waiting_client_key | store_session_id    |
| waiting_client_key | client_key_received |       | sending_ack        | compute_session_key |
| waiting_client_key | error               |       | error_state        |                     |
| sending_ack        | ack_sent            |       | established        | finalize_exchange   |
| sending_ack        | error               |       | error_state        |                     |

## actions

| Name                | Signature                                  |
|---------------------|--------------------------------------------|
| store_session_id    | `(ctx, event) -> Context`                  |
| send_public_key     | `(ctx) -> Context + Effect<SendPublicKey>` |
| compute_session_key | `(ctx, event) -> Context`                  |
| send_ack            | `(ctx) -> Context + Effect<SendAck>`       |
| finalize_exchange   | `(ctx, event) -> Context`                  |
