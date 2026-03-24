"""
Async event bus with pub/sub and request/response patterns.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Awaitable, Callable
from uuid import uuid4

from .types import Effect, EffectResult, EffectStatus


class EventType(Enum):
    """Standard Orca event types."""

    # State machine events
    STATE_CHANGED = "orca.state.changed"
    TRANSITION_STARTED = "orca.transition.started"
    TRANSITION_COMPLETED = "orca.transition.completed"
    EFFECT_EXECUTING = "orca.effect.executing"
    EFFECT_COMPLETED = "orca.effect.completed"
    EFFECT_FAILED = "orca.effect.failed"
    MACHINE_STARTED = "orca.machine.started"
    MACHINE_STOPPED = "orca.machine.stopped"

    # Workflow events
    WORKFLOW_STATE_CHANGED = "workflow.state.changed"

    # Agent events
    AGENT_TASK_ASSIGNED = "agent.task.assigned"
    AGENT_TASK_COMPLETED = "agent.task.completed"

    # Scheduling events
    SCHEDULING_QUERY = "scheduling.query"
    SCHEDULING_QUERY_RESPONSE = "scheduling.query_response"


@dataclass
class Event:
    """
    Represents a typed event with correlation IDs and source tracking.
    """
    type: EventType
    source: str
    event_name: str | None = None  # Original event name for custom events
    correlation_id: str | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)
    payload: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"Event({self.type.value}, source={self.source})"


# Type alias for effect handlers
EffectHandler = Callable[[Effect], Awaitable[EffectResult]]

# Type alias for event handlers
EventHandler = Callable[[Event], Awaitable[None]]


class EventBus:
    """
    Async event bus with pub/sub and request/response patterns.

    Supports:
    - Subscribe/unsubscribe to event types
    - Publish events to all subscribers
    - Request/response pattern with correlation IDs
    - Effect handler registration and execution
    """

    def __init__(self):
        self._subscribers: dict[EventType, list[EventHandler]] = {}
        self._effect_handlers: dict[str, EffectHandler] = {}
        self._response_queues: dict[str, asyncio.Queue[Event]] = {}

    def subscribe(self, event_type: EventType, handler: EventHandler) -> None:
        """Subscribe a handler to an event type."""
        if event_type not in self._subscribers:
            self._subscribers[event_type] = []
        if handler not in self._subscribers[event_type]:
            self._subscribers[event_type].append(handler)

    def unsubscribe(self, event_type: EventType, handler: EventHandler) -> None:
        """Unsubscribe a handler from an event type."""
        if event_type in self._subscribers:
            if handler in self._subscribers[event_type]:
                self._subscribers[event_type].remove(handler)

    async def publish(self, event: Event) -> None:
        """
        Publish an event to all subscribers.

        All handlers are executed concurrently with return_exceptions=True
        so one handler's exception doesn't affect others.
        """
        if event.type in self._subscribers:
            handlers = list(self._subscribers[event.type])
            await asyncio.gather(
                *[handler(event) for handler in handlers],
                return_exceptions=True
            )

    def register_effect_handler(self, effect_type: str, handler: EffectHandler) -> None:
        """
        Register an effect handler for a specific effect type.

        Effect handlers are async functions that receive an Effect
        and return an EffectResult.
        """
        self._effect_handlers[effect_type] = handler

    async def execute_effect(self, effect: Effect) -> EffectResult:
        """
        Execute an effect via registered handler.

        Returns EffectResult with status SUCCESS or FAILURE.
        """
        if effect.type not in self._effect_handlers:
            return EffectResult(
                status=EffectStatus.FAILURE,
                error=f"No handler registered for effect type: {effect.type}"
            )

        handler = self._effect_handlers[effect.type]
        try:
            return await handler(effect)
        except Exception as e:
            return EffectResult(
                status=EffectStatus.FAILURE,
                error=str(e)
            )

    async def request_response(
        self,
        request_type: EventType,
        request_payload: dict[str, Any],
        response_type: EventType,
        correlation_id: str | None = None,
        timeout: float = 5.0,
        source: str = "orca",
    ) -> Any:
        """
        Request/response pattern via event bus.

        Publishes a request event and waits for a matching response
        with the same correlation ID.

        Args:
            request_type: Event type for the request
            request_payload: Data to send with request
            response_type: Event type expected for response
            correlation_id: Optional correlation ID (generated if not provided)
            timeout: Seconds to wait for response
            source: Source identifier for the request event

        Returns:
            The payload from the response event

        Raises:
            TimeoutError: If response not received within timeout
        """
        corr_id = correlation_id or str(uuid4())

        response_queue: asyncio.Queue[Event] = asyncio.Queue()
        self._response_queues[corr_id] = response_queue

        async def response_handler(event: Event) -> None:
            if event.correlation_id == corr_id:
                await response_queue.put(event)

        self.subscribe(response_type, response_handler)

        try:
            # Publish request
            await self.publish(Event(
                type=request_type,
                source=source,
                correlation_id=corr_id,
                payload=request_payload
            ))

            # Wait for response
            try:
                response_event = await asyncio.wait_for(
                    response_queue.get(),
                    timeout=timeout
                )
                return response_event.payload
            except asyncio.TimeoutError:
                raise TimeoutError(
                    f"Request {corr_id} timed out after {timeout}s"
                )
        finally:
            self.unsubscribe(response_type, response_handler)
            del self._response_queues[corr_id]

    @property
    def effect_handler_types(self) -> list[str]:
        """List of registered effect handler types."""
        return list(self._effect_handlers.keys())


# Global event bus instance
_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """
    Get the global event bus instance.

    Creates a new EventBus if one doesn't exist.
    """
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def reset_event_bus() -> None:
    """Reset the global event bus (useful for testing)."""
    global _bus
    _bus = None
