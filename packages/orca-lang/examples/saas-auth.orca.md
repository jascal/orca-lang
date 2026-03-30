# machine SaaSAuth

## context

| Field             | Type   | Default |
|-------------------|--------|---------|
| email             | string | ""      |
| verified          | bool   | false   |
| failed_attempts   | int    | 0       |
| session_id        | string | ""      |

## events

- register
- verify_email
- login
- logout
- request_password_reset
- reset_password
- unlock_account

## state anonymous [initial]
> User is not authenticated
- ignore: verify_email, logout, request_password_reset, reset_password, unlock_account

## state registration_started
> User has begun registration
- ignore: register, login, logout, request_password_reset, reset_password, unlock_account

## state email_verification_pending
> Awaiting email verification
- ignore: register, login, logout, request_password_reset, reset_password, unlock_account

## state fully_registered
> Registration complete, not yet logged in
- ignore: register, verify_email, logout, request_password_reset, reset_password, unlock_account

## state login_in_progress
> Login attempt in progress
- ignore: register, verify_email, logout, request_password_reset, reset_password, unlock_account

## state authenticated
> User has an active session
- ignore: register, verify_email, login, reset_password, unlock_account

## state password_reset_requested
> Password reset requested
- ignore: register, verify_email, login, logout, request_password_reset, unlock_account

## state password_reset_pending
> New password being set
- ignore: register, verify_email, login, logout, request_password_reset, unlock_account

## state account_locked
> Account temporarily locked
- ignore: register, verify_email, login, logout, request_password_reset, reset_password

## transitions

| Source                    | Event                 | Guard              | Target                  | Action                   |
|---------------------------|-----------------------|--------------------|-------------------------|--------------------------|
| anonymous                 | register              |                    | registration_started    | set_email                |
| registration_started      | verify_email          |                   | email_verification_pending |                      |
| email_verification_pending| verify_email          | code_valid         | fully_registered        | mark_verified            |
| email_verification_pending| verify_email          | !code_valid        | email_verification_pending | increment_failed_attempts|
| fully_registered          | login                 |                    | login_in_progress       |                          |
| login_in_progress        | login                 | credentials_valid  | authenticated           | reset_failed_attempts    |
| login_in_progress        | login                 | !credentials_valid | anonymous               | increment_failed_attempts|
| login_in_progress        | login                 | failed_too_many    | account_locked          | lock_account             |
| authenticated            | logout                |                    | anonymous               | clear_session            |
| authenticated            | request_password_reset |                   | password_reset_requested| send_reset_link         |
| password_reset_requested | reset_password        |                    | password_reset_pending  |                          |
| password_reset_pending    | reset_password        | new_password_valid | authenticated           | update_password          |
| password_reset_pending    | reset_password        | !new_password_valid| password_reset_pending  | increment_failed_attempts|
| anonymous                | login                 |                    | login_in_progress       |                          |
| account_locked           | unlock_account        | unlock_expired     | anonymous               |                          |
| account_locked           | unlock_account        | !unlock_expired    | login_in_progress       |                          |

## guards

| Name               | Expression                    |
|--------------------|-------------------------------|
| code_valid         | `true`                        |
| credentials_valid  | `true`                        |
| failed_too_many    | `ctx.failed_attempts >= 5`    |
| new_password_valid | `true`                        |
| unlock_expired     | `false`                       |

## actions

| Name                  | Signature                    |
|-----------------------|------------------------------|
| set_email             | `(ctx, event) -> Context`    |
| mark_verified         | `(ctx) -> Context`            |
| increment_failed_attempts | `(ctx) -> Context`         |
| reset_failed_attempts | `(ctx) -> Context`            |
| lock_account          | `(ctx) -> Context`            |
| clear_session         | `(ctx) -> Context`            |
| send_reset_link       | `(ctx, event) -> Context`     |
| update_password       | `(ctx, event) -> Context`     |
