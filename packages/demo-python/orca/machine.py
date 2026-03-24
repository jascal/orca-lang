"""Orca state machine runtime - Event-driven state machine executor."""

import asyncio
from typing import Any, Callable, Dict, List, Optional
from dataclasses import dataclass, field

from bus import DomainEvent, EventType, get_event_bus
from orca.types import (
    MachineDefinition, State, Transition, Context,
    StateType, Event as OrcaEvent
)


@dataclass
class MachineSnapshot:
    """Snapshot of machine state for persistence."""
    state: str
    context_data: Dict[str, Any]
    event_history: List[str]


class OrcaMachine:
    """Event-driven state machine with event bus integration.

    Combines Orca's state machine model with agent_framework's
    event-driven architecture for async, decoupled processing.
    """

    def __init__(
        self,
        definition: MachineDefinition,
        event_handlers: Optional[Dict[str, Callable]] = None
    ):
        self.definition = definition
        self.event_handlers = event_handlers or {}
        self.context = definition.context
        self.current_state = definition.initial_state
        self.event_bus = get_event_bus()
        self._running = False
        self._snapshot_history: List[MachineSnapshot] = []

    @property
    def state(self) -> str:
        """Get current state name."""
        return self.current_state

    def start(self) -> None:
        """Start the state machine."""
        self._running = True
        print(f"[OrcaMachine:{self.definition.name}] Started in state: {self.current_state}")
        asyncio.create_task(self._publish_state_change("machine.started"))

    def stop(self) -> None:
        """Stop the state machine."""
        self._running = False
        print(f"[OrcaMachine:{self.definition.name}] Stopped")
        asyncio.create_task(self._publish_state_change("machine.stopped"))

    async def send(self, event: OrcaEvent) -> bool:
        """Send an event to the state machine.

        Returns True if transition was made, False otherwise.
        """
        if not self._running:
            print(f"[OrcaMachine:{self.definition.name}] Not running, ignoring event: {event.type}")
            return False

        print(f"[OrcaMachine:{self.definition.name}] Received event: {event.type} in state: {self.current_state}")

        # Find matching transition
        transition = self._find_transition(event)

        if transition:
            await self._execute_transition(transition, event)
            return True
        else:
            print(f"[OrcaMachine:{self.definition.name}] No transition for {event.type} from {self.current_state}")
            return False

    def _find_transition(self, event: OrcaEvent) -> Optional[Transition]:
        """Find a valid transition for the given event."""
        # Get the state object
        state_obj = self._get_state(self.current_state)
        if not state_obj:
            return None

        # First check state's own transitions
        for trans in state_obj.transitions:
            if trans.event == event.type:
                if trans.guard and not self._evaluate_guard(trans.guard):
                    continue
                return trans

        # Then check global transitions
        for trans in self.definition.transitions:
            if trans.source == self.current_state and trans.event == event.type:
                if trans.guard and not self._evaluate_guard(trans.guard):
                    continue
                return trans

        return None

    async def _execute_transition(self, transition: Transition, event: OrcaEvent) -> None:
        """Execute a state transition."""
        old_state = self.current_state

        print(f"[OrcaMachine:{self.definition.name}] Transition: {old_state} + {event.type} -> {transition.target}")

        # Execute action if defined
        if transition.action:
            await self._execute_action(transition.action, event)

        # Update state
        self.current_state = transition.target

        # Get new state and execute entry action
        new_state = self._get_state(self.current_state)
        if new_state and new_state.entry_action:
            await self._execute_action(new_state.entry_action, event)

        # Publish state change event
        await self._publish_state_change(
            "workflow.state_changed",
            old_state=old_state,
            new_state=self.current_state,
            trigger_event=event.type
        )

        # Save snapshot
        self._save_snapshot()

    async def _execute_action(self, action: str, event: OrcaEvent) -> None:
        """Execute an action handler."""
        handler = self.event_handlers.get(action)
        if handler:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(self.context, event)
                else:
                    handler(self.context, event)
                print(f"[OrcaMachine:{self.definition.name}] Action executed: {action}")
            except Exception as e:
                print(f"[OrcaMachine:{self.definition.name}] Action error in {action}: {e}")
        else:
            print(f"[OrcaMachine:{self.definition.name}] No handler for action: {action}")

    def _evaluate_guard(self, guard: str) -> bool:
        """Evaluate a guard condition."""
        # Guards can reference context data
        # Simple implementation: check if context has truthy value
        return bool(self.context.get(guard, True))

    def _get_state(self, name: str) -> Optional[State]:
        """Get state by name."""
        for state in self.definition.states:
            if state.name == name:
                return state
        return None

    async def _publish_state_change(
        self,
        change_type: str,
        old_state: str = None,
        new_state: str = None,
        trigger_event: str = None
    ) -> None:
        """Publish state change to event bus."""
        event = DomainEvent(
            event_type=EventType.WORKFLOW_STATE_CHANGED,
            entity_id=self.definition.name,
            entity_type="state_machine",
            data={
                "old_state": old_state,
                "new_state": new_state,
                "trigger_event": trigger_event,
                "context": self.context.data.copy()
            },
            source_module="orca"
        )
        await self.event_bus.publish(event)

    def _save_snapshot(self) -> None:
        """Save a snapshot of current state."""
        snapshot = MachineSnapshot(
            state=self.current_state,
            context_data=self.context.data.copy(),
            event_history=[]
        )
        self._snapshot_history.append(snapshot)

    def get_snapshot(self) -> MachineSnapshot:
        """Get current snapshot."""
        return MachineSnapshot(
            state=self.current_state,
            context_data=self.context.data.copy(),
            event_history=[]
        )

    def restore(self, snapshot: MachineSnapshot) -> None:
        """Restore from a snapshot."""
        self.current_state = snapshot.state
        self.context.data = snapshot.context_data.copy()
        print(f"[OrcaMachine:{self.definition.name}] Restored to state: {self.current_state}")

    def is_final_state(self) -> bool:
        """Check if current state is a final state."""
        state = self._get_state(self.current_state)
        return state is not None and state.state_type == StateType.FINAL

    def is_error_state(self) -> bool:
        """Check if current state is an error state."""
        state = self._get_state(self.current_state)
        return state is not None and state.state_type == StateType.ERROR
