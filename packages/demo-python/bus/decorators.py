"""Event handler decorators."""

from bus.types import EventType
from bus.core import get_event_bus


def on_event(event_type: EventType):
    """Decorator to register event handlers."""
    def decorator(func):
        get_event_bus().subscribe(event_type, func)
        return func
    return decorator
