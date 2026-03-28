"""
Multi-machine training lab driver.

Drives the TrainingLab state machine, recursively invoking child machines
(DataPipeline, HyperSearch, TrainingRun, Evaluator) as the parent enters
invoke states.

Parallel invoke states (like HyperSearch's `running`) are driven with
asyncio.gather so both child machines run concurrently. Region-prefixed
result keys (e.g. trial_a_val_loss, trial_b_val_loss) prevent results
from the two trials overwriting each other.
"""

import asyncio
import time
from typing import Any

from orca_runtime_python import OrcaMachine, EventBus
from orca_runtime_python.types import InvokeDef, MachineDef, StateValue

from .handlers.data_pipeline import check_data, prepare_data
from .handlers.training import (
    configure_run,
    run_training,
    configure_trials,
    compare_trials,
)
from .handlers.evaluation import evaluate_model, generate_samples
from .display.terminal import (
    print_banner,
    print_machine_start,
    print_transition,
    print_machine_done,
    print_summary,
)


# Terminal states for every machine in the pipeline
FINAL_STATES = frozenset({
    "completed", "failed",   # TrainingLab
    "ready", "error",        # DataPipeline
    "selected", "exhausted", # HyperSearch
    "converged",             # TrainingRun
    "done",                  # Evaluator
})

# Shared handler registry — covers every action in every machine
ACTION_REGISTRY: dict[str, Any] = {
    "check_data": check_data,
    "prepare_data": prepare_data,
    "configure_run": configure_run,
    "run_training": run_training,
    "configure_trials": configure_trials,
    "compare_trials": compare_trials,
    "evaluate_model": evaluate_model,
    "generate_samples": generate_samples,
}


def _leaf(state: StateValue) -> str:
    return str(state.leaf()) if hasattr(state, "leaf") else str(state)


def _get_parallel_parent(machine: OrcaMachine) -> str | None:
    """
    If the machine is currently inside a parallel state, return that
    state's name. Otherwise return None.
    """
    if not machine.state.is_compound():
        return None
    if isinstance(machine.state.value, dict):
        for state_name in machine.state.value:
            state_def = machine._find_state_def(state_name)
            if state_def and state_def.parallel:
                return state_name
    return None


def _build_child_context(
    invoke_def: InvokeDef,
    parent_ctx: dict[str, Any],
    child_def: MachineDef,
) -> dict[str, Any]:
    """
    Build the initial context for a child machine invocation.

    1. Start from the child machine's declared defaults.
    2. Copy any field the parent has that the child also declares (same name).
    3. Apply the explicit input mapping from invoke_def.input, which
       overrides step 2 for mapped keys (e.g. n_layer: ctx.trial_a_n_layer).
    """
    ctx = dict(child_def.context)

    # Step 2: inherit matching fields from parent
    for k, v in parent_ctx.items():
        if k in ctx:
            ctx[k] = v

    # Step 3: apply explicit input overrides
    if invoke_def.input:
        for child_key, parent_ref in invoke_def.input.items():
            parent_field = parent_ref.replace("ctx.", "")
            if parent_field in parent_ctx:
                ctx[child_key] = parent_ctx[parent_field]

    return ctx


def _next_event_for(
    machine_name: str, state: str, ctx: dict[str, Any]
) -> str | None:
    """
    Determine the event to send after a state's on_entry action has run.

    Returns None for invoke states (child machine drives the transition)
    and for parallel states (handled separately by _drive_parallel_invokes).
    """
    if ctx.get("error_message"):
        return "ERROR"

    if machine_name == "TrainingLab":
        if state == "idle":
            return "START"
        # invoke states return None — handled by child drive

    elif machine_name == "DataPipeline":
        if state == "checking":
            return "DATA_EXISTS" if ctx.get("data_exists") else "DATA_MISSING"
        if state == "downloading":
            return "PREPARED"

    elif machine_name == "HyperSearch":
        if state == "configuring":
            return "SEARCH_START"
        if state == "comparing":
            return "SELECTED"
        # "running" is a parallel state — handled by _drive_parallel_invokes

    elif machine_name == "TrainingRun":
        if state == "configuring":
            return "CONFIG_DONE"
        if state == "training":
            return "TRAINED"

    elif machine_name == "Evaluator":
        if state == "evaluating":
            return "EVAL_DONE"
        if state == "generating":
            return "GENERATED"

    return None


