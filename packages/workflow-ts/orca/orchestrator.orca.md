# machine PhaseOrchestrator

## context

| Field           | Type   | Default |
|-----------------|--------|---------|
| phase_file      | string |         |
| steps           | array  | []      |
| current_step_idx| int    | -1      |
| current_step    | object |         |
| dry_run         | bool   | false   |
| filter_step     | string |         |
| completed_steps | array  | []      |
| skipped_steps   | array  | []      |
| step_changes    | array  | []      |
| commit_message  | string |         |
| error           | string |         |
| pr_url          | string |         |

## events

- start
- phase_loaded
- step_selected
- all_steps_done
- step_implemented
- step_skipped
- step_committed
- pr_created
- fail

## state idle [initial]
> Waiting to begin

## state loading_phase
> Parsing the phase document to extract steps
- on_entry: load_phase_doc

## state selecting_step
> Selecting the next pending step
- on_entry: select_next_step

## state implementing_step
> Running the step implementer for the current step
- on_entry: implement_current_step

## state committing_step
> Committing the completed step to git
- on_entry: commit_step

## state creating_pr
> Creating a pull request for all completed steps
- on_entry: create_pr

## state done [final]
> All steps processed successfully

## state failed [final]
> Workflow aborted due to unrecoverable error

## transitions

| Source            | Event           | Target            | Action           |
|-------------------|-----------------|-------------------|------------------|
| idle              | start           | loading_phase     |                  |
| loading_phase     | phase_loaded    | selecting_step    |                  |
| loading_phase     | fail            | failed            | record_error     |
| selecting_step    | step_selected   | implementing_step |                  |
| selecting_step    | all_steps_done  | creating_pr       |                  |
| implementing_step | step_implemented| committing_step   |                  |
| implementing_step | step_skipped    | selecting_step    |                  |
| implementing_step | fail            | selecting_step    | log_step_failure |
| committing_step   | step_committed  | selecting_step    |                  |
| committing_step   | fail            | failed            | record_error     |
| creating_pr       | pr_created      | done              |                  |
| creating_pr       | fail            | done              | log_pr_failure   |

## actions

| Name               | Signature            |
|--------------------|----------------------|
| load_phase_doc     | `(ctx) -> Context`   |
| select_next_step   | `(ctx) -> Context`   |
| implement_current_step | `(ctx) -> Context` |
| commit_step        | `(ctx) -> Context`   |
| create_pr          | `(ctx) -> Context`   |
| record_error       | `(ctx) -> Context`   |
| log_step_failure   | `(ctx) -> Context`   |
| log_pr_failure     | `(ctx) -> Context`   |
