# machine StepImplementer

## context

| Field         | Type   | Default |
|---------------|--------|---------|
| step          | object |         |
| repo_root     | string |         |
| dry_run       | bool   | false   |
| context_files | array  | []      |
| file_changes  | array  | []      |
| test_output   | string |         |
| retry_count   | int    | 0       |
| commit_message| string |         |
| error         | string |         |

## events

- start
- context_ready
- changes_ready
- changes_applied
- tests_passed
- tests_failed
- fail

## guards

| Name      | Expression            |
|-----------|-----------------------|
| can_retry | `ctx.retry_count < 2` |

## state idle [initial]
> Waiting to begin

## state gathering_context
> Reading relevant source files to build context for the LLM
- on_entry: gather_context

## state generating_changes
> Calling the LLM to generate file changes for this step
- on_entry: generate_changes

## state applying_changes
> Writing file changes to disk
- on_entry: apply_changes

## state running_tests
> Running the project test suite to validate changes
- on_entry: run_tests

## state done [final]
> Step successfully implemented and tests pass

## state failed [final]
> Step implementation failed after exhausting retries

## transitions

| Source             | Event           | Guard     | Target             | Action          |
|--------------------|-----------------|-----------|--------------------|-----------------
| idle               | start           |           | gathering_context  |                 |
| gathering_context  | context_ready   |           | generating_changes |                 |
| gathering_context  | fail            |           | failed             | record_error    |
| generating_changes | changes_ready   |           | applying_changes   |                 |
| generating_changes | fail            |           | failed             | record_error    |
| applying_changes   | changes_applied |           | running_tests      |                 |
| applying_changes   | fail            |           | failed             | record_error    |
| running_tests      | tests_passed    |           | done               |                 |
| running_tests      | tests_failed    | can_retry | generating_changes | increment_retry |
| running_tests      | tests_failed    | !can_retry| failed             | record_error    |

## actions

| Name            | Signature            |
|-----------------|----------------------|
| gather_context  | `(ctx) -> Context`   |
| generate_changes| `(ctx) -> Context`   |
| apply_changes   | `(ctx) -> Context`   |
| run_tests       | `(ctx) -> Context`   |
| increment_retry | `(ctx) -> Context`   |
| record_error    | `(ctx) -> Context`   |