async def _drive_parallel_invokes(
    machine: OrcaMachine,
    parallel_state_name: str,
    all_defs: dict[str, MachineDef],
    bus: EventBus,
    verbose: bool,
    depth: int,
) -> None:
    """
    Drive all invoke states inside a parallel state's regions concurrently.

    For each region that has an invoke state, runs the child machine and
    stores results back into the parent's context using the region name as
    a key prefix (e.g. "trial_a" → trial_a_val_loss). When each child
    finishes, sends on_done/on_error to the parent to advance that region.

    After all coroutines complete the parallel sync condition is met, so
    the runtime auto-transitions the parent to its on_done state.
    """
    parallel_def = machine._find_state_def(parallel_state_name)
    if not parallel_def or not parallel_def.parallel:
        return

    # Fields that are per-trial and should be prefixed, not merged flat
    PER_TRIAL_FIELDS = {"val_loss", "train_loss", "best_val_loss",
                        "iter_num", "config_path", "error_message"}

    async def run_one_region(
        region_name: str,
        invoke_state_name: str,
        invoke_def: InvokeDef,
    ) -> None:
        child_def = all_defs[invoke_def.machine]
        child_ctx = _build_child_context(invoke_def, dict(machine.context), child_def)

        child_final, child_output = await _drive_machine(
            invoke_def.machine,
            all_defs,
            bus,
            child_ctx,
            verbose=verbose,
            depth=depth + 1,
        )

        # Store per-trial outputs with region prefix to avoid collision
        for field, value in child_output.items():
            prefixed = f"{region_name}_{field}"
            if prefixed in machine.context:
                machine.context[prefixed] = value

        # Merge non-conflicting fields (vendor_dir, device, etc.) back
        for k, v in child_output.items():
            if k in machine.context and k not in PER_TRIAL_FIELDS:
                machine.context[k] = v

        # Determine which event to fire
        error_finals = {
            s.name for s in child_def.states
            if s.is_final and s.name in ("error", "failed")
        }
        child_errored = child_final in error_finals
        event = (
            invoke_def.on_error
            if child_errored and invoke_def.on_error
            else invoke_def.on_done
        )
        if event:
            await machine.send(event)

    # Collect all (region_name, invoke_state_name, invoke_def) triples
    tasks = []
    for region in parallel_def.parallel.regions:
        for reg_state in region.states:
            sd = machine._find_state_def(reg_state.name)
            if sd and sd.invoke:
                tasks.append((region.name, reg_state.name, sd.invoke))

    await asyncio.gather(*(run_one_region(*t) for t in tasks))


