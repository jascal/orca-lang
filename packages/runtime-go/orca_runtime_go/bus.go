package orca_runtime_go

import (
	"sync"
)

// EventBus handles event publishing and subscription.
type EventBus struct {
	mu            sync.RWMutex
	subscribers   map[EventType][]chan Event
	effectHandler EffectHandler
}

// NewEventBus creates a new EventBus.
func NewEventBus() *EventBus {
	return &EventBus{
		subscribers: make(map[EventType][]chan Event),
	}
}

// Subscribe subscribes to an event type.
func (eb *EventBus) Subscribe(eventType EventType, ch chan Event) {
	eb.mu.Lock()
	defer eb.mu.Unlock()
	eb.subscribers[eventType] = append(eb.subscribers[eventType], ch)
}

// Publish publishes an event to all subscribers.
func (eb *EventBus) Publish(event Event) {
	eb.mu.RLock()
	defer eb.mu.RUnlock()
	subscribers := eb.subscribers[event.Type]
	for _, ch := range subscribers {
		select {
		case ch <- event:
		default:
			// Channel full, skip
		}
	}
}

// SetEffectHandler sets the effect handler.
func (eb *EventBus) SetEffectHandler(handler EffectHandler) {
	eb.mu.Lock()
	defer eb.mu.Unlock()
	eb.effectHandler = handler
}

// ExecuteEffect executes an effect via the registered handler.
func (eb *EventBus) ExecuteEffect(effect Effect) EffectResult {
	eb.mu.RLock()
	defer eb.mu.RUnlock()
	if eb.effectHandler != nil {
		return eb.effectHandler(effect)
	}
	return EffectResult{Status: EffectStatusSuccess}
}
