"""Event Bus System - Decoupled event-driven communication."""

from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
import uuid
import asyncio
from collections import defaultdict

from bus.types import EventType


@dataclass
class DomainEvent:
    """Base event structure for all domain events."""

    event_type: EventType
    entity_id: str
    entity_type: str
    data: Dict[str, Any]
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=datetime.utcnow)
    source_module: str = ""
    correlation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert event to dictionary for serialization."""
        result = asdict(self)
        result["event_type"] = self.event_type.value
        result["timestamp"] = self.timestamp.isoformat()
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DomainEvent":
        """Create event from dictionary."""
        data["event_type"] = EventType(data["event_type"])
        data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        return cls(**data)


class EventBus:
    """Event bus for decoupled cross-module communication."""

    def __init__(self):
        self.handlers: Dict[EventType, List[Callable]] = defaultdict(list)
        self.async_handlers: Dict[EventType, List[Callable]] = defaultdict(list)
        self.event_store: List[DomainEvent] = []
        self.middleware: List[Callable] = []
        self._max_store_size = 10000
        self._is_replaying = False
        self._pending_responses: Dict[str, asyncio.Future] = {}
        self._response_lock = asyncio.Lock()

    def subscribe(self, event_type: EventType, handler: Callable) -> None:
        """Subscribe to an event type with a handler."""
        if asyncio.iscoroutinefunction(handler):
            self.async_handlers[event_type].append(handler)
        else:
            self.handlers[event_type].append(handler)
        print(f"[EventBus] Handler '{handler.__name__}' subscribed to {event_type.value}")

    def unsubscribe(self, event_type: EventType, handler: Callable) -> None:
        """Unsubscribe a handler from an event type."""
        if handler in self.handlers[event_type]:
            self.handlers[event_type].remove(handler)
        if handler in self.async_handlers[event_type]:
            self.async_handlers[event_type].remove(handler)

    def add_middleware(self, middleware: Callable) -> None:
        """Add middleware for event processing."""
        self.middleware.append(middleware)

    async def publish(self, event: DomainEvent) -> None:
        """Publish an event to all subscribers."""
        # Process through middleware
        processed_event = event
        for middleware in self.middleware:
            if asyncio.iscoroutinefunction(middleware):
                processed_event = await middleware(processed_event)
            else:
                processed_event = middleware(processed_event)
            if processed_event is None:
                return  # Event was filtered

        # Store event
        if not self._is_replaying:
            self.event_store.append(processed_event)
            if len(self.event_store) > self._max_store_size:
                self.event_store = self.event_store[-self._max_store_size :]

        print(
            f"[EventBus] Event: {event.event_type.value} "
            f"for {event.entity_type}:{event.entity_id}"
        )

        # Notify sync handlers
        handlers = self.handlers.get(event.event_type, [])
        for handler in handlers:
            try:
                handler(processed_event)
            except Exception as e:
                print(f"[EventBus] Handler error in {handler.__name__}: {e}")

        # Notify async handlers
        async_handlers = self.async_handlers.get(event.event_type, [])
        if async_handlers:
            await asyncio.gather(
                *[self._call_async_handler(handler, processed_event)
                  for handler in async_handlers],
                return_exceptions=True
            )

    def publish_sync(self, event: DomainEvent) -> None:
        """Synchronous publish for non-async contexts."""
        asyncio.create_task(self.publish(event))

    async def _call_async_handler(self, handler: Callable, event: DomainEvent) -> None:
        """Call async handler with error handling."""
        try:
            await handler(event)
        except Exception as e:
            print(f"[EventBus] Async handler error in {handler.__name__}: {e}")

    async def request(
        self,
        event: DomainEvent,
        response_event_type: EventType,
        timeout: float = 5.0
    ) -> Optional[DomainEvent]:
        """Send a request event and wait for a response."""
        correlation_id = event.correlation_id
        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()

        async with self._response_lock:
            self._pending_responses[correlation_id] = future

        async def response_handler(response_event: DomainEvent):
            if response_event.correlation_id == correlation_id:
                async with self._response_lock:
                    if correlation_id in self._pending_responses:
                        pending_future = self._pending_responses.pop(correlation_id)
                        if not pending_future.done():
                            pending_future.set_result(response_event)

        self.subscribe(response_event_type, response_handler)

        try:
            await self.publish(event)
            try:
                response = await asyncio.wait_for(future, timeout=timeout)
                return response
            except asyncio.TimeoutError:
                print(f"[EventBus] Request timeout for {event.event_type.value}")
                return None
        finally:
            self.unsubscribe(response_event_type, response_handler)
            async with self._response_lock:
                self._pending_responses.pop(correlation_id, None)

    async def respond(
        self,
        request_event: DomainEvent,
        response_event_type: EventType,
        data: Dict[str, Any],
        source_module: str
    ) -> None:
        """Send a response to a request event."""
        response = DomainEvent(
            event_type=response_event_type,
            entity_id=request_event.entity_id,
            entity_type=request_event.entity_type,
            data=data,
            source_module=source_module,
            correlation_id=request_event.correlation_id,
            tenant_id=request_event.tenant_id,
        )
        await self.publish(response)

    def get_event_history(
        self,
        event_type: EventType = None,
        entity_id: str = None,
        limit: int = 100
    ) -> List[DomainEvent]:
        """Get event history for debugging/auditing."""
        events = self.event_store

        if event_type:
            events = [e for e in events if e.event_type == event_type]

        if entity_id:
            events = [e for e in events if e.entity_id == entity_id]

        return events[-limit:]

    def clear_event_store(self) -> None:
        """Clear the event store."""
        self.event_store.clear()


# Global event bus instance
_event_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """Get the global event bus instance."""
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus


async def shutdown_event_bus() -> None:
    """Shutdown the global event bus."""
    global _event_bus
    if _event_bus is not None:
        _event_bus = None