async def _drive_machine(
    machine_name: str,
    all_defs: dict[str, MachineDef],
    bus: EventBus,
    parent_ctx: dict[str, Any],
    verbose: bool,
    depth: int,
) -> tuple[str, dict[str, Any]]:
    """
    Recursively drive a machine to a final state.

    Returns (final_state_name, final_context).
    """
    defn = all_defs[machine_name]
    start_time = time.time()

    ctx = _build_child_context(
        InvokeDef(machine=machine_name),  # no input map at top level
        parent_ctx,
        defn,
    )

    machine = OrcaMachine(defn, event_bus=bus, context=ctx)
    for name, handler in ACTION_REGISTRY.items():
        machine.register_action(name, handler)

    if verbose:
        print_machine_start(machine_name, depth)

    # start() executes on_entry for the initial state
    await machine.start()

    # Compute the first event based on what just ran
    initial_state = _leaf(machine.state)
    parallel_name = _get_parallel_parent(machine)
    if parallel_name:
        next_event: str | None = None  # parallel block handles it
    elif machine._find_state_def(initial_state) and \
            machine._find_state_def(initial_state).invoke:
        next_event = None  # invoke block handles it
    else:
        next_event = _next_event_for(machine_name, initial_state, machine.context)

    prev_state = initial_state

    while _leaf(machine.state) not in FINAL_STATES:
        # ── Parallel state ──────────────────────────────────────────
        parallel_name = _get_parallel_parent(machine)
        if parallel_name:
            await _drive_parallel_invokes(
                machine, parallel_name, all_defs, bus, verbose, depth
            )
            # Runtime auto-transitioned to on_done state; compute next event
            new_state = _leaf(machine.state)
            if verbose and new_state != prev_state:
                print_transition(machine_name, prev_state, new_state, depth)
            prev_state = new_state
            sd = machine._find_state_def(new_state)
            next_event = (
                None if (sd and sd.invoke)
                else _next_event_for(machine_name, new_state, machine.context)
            )
            continue

        # ── Sequential invoke state ─────────────────────────────────
        current = _leaf(machine.state)
        sd = machine._find_state_def(current)
        if sd and sd.invoke:
            child_def = all_defs[sd.invoke.machine]
            child_ctx = _build_child_context(sd.invoke, dict(machine.context), child_def)

            child_final, child_output = await _drive_machine(
                sd.invoke.machine, all_defs, bus, child_ctx, verbose, depth + 1
            )

            # Merge child output back to parent
            for k in list(machine.context):
                if k in child_output:
                    machine.context[k] = child_output[k]

            error_finals = {
                s.name for s in child_def.states
                if s.is_final and s.name in ("error", "failed")
            }
            child_errored = child_final in error_finals
            next_event = (
                sd.invoke.on_error
                if child_errored and sd.invoke.on_error
                else sd.invoke.on_done
            )

        # ── Send next event ─────────────────────────────────────────
        if not next_event:
            break

        result = await machine.send(next_event)
        if not result.taken:
            if verbose:
                print(f"  Warning: {next_event} not accepted "
                      f"from {_leaf(machine.state)}: {result.error}")
            break

        new_state = _leaf(machine.state)
        if verbose and new_state != prev_state:
            print_transition(machine_name, prev_state, new_state, depth)
        prev_state = new_state

        # Compute next event for the new state
        new_sd = machine._find_state_def(new_state)
        new_parallel = _get_parallel_parent(machine)
        if new_parallel:
            next_event = None  # parallel block in next iteration
        elif new_sd and new_sd.invoke:
            next_event = None  # invoke block in next iteration
        else:
            next_event = _next_event_for(machine_name, new_state, machine.context)

    elapsed = time.time() - start_time
    final_state = _leaf(machine.state)

    if verbose:
        print_machine_done(machine_name, final_state, elapsed, depth)

    await machine.stop()
    return final_state, dict(machine.context)


async def run_pipeline(
    all_defs: dict[str, MachineDef],
    init_ctx: dict[str, Any],
    verbose: bool = True,
) -> dict[str, Any]:
    """
    Run the complete TrainingLab pipeline.

    Args:
        all_defs:  Dict mapping machine name → MachineDef (all 5 machines).
        init_ctx:  Initial context overrides for TrainingLab.
        verbose:   Whether to print progress.

    Returns:
        Final context dict with '_final_state' key added.
    """
    start_time = time.time()

    if verbose:
        print_banner()

    bus = EventBus()

    final_state, final_ctx = await _drive_machine(
        "TrainingLab",
        all_defs,
        bus,
        init_ctx,
        verbose=verbose,
        depth=0,
    )

    elapsed = time.time() - start_time
    final_ctx["_final_state"] = final_state

    if verbose:
        print_summary(final_ctx, elapsed)

    return final_ctx
