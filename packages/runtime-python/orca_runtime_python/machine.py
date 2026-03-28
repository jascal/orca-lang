"""
Orca state machine runtime.

Async state machine that executes Orca machine definitions,
publishing state changes to an event bus and executing effects
via registered handlers.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .types import (
    MachineDef,
    StateDef,
    StateValue,
    Transition,
    Effect,
    EffectResult,
    EffectStatus,
    ActionSignature,
    GuardExpression,
    GuardTrue,
    GuardFalse,
    GuardCompare,
    GuardAnd,
    GuardOr,
    GuardNot,
    GuardNullcheck,
    VariableRef,
    ValueRef,
    InvokeDef,
)
from .bus import EventBus, Event, EventType, get_event_bus


# Type alias for transition callback
TransitionCallback = Callable[[StateValue, StateValue], Awaitable[None]]

# Action handler: (context, event_payload?) -> context_updates or None
ActionHandler = Callable[..., Any]  # async (dict, dict|None) -> dict|None


@dataclass
class TransitionResult:
    """Result of a transition attempt."""
    taken: bool
    from_state: str
    to_state: str | None = None
    guard_failed: bool = False
    error: str | None = None


class OrcaMachine:
    """
    Async Orca state machine runtime.

    Executes Orca machine definitions with:
    - Event-driven transitions
    - Hierarchical (nested) state support
    - Effect execution via event bus
    - Guard condition evaluation

    All methods are async. The machine must be started before
    sending events.

    Example:
        machine = OrcaMachine(definition, event_bus=get_event_bus())
        await machine.start()
        await machine.send("ORDER_PLACED", {"order_id": "123"})
        print(machine.state)
        await machine.stop()
    """

    def __init__(
        self,
        definition: MachineDef,
        event_bus: EventBus | None = None,
        context: dict[str, Any] | None = None,
        on_transition: TransitionCallback | None = None,
    ):
        self.definition = definition
        self.event_bus = event_bus or get_event_bus()
        self.context = context or dict(definition.context)
        self.on_transition = on_transition

        # Internal state
        self._state: StateValue = StateValue(self._get_initial_state())
        self._active: bool = False
        self._action_handlers: dict[str, ActionHandler] = {}
        self._timeout_task: asyncio.Task | None = None

        # Child machine management
        self._child_machines: dict[str, OrcaMachine] = {}
        self._sibling_machines: dict[str, MachineDef] | None = None
        self._active_invoke: str | None = None

    def _get_initial_state(self) -> str:
        """Find the initial state name."""
        for state in self.definition.states:
            if state.is_initial:
                return state.name
        # Fallback to first state
        if self.definition.states:
            return self.definition.states[0].name
        return "unknown"

    @property
    def state(self) -> StateValue:
        """Current state value."""
        return self._state

    @property
    def is_active(self) -> bool:
        """Whether the machine is running."""
        return self._active

    def snapshot(self) -> dict[str, Any]:
        """
        Capture the current machine state as a serializable snapshot.
        The snapshot includes state value, context, and timestamp.
        Child machine snapshots are included.
        Action handlers are NOT included — re-register them after restore.
        """
        import copy
        import time
        state_val = self._state.value
        return {
            "state": copy.deepcopy(state_val),
            "context": copy.deepcopy(self.context),
            "children": {k: m.snapshot() for k, m in self._child_machines.items()},
            "active_invoke": self._active_invoke,
            "timestamp": time.time(),
        }

    async def restore(self, snap: dict[str, Any]) -> None:
        """
        Restore machine state from a previously captured snapshot.
        Action handlers must be re-registered after restore.
        """
        import copy
        # Cancel any active timeout
        self._cancel_timeout()

        # Restore state and context
        self._state = StateValue(copy.deepcopy(snap["state"]))
        self.context = copy.deepcopy(snap["context"])

        # If machine was active, restart timeouts for current leaf states
        if self._active:
            for leaf in self._state.leaves():
                self._start_timeout_for_state(leaf)

    async def resume(self, snap: dict[str, Any]) -> None:
        """
        Boot the machine from a saved snapshot, skipping on_entry for the
        restored state.  Use instead of start() when resuming a crashed run.

        Unlike restore() (which is a live-machine primitive), resume() is the
        cold-start path: the machine was inactive, a snapshot was found on
        disk, and we want to continue from where we left off without
        re-executing the actions that already ran before the crash.
        """
        import copy
        if self._active:
            return

        self._state = StateValue(copy.deepcopy(snap["state"]))
        self.context = copy.deepcopy(snap["context"])
        self._active = True

        await self.event_bus.publish(Event(
            type=EventType.MACHINE_STARTED,
            source=self.definition.name,
            payload={
                "machine": self.definition.name,
                "initial_state": self._state.value,
                "resumed": True,
            }
        ))

        for leaf in self._state.leaves():
            self._start_timeout_for_state(leaf)

    def register_machines(self, machines: dict[str, MachineDef]) -> None:
        """Register sibling machines for invocation."""
        self._sibling_machines = machines

    async def start_child_machine(self, state_name: str, invoke_def: InvokeDef) -> None:
        """Start a child machine as part of an invoke state."""
        if self._sibling_machines is None:
            return
        if invoke_def.machine not in self._sibling_machines:
            return

        child_def = self._sibling_machines[invoke_def.machine]

        # Map input from parent context
        child_context = dict(child_def.context)
        if invoke_def.input:
            for key, value in invoke_def.input.items():
                field_name = value.replace("ctx.", "")
                child_context[key] = self.context.get(field_name)

        # Create child machine
        child = OrcaMachine(
            definition=child_def,
            event_bus=self.event_bus,
            context=child_context,
        )
        self._child_machines[state_name] = child
        self._active_invoke = state_name

        # Set up completion/error listeners
        async def on_transition_handler(old: StateValue, new: StateValue) -> None:
            if new.is_compound():
                return
            child_state = new.leaf()
            child_state_def = child._find_state_def(child_state)
            if child_state_def and child_state_def.is_final:
                # Child reached final state
                if invoke_def.on_done:
                    await self.send(invoke_def.on_done, {
                        "child": invoke_def.machine,
                        "final_state": child_state,
                        "context": child.context,
                    })
                await child.stop()
                self._child_machines.pop(state_name, None)
                if self._active_invoke == state_name:
                    self._active_invoke = None

        child.on_transition = on_transition_handler
        await child.start()

    async def stop_child_machine(self, state_name: str) -> None:
        """Stop a child machine associated with a state."""
        if self._active_invoke == state_name:
            child = self._child_machines.get(state_name)
            if child:
                await child.stop()
                self._child_machines.pop(state_name, None)
            self._active_invoke = None

    def register_action(self, name: str, handler: ActionHandler) -> None:
        """Register a handler for a plain (non-effect) action."""
        self._action_handlers[name] = handler

    def unregister_action(self, name: str) -> None:
        """Unregister an action handler."""
        self._action_handlers.pop(name, None)

    async def start(self) -> None:
        """Start the state machine and execute initial state's on_entry."""
        if self._active:
            return

        self._active = True

        await self.event_bus.publish(Event(
            type=EventType.MACHINE_STARTED,
            source=self.definition.name,
            payload={
                "machine": self.definition.name,
                "initial_state": self._state.value,
            }
        ))

        # Execute entry actions for initial state
        await self._execute_entry_actions(self._state.leaf())

        # Start timeout for initial state if defined
        self._start_timeout_for_state(self._state.leaf())

    async def stop(self) -> None:
        """Stop the state machine."""
        if not self._active:
            return

        self._cancel_timeout()

        # Stop all child machines
        for child in list(self._child_machines.values()):
            await child.stop()
        self._child_machines.clear()
        self._active_invoke = None

        self._active = False

        await self.event_bus.publish(Event(
            type=EventType.MACHINE_STOPPED,
            source=self.definition.name,
        ))

    async def send(
        self,
        event: str | Event,
        payload: dict[str, Any] | None = None,
    ) -> TransitionResult:
        """
        Send an event to the machine.

        Args:
            event: Event name (str) or Event object
            payload: Optional payload for the event

        Returns:
            TransitionResult indicating what happened
        """
        if not self._active:
            return TransitionResult(
                taken=False,
                from_state=str(self._state),
                error="Machine is not active"
            )

        # Normalize to Event, preserving the original event name
        if isinstance(event, str):
            evt = Event(
                type=self._find_event_type(event),
                source=self.definition.name,
                event_name=event,  # Store original event name
                payload=payload or {}
            )
        else:
            evt = event

        # Check if event is explicitly ignored in current state
        event_key = evt.event_name or evt.type.value
        if self._is_event_ignored(event_key):
            return TransitionResult(
                taken=False,
                from_state=str(self._state),
            )

        # Find matching transition
        transition = self._find_transition(evt)

        if not transition:
            # No transition found - event unhandled
            return TransitionResult(
                taken=False,
                from_state=str(self._state),
                error=f"No transition for event {event_key} from {self._state.leaf()}"
            )

        # Evaluate guard if present
        if transition.guard:
            guard_passed = await self._evaluate_guard(transition.guard)
            if not guard_passed:
                return TransitionResult(
                    taken=False,
                    from_state=str(self._state),
                    guard_failed=True,
                    error=f"Guard '{transition.guard}' failed"
                )

        # Execute the transition
        old_state = StateValue(self._state.value)
        new_state_name = transition.target

        # Cancel any active timeout from the old state
        self._cancel_timeout()

        # Execute exit actions
        await self._execute_exit_actions(old_state.leaf())

        # Execute transition action
        if transition.action:
            await self._execute_action(transition.action, evt.payload)

        # Update state
        if self._is_parallel_state(new_state_name):
            self._state = StateValue(self._build_parallel_state_value(new_state_name))
        elif self._is_compound_state(new_state_name):
            # Enter compound state at its initial child
            initial_child = self._get_initial_child(new_state_name)
            self._state = StateValue({new_state_name: {initial_child: {}}})
        else:
            # Check if we're inside a parallel state and need to update just one region
            updated_in_region = self._try_update_parallel_region(new_state_name)
            if not updated_in_region:
                self._state = StateValue(new_state_name)

        # Publish transition started
        await self.event_bus.publish(Event(
            type=EventType.TRANSITION_STARTED,
            source=self.definition.name,
            payload={
                "from": str(old_state),
                "to": new_state_name,
                "trigger": evt.type.value,
            }
        ))

        # Execute entry actions for new state
        if self._is_parallel_state(new_state_name):
            # Execute entry actions for all region initial states
            state_def = self._find_state_def_deep(new_state_name)
            if state_def and state_def.parallel:
                for region in state_def.parallel.regions:
                    initial_child = next(
                        (s for s in region.states if s.is_initial),
                        region.states[0] if region.states else None
                    )
                    if initial_child:
                        await self._execute_entry_actions(initial_child.name)
        else:
            await self._execute_entry_actions(new_state_name)

        # Start timeout for all active leaf states
        for leaf in self._state.leaves():
            self._start_timeout_for_state(leaf)

        # Check parallel sync condition
        await self._check_parallel_sync()

        # Notify callback
        if self.on_transition:
            await self.on_transition(old_state, self._state)

        # Publish transition completed
        await self.event_bus.publish(Event(
            type=EventType.TRANSITION_COMPLETED,
            source=self.definition.name,
            payload={
                "from": str(old_state),
                "to": str(self._state),
            }
        ))

        return TransitionResult(
            taken=True,
            from_state=str(old_state),
            to_state=str(self._state)
        )

    def _find_event_type(self, event_name: str) -> EventType:
        """Map event name to EventType enum."""
        # Build a mapping from event names to event types
        event_type_map = {
            "state_changed": EventType.STATE_CHANGED,
            "transition_started": EventType.TRANSITION_STARTED,
            "transition_completed": EventType.TRANSITION_COMPLETED,
            "effect_executing": EventType.EFFECT_EXECUTING,
            "effect_completed": EventType.EFFECT_COMPLETED,
            "effect_failed": EventType.EFFECT_FAILED,
            "machine_started": EventType.MACHINE_STARTED,
            "machine_stopped": EventType.MACHINE_STOPPED,
        }

        # Check for direct event name match
        normalized = event_name.lower().replace("-", "_")
        if normalized in event_type_map:
            return event_type_map[normalized]

        # Check if it's a defined event in the machine
        for defined_event in self.definition.events:
            if defined_event.lower().replace("-", "_") == normalized:
                return EventType.STATE_CHANGED

        # Default fallback
        return EventType.STATE_CHANGED

    def _find_transition(self, event: Event) -> Transition | None:
        """Find a transition matching the current state and event."""
        event_key = event.event_name or event.type.value

        # Check all active leaf states (important for parallel states)
        for current in self._state.leaves():
            # Try direct match on current leaf state
            for t in self.definition.transitions:
                if t.source == current and t.event == event_key:
                    return t

            # For compound states, also check parent's transitions
            # Transitions on parent fire from any child
            parent = self._get_parent_state(current)
            while parent:
                for t in self.definition.transitions:
                    if t.source == parent and t.event == event_key:
                        return t
                parent = self._get_parent_state(parent)

        return None

    def _get_parent_state(self, state_name: str) -> str | None:
        """Get parent state name if state is nested (searches parallel regions too)."""
        def search(states: list[StateDef], parent_name: str | None = None) -> str | None:
            for state in states:
                if state.name == state_name:
                    return state.parent or parent_name
                if state.contains:
                    for child in state.contains:
                        if child.name == state_name:
                            return state.name
                    found = search(state.contains, state.name)
                    if found is not None:
                        return found
                if state.parallel:
                    for region in state.parallel.regions:
                        for child in region.states:
                            if child.name == state_name:
                                return state.name
            return None
        return search(self.definition.states)

    def _is_compound_state(self, state_name: str) -> bool:
        """Check if a state has nested children or parallel regions."""
        state = self._find_state_def_deep(state_name)
        if not state:
            return False
        return bool(state.contains) or bool(state.parallel)

    def _is_parallel_state(self, state_name: str) -> bool:
        """Check if a state has parallel regions."""
        state = self._find_state_def_deep(state_name)
        return bool(state and state.parallel)

    def _get_initial_child(self, parent_name: str) -> str:
        """Get the initial child state name of a compound state."""
        state = self._find_state_def_deep(parent_name)
        if state and state.contains:
            for child in state.contains:
                if child.is_initial:
                    return child.name
            return state.contains[0].name
        return parent_name

    def _build_parallel_state_value(self, state_name: str) -> dict:
        """Build the StateValue dict for entering a parallel state."""
        state = self._find_state_def_deep(state_name)
        if not state or not state.parallel:
            return {state_name: {}}
        regions = {}
        for region in state.parallel.regions:
            initial_child = next(
                (s for s in region.states if s.is_initial),
                region.states[0] if region.states else None
            )
            if initial_child:
                regions[region.name] = {initial_child.name: {}}
        return {state_name: regions}

    def _try_update_parallel_region(self, target_state_name: str) -> bool:
        """Update only the relevant region in a parallel state value."""
        if not isinstance(self._state.value, dict):
            return False
        for top_state in self.definition.states:
            if not top_state.parallel:
                continue
            for region in top_state.parallel.regions:
                in_region = any(s.name == target_state_name for s in region.states)
                if in_region and top_state.name in self._state.value:
                    self._state.value[top_state.name][region.name] = {target_state_name: {}}
                    return True
        return False

    def _all_regions_final(self, state_name: str) -> bool:
        """Check if all regions of a parallel state have reached final states."""
        state = self._find_state_def_deep(state_name)
        if not state or not state.parallel:
            return False
        current_leaves = self._state.leaves()
        for region in state.parallel.regions:
            final_names = [s.name for s in region.states if s.is_final]
            if not any(leaf in final_names for leaf in current_leaves):
                return False
        return True

    def _any_region_final(self, state_name: str) -> bool:
        """Check if any region of a parallel state has reached a final state."""
        state = self._find_state_def_deep(state_name)
        if not state or not state.parallel:
            return False
        current_leaves = self._state.leaves()
        for region in state.parallel.regions:
            final_names = [s.name for s in region.states if s.is_final]
            if any(leaf in final_names for leaf in current_leaves):
                return True
        return False

    async def _check_parallel_sync(self) -> None:
        """Check if any parallel state's sync condition is met and transition via on_done."""
        for state in self.definition.states:
            if not state.parallel or not state.on_done:
                continue
            sync = state.parallel.sync or "all-final"
            should_transition = False
            if sync == "all-final":
                should_transition = self._all_regions_final(state.name)
            elif sync == "any-final":
                should_transition = self._any_region_final(state.name)
            if should_transition:
                old_state = StateValue(self._state.value)
                self._cancel_timeout()
                self._state = StateValue(state.on_done)
                await self._execute_entry_actions(state.on_done)
                self._start_timeout_for_state(self._state.leaf())
                if self.on_transition:
                    await self.on_transition(old_state, self._state)

    async def _evaluate_guard(self, guard_name: str) -> bool:
        """Evaluate a guard by name."""
        # Guards are defined in definition.guards
        if guard_name not in self.definition.guards:
            return True  # Unknown guard = allow

        # Evaluate the guard expression
        guard_expr = self.definition.guards[guard_name]
        return await self._eval_guard(guard_expr)

    async def _eval_guard(self, expr: GuardExpression) -> bool:
        """Evaluate a guard expression against the machine context."""
        if isinstance(expr, GuardTrue):
            return True
        if isinstance(expr, GuardFalse):
            return False
        if isinstance(expr, GuardNot):
            return not await self._eval_guard(expr.expr)
        if isinstance(expr, GuardAnd):
            return await self._eval_guard(expr.left) and await self._eval_guard(expr.right)
        if isinstance(expr, GuardOr):
            return await self._eval_guard(expr.left) or await self._eval_guard(expr.right)
        if isinstance(expr, GuardCompare):
            return self._eval_compare(expr.op, expr.left, expr.right)
        if isinstance(expr, GuardNullcheck):
            return self._eval_nullcheck(expr.expr, expr.is_null)
        return True

    def _resolve_variable(self, ref: VariableRef) -> Any:
        """Resolve a variable path against the machine context."""
        current: Any = self.context
        for part in ref.path:
            # Skip "ctx" or "context" prefix — context is already the root
            if part in ("ctx", "context"):
                continue
            if current is None:
                return None
            if isinstance(current, dict):
                current = current.get(part)
            else:
                current = getattr(current, part, None)
        return current

    def _resolve_value(self, ref: ValueRef) -> Any:
        """Resolve a ValueRef to its Python value."""
        return ref.value

    def _eval_compare(self, op: str, left: VariableRef, right: ValueRef) -> bool:
        """Evaluate a comparison guard."""
        lhs = self._resolve_variable(left)
        rhs = self._resolve_value(right)

        # Try numeric comparison
        try:
            lnum = float(lhs) if not isinstance(lhs, (int, float)) else lhs
            rnum = float(rhs) if not isinstance(rhs, (int, float)) else rhs
            both_numeric = True
        except (TypeError, ValueError):
            both_numeric = False
            lnum = rnum = 0

        if op == "eq":
            return lhs == rhs
        if op == "ne":
            return lhs != rhs
        if op == "lt":
            return lnum < rnum if both_numeric else str(lhs) < str(rhs)
        if op == "gt":
            return lnum > rnum if both_numeric else str(lhs) > str(rhs)
        if op == "le":
            return lnum <= rnum if both_numeric else str(lhs) <= str(rhs)
        if op == "ge":
            return lnum >= rnum if both_numeric else str(lhs) >= str(rhs)
        return False

    def _eval_nullcheck(self, expr: VariableRef, is_null: bool) -> bool:
        """Evaluate a null check guard."""
        val = self._resolve_variable(expr)
        value_is_null = val is None
        return value_is_null if is_null else not value_is_null

    async def _execute_entry_actions(self, state_name: str) -> None:
        """Execute on_entry action for a state."""
        state_def = self._find_state_def(state_name)
        if not state_def:
            return

        # Handle invoke - start child machine if present
        if state_def.invoke:
            await self.start_child_machine(state_name, state_def.invoke)
            return  # Don't execute on_entry if invoke is set

        if not state_def.on_entry:
            return

        action_def = self._find_action_def(state_def.on_entry)
        if action_def and action_def.has_effect:
            # Execute as effect via event bus
            effect = Effect(
                type=action_def.effect_type or "Effect",
                payload={
                    "action": state_def.on_entry,
                    "context": self.context,
                    "event": None,
                }
            )

            await self.event_bus.publish(Event(
                type=EventType.EFFECT_EXECUTING,
                source=self.definition.name,
                payload={"effect": effect.type}
            ))

            result = await self.event_bus.execute_effect(effect)

            if result.status == EffectStatus.SUCCESS:
                await self.event_bus.publish(Event(
                    type=EventType.EFFECT_COMPLETED,
                    source=self.definition.name,
                    payload={"effect": effect.type, "result": result.data}
                ))
                if result.data:
                    if isinstance(result.data, dict):
                        self.context.update(result.data)
            else:
                await self.event_bus.publish(Event(
                    type=EventType.EFFECT_FAILED,
                    source=self.definition.name,
                    payload={"effect": effect.type, "error": result.error}
                ))
        else:
            # Simple action — call registered handler directly.
            # The ## actions section is optional documentation; if a handler
            # is registered we always call it regardless of action_def.
            await self._execute_action(state_def.on_entry)

    async def _execute_exit_actions(self, state_name: str) -> None:
        """Execute on_exit action for a state."""
        # Stop child machine if this state has an invoke
        await self.stop_child_machine(state_name)

        state_def = self._find_state_def(state_name)
        if not state_def or not state_def.on_exit:
            return
        await self._execute_action(state_def.on_exit)

    async def _execute_action(self, action_name: str, event_payload: dict[str, Any] | None = None) -> None:
        """Execute a non-effect action via registered handler."""
        handler = self._action_handlers.get(action_name)
        if handler is None:
            return  # No handler registered — skip silently

        result = handler(self.context, event_payload)
        # Support both sync and async handlers
        if asyncio.iscoroutine(result) or asyncio.isfuture(result):
            result = await result
        if result and isinstance(result, dict):
            self.context.update(result)

    def _start_timeout_for_state(self, state_name: str) -> None:
        """Start a timeout timer for the given state if it has one."""
        state_def = self._find_state_def(state_name)
        if not state_def or not state_def.timeout:
            return

        # Parse duration string like "1s" or "5" (strip non-numeric suffix)
        import re
        duration_match = re.match(r"(\d+)", state_def.timeout["duration"])
        duration_s = int(duration_match.group(1)) if duration_match else 0
        target = state_def.timeout["target"]

        async def _timeout_handler():
            await asyncio.sleep(duration_s)
            if self._active and self._state.leaf() == state_name:
                await self._execute_timeout_transition(state_name, target)

        self._timeout_task = asyncio.create_task(_timeout_handler())

    def _cancel_timeout(self) -> None:
        """Cancel any active timeout timer."""
        if self._timeout_task is not None:
            self._timeout_task.cancel()
            self._timeout_task = None

    async def _execute_timeout_transition(self, from_state: str, target: str) -> None:
        """Execute an automatic timeout transition."""
        old_state = StateValue(self._state.value)

        # Execute exit actions
        await self._execute_exit_actions(from_state)

        # Update state
        if self._is_parallel_state(target):
            self._state = StateValue(self._build_parallel_state_value(target))
        elif self._is_compound_state(target):
            initial_child = self._get_initial_child(target)
            self._state = StateValue({target: {initial_child: {}}})
        else:
            self._state = StateValue(target)

        await self.event_bus.publish(Event(
            type=EventType.TRANSITION_STARTED,
            source=self.definition.name,
            payload={
                "from": str(old_state),
                "to": target,
                "trigger": "timeout",
            }
        ))

        await self._execute_entry_actions(target)

        # Start timeout for all active leaf states
        for leaf in self._state.leaves():
            self._start_timeout_for_state(leaf)

        if self.on_transition:
            await self.on_transition(old_state, self._state)

        await self.event_bus.publish(Event(
            type=EventType.TRANSITION_COMPLETED,
            source=self.definition.name,
            payload={
                "from": str(old_state),
                "to": str(self._state),
            }
        ))

    def _is_event_ignored(self, event_name: str) -> bool:
        """Check if event is explicitly ignored in current state or parent states."""
        current = self._state.leaf()
        state_def = self._find_state_def(current)
        if state_def and event_name in state_def.ignored_events:
            return True
        # Also check parent state's ignored events
        parent = self._get_parent_state(current)
        while parent:
            parent_def = self._find_state_def(parent)
            if parent_def and event_name in parent_def.ignored_events:
                return True
            parent = self._get_parent_state(parent)
        return False

    def _find_state_def(self, state_name: str) -> StateDef | None:
        """Find state definition by name (including nested and parallel regions)."""
        return self._find_state_def_deep(state_name)

    def _find_state_def_deep(self, state_name: str) -> StateDef | None:
        """Search all states including nested and parallel region states."""
        def search(states: list[StateDef]) -> StateDef | None:
            for state in states:
                if state.name == state_name:
                    return state
                if state.contains:
                    found = search(state.contains)
                    if found:
                        return found
                if state.parallel:
                    for region in state.parallel.regions:
                        found = search(region.states)
                        if found:
                            return found
            return None
        return search(self.definition.states)

    def _find_action_def(self, action_name: str) -> ActionSignature | None:
        """Find action definition by name."""
        for action in self.definition.actions:
            if action.name == action_name:
                return action
        return None
