package orca_runtime_go

// EventType represents the type of an event.
type EventType string

const (
	EventTypeStateChanged        EventType = "state_changed"
	EventTypeTransitionStarted   EventType = "transition_started"
	EventTypeTransitionCompleted EventType = "transition_completed"
	EventTypeEffectExecuting     EventType = "effect_executing"
	EventTypeEffectCompleted     EventType = "effect_completed"
	EventTypeEffectFailed        EventType = "effect_failed"
	EventTypeMachineStarted      EventType = "machine_started"
	EventTypeMachineStopped      EventType = "machine_stopped"
)

// Event represents an event in the system.
type Event struct {
	Type      EventType
	Source    string
	EventName string
	Payload   map[string]any
}

// EffectHandler is a function that handles an effect.
type EffectHandler func(Effect) EffectResult

// TransitionCallback is called when a transition occurs.
type TransitionCallback func(oldState StateValue, newState StateValue)

// ActionHandler is a handler for a plain (non-effect) action.
type ActionHandler func(context Context, eventPayload map[string]any) map[string]any
