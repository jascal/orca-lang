"""
Effect system for Orca runtime.

Provides effect types and utilities for async operations
that can be executed by the runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .types import Effect, EffectResult, EffectStatus


# Type alias for effect handlers
EffectHandler = Callable[[Effect], Awaitable[EffectResult]]


@dataclass
class EffectType:
    """
    Defines an effect type with its handler.
    """
    name: str
    handler: EffectHandler

    async def execute(self, payload: dict[str, Any]) -> EffectResult:
        """Execute this effect with the given payload."""
        effect = Effect(type=self.name, payload=payload)
        return await self.handler(effect)


class EffectRegistry:
    """
    Registry for effect types and handlers.

    Allows registering effect handlers and creating effect instances.
    """

    def __init__(self):
        self._handlers: dict[str, EffectHandler] = {}

    def register(self, effect_type: str, handler: EffectHandler) -> None:
        """Register a handler for an effect type."""
        self._handlers[effect_type] = handler

    def get_handler(self, effect_type: str) -> EffectHandler | None:
        """Get the handler for an effect type."""
        return self._handlers.get(effect_type)

    def has_handler(self, effect_type: str) -> bool:
        """Check if a handler is registered for an effect type."""
        return effect_type in self._handlers

    @property
    def effect_types(self) -> list[str]:
        """List all registered effect types."""
        return list(self._handlers.keys())

    async def execute(self, effect: Effect) -> EffectResult:
        """Execute an effect using the registered handler."""
        if effect.type not in self._handlers:
            return EffectResult(
                status=EffectStatus.FAILURE,
                error=f"No handler registered for effect type: {effect.type}"
            )

        handler = self._handlers[effect.type]
        try:
            return await handler(effect)
        except Exception as e:
            return EffectResult(
                status=EffectStatus.FAILURE,
                error=str(e)
            )


# Common effect payload types

@dataclass
class NarrativeRequest:
    """Request for narrative generation (LLM)."""
    action: str  # look, move, take, etc.
    context: dict[str, Any]
    event: dict[str, Any] | None = None


@dataclass
class NarrativeResponse:
    """Response from narrative generation."""
    narrative: str
    new_location: str | None = None


@dataclass
class MoveRequest:
    """Request to move to a new location."""
    direction: str
    context: dict[str, Any]


@dataclass
class MoveResponse:
    """Response from move operation."""
    new_location: str
    description: str
    visited: bool = False


@dataclass
class SaveRequest:
    """Request to save state."""
    session_id: str


@dataclass
class SaveResponse:
    """Response from save operation."""
    saved: bool
    timestamp: int


@dataclass
class LoadRequest:
    """Request to load state."""
    session_id: str


@dataclass
class LoadResponse:
    """Response from load operation."""
    loaded: bool
    context: dict[str, Any]


# Default effect handlers

async def default_narrative_handler(effect: Effect) -> EffectResult:
    """Default narrative handler for development/testing."""
    payload = effect.payload

    narrative = f"The world shifts around you... (action: {payload.get('action', 'unknown')})"

    return EffectResult(
        status=EffectStatus.SUCCESS,
        data={
            "narrative": narrative,
            "new_location": payload.get("context", {}).get("current_location"),
        }
    )


async def default_effect_handler(effect: Effect) -> EffectResult:
    """Default handler that returns success with no data."""
    return EffectResult(
        status=EffectStatus.SUCCESS,
        data=None
    )


# Decorator for creating effect handlers

def effect_handler(effect_type: str):
    """
    Decorator to register an effect handler.

    Usage:
        @effect_handler("NarrativeRequest")
        async def handle_narrative(effect: Effect) -> EffectResult:
            # Process the effect
            return EffectResult(status=EffectStatus.SUCCESS, data={...})
    """
    def decorator(handler: EffectHandler) -> EffectHandler:
        # Store the effect type on the handler for later registration
        handler._effect_type = effect_type  # type: ignore
        return handler

    return decorator


def register_effect_handlers(
    registry: EffectRegistry,
    handlers: dict[str, EffectHandler] | None = None
) -> None:
    """
    Register multiple effect handlers with a registry.

    Args:
        registry: EffectRegistry to register with
        handlers: Dict mapping effect type names to handlers
    """
    if handlers:
        for effect_type, handler in handlers.items():
            registry.register(effect_type, handler)


# Global registry
_global_registry: EffectRegistry | None = None


def get_effect_registry() -> EffectRegistry:
    """Get the global effect registry."""
    global _global_registry
    if _global_registry is None:
        _global_registry = EffectRegistry()
        # Register default handlers
        _global_registry.register("NarrativeRequest", default_narrative_handler)
        _global_registry.register("Effect", default_effect_handler)
    return _global_registry


def reset_effect_registry() -> None:
    """Reset the global effect registry."""
    global _global_registry
    _global_registry = None
