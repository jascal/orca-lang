"""Event bus module - Agent-style decoupled event handling."""

from bus.core import DomainEvent, EventBus, EventType, get_event_bus
from bus.decorators import on_event

__all__ = ["DomainEvent", "EventBus", "EventType", "get_event_bus", "on_event"]
