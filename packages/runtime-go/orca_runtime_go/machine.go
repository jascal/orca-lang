package orca_runtime_go

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// OrcaMachine is an async Orca state machine runtime.
type OrcaMachine struct {
	definition    *MachineDef
	eventBus      *EventBus
	context       Context
	onTransition  TransitionCallback
	actionHandlers map[string]ActionHandler

	// Internal state
	state   StateValue
	active  bool
	mu      sync.RWMutex
	timeoutCancell context.CancelFunc
	timeoutDone   chan struct{}

	// Child machine management
	childMachines   map[string]*OrcaMachine
	siblingMachines map[string]*MachineDef
	activeInvoke    string
}

// NewOrcaMachine creates a new OrcaMachine.
func NewOrcaMachine(definition *MachineDef, eventBus *EventBus, context Context, onTransition TransitionCallback) *OrcaMachine {
	if eventBus == nil {
		eventBus = NewEventBus()
	}
	if context == nil {
		context = make(Context)
		for k, v := range definition.Context {
			context[k] = v
		}
	}

	machine := &OrcaMachine{
		definition:     definition,
		eventBus:       eventBus,
		context:        context,
		onTransition:   onTransition,
		actionHandlers: make(map[string]ActionHandler),
		state:          getInitialState(definition),
		childMachines:  make(map[string]*OrcaMachine),
		timeoutDone:    make(chan struct{}),
	}

	return machine
}

func getInitialState(def *MachineDef) StateValue {
	for _, s := range def.States {
		if s.IsInitial {
			// If compound state with children, start at initial child
			if len(s.Contains) > 0 {
				initial := s.Contains[0].Name
				for _, child := range s.Contains {
					if child.IsInitial {
						initial = child.Name
						break
					}
				}
				return NewStateValue(map[string]any{s.Name: map[string]any{initial: emptyStruct{}}})
			}
			return NewStateValue(s.Name)
		}
	}
	if len(def.States) > 0 {
		s := def.States[0]
		if len(s.Contains) > 0 {
			initial := s.Contains[0].Name
			for _, child := range s.Contains {
				if child.IsInitial {
					initial = child.Name
					break
				}
			}
			return NewStateValue(map[string]any{s.Name: map[string]any{initial: emptyStruct{}}})
		}
		return NewStateValue(s.Name)
	}
	return NewStateValue("unknown")
}

// State returns the current state.
func (m *OrcaMachine) State() StateValue {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state
}

// IsActive returns whether the machine is running.
func (m *OrcaMachine) IsActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.active
}

// RegisterAction registers a handler for an action.
func (m *OrcaMachine) RegisterAction(name string, handler ActionHandler) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.actionHandlers[name] = handler
}

// UnregisterAction unregisters an action handler.
func (m *OrcaMachine) UnregisterAction(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.actionHandlers, name)
}

// RegisterMachines registers sibling machines for invocation.
func (m *OrcaMachine) RegisterMachines(machines map[string]*MachineDef) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.siblingMachines = machines
}

// Start starts the state machine.
func (m *OrcaMachine) Start() error {
	m.mu.Lock()
	if m.active {
		m.mu.Unlock()
		return nil
	}
	m.active = true
	m.mu.Unlock()

	m.eventBus.Publish(Event{
		Type:   EventTypeMachineStarted,
		Source: m.definition.Name,
		Payload: map[string]any{
			"machine":       m.definition.Name,
			"initial_state": m.state.String(),
		},
	})

	leaf := m.state.Leaf()
	if err := m.executeEntryActions(leaf); err != nil {
		return err
	}
	m.startTimeoutForState(leaf)

	return nil
}

// Stop stops the state machine.
func (m *OrcaMachine) Stop() {
	m.mu.Lock()
	if !m.active {
		m.mu.Unlock()
		return
	}
	m.active = false
	m.cancelTimeout()
	m.mu.Unlock()

	// Stop all child machines
	for _, child := range m.childMachines {
		child.Stop()
	}
	m.childMachines = nil
	m.activeInvoke = ""

	m.eventBus.Publish(Event{
		Type:   EventTypeMachineStopped,
		Source: m.definition.Name,
	})
}

// Send sends an event to the machine.
func (m *OrcaMachine) Send(event string, payload map[string]any) error {
	m.mu.Lock()
	if !m.active {
		m.mu.Unlock()
		return fmt.Errorf("machine is not active")
	}
	m.mu.Unlock()

	// Check if event is ignored
	eventKey := event
	if m.isEventIgnored(eventKey) {
		return nil
	}

	// Find matching transition
	transition := m.findTransition(eventKey)
	if transition == nil {
		return fmt.Errorf("no transition for event %s from state %s", eventKey, m.state.Leaf())
	}

	// Evaluate guard if present
	if transition.Guard != "" {
		passed, err := m.evaluateGuard(transition.Guard)
		if err != nil || !passed {
			if err != nil {
				return err
			}
			return fmt.Errorf("guard '%s' failed", transition.Guard)
		}
	}

	// Execute transition
	oldState := m.state
	newStateName := transition.Target

	m.mu.Lock()
	m.cancelTimeout()
	m.mu.Unlock()

	if err := m.executeExitActions(oldState.Leaf()); err != nil {
		return err
	}

	if transition.Action != "" {
		if err := m.executeAction(transition.Action, payload); err != nil {
			return err
		}
	}

	// Update state
	newState, err := m.computeNewState(newStateName)
	if err != nil {
		return err
	}

	m.mu.Lock()
	m.state = newState
	m.mu.Unlock()

	m.eventBus.Publish(Event{
		Type:   EventTypeTransitionStarted,
		Source: m.definition.Name,
		Payload: map[string]any{
			"from":    oldState.String(),
			"to":      newStateName,
			"trigger": event,
		},
	})

	// Execute entry actions
	newLeaf := newState.Leaf()
	if err := m.executeEntryActions(newLeaf); err != nil {
		return err
	}
	m.startTimeoutForState(newLeaf)

	// Check parallel sync
	if err := m.checkParallelSync(); err != nil {
		return err
	}

	// Notify callback
	if m.onTransition != nil {
		m.onTransition(oldState, newState)
	}

	m.eventBus.Publish(Event{
		Type:   EventTypeTransitionCompleted,
		Source: m.definition.Name,
		Payload: map[string]any{
			"from": oldState.String(),
			"to":   newState.String(),
		},
	})

	return nil
}

func (m *OrcaMachine) isEventIgnored(event string) bool {
	current := m.state.Leaf()
	stateDef := m.findStateDef(current)
	if stateDef != nil {
		for _, ignored := range stateDef.IgnoredEvents {
			if ignored == event {
				return true
			}
		}
	}
	// Check parent
	parent := m.getParentState(current)
	for parent != "" {
		stateDef = m.findStateDef(parent)
		if stateDef != nil {
			for _, ignored := range stateDef.IgnoredEvents {
				if ignored == event {
					return true
				}
			}
		}
		parent = m.getParentState(parent)
	}
	return false
}

func (m *OrcaMachine) findTransition(event string) *Transition {
	// Check all active leaf states
	for _, leaf := range m.state.Leaves() {
		for _, t := range m.definition.Transitions {
			if t.Source == leaf && t.Event == event {
				return &t
			}
		}

		// For compound states, check parent's transitions
		parent := m.getParentState(leaf)
		for parent != "" {
			for _, t := range m.definition.Transitions {
				if t.Source == parent && t.Event == event {
					return &t
				}
			}
			parent = m.getParentState(parent)
		}
	}
	return nil
}

func (m *OrcaMachine) getParentState(stateName string) string {
	var search func(states []StateDef, parentName string) string
	search = func(states []StateDef, parentName string) string {
		for _, s := range states {
			if s.Name == stateName {
				return s.Parent
			}
			if len(s.Contains) > 0 {
				if found := search(s.Contains, s.Name); found != "" {
					return found
				}
			}
			if s.Parallel != nil {
				for _, r := range s.Parallel.Regions {
					if found := search(r.States, s.Name); found != "" {
						return found
					}
				}
			}
		}
		return ""
	}
	return search(m.definition.States, "")
}

func (m *OrcaMachine) findStateDef(name string) *StateDef {
	var search func(states []StateDef) *StateDef
	search = func(states []StateDef) *StateDef {
		for _, s := range states {
			if s.Name == name {
				return &s
			}
			if len(s.Contains) > 0 {
				if found := search(s.Contains); found != nil {
					return found
				}
			}
			if s.Parallel != nil {
				for _, r := range s.Parallel.Regions {
					if found := search(r.States); found != nil {
						return found
					}
				}
			}
		}
		return nil
	}
	return search(m.definition.States)
}

func (m *OrcaMachine) computeNewState(newStateName string) (StateValue, error) {
	if m.isParallelState(newStateName) {
		return m.buildParallelState(newStateName), nil
	}
	if m.isCompoundState(newStateName) {
		initial := m.getInitialChild(newStateName)
		return NewStateValue(map[string]any{newStateName: map[string]any{initial: emptyStruct{}}}), nil
	}
	// Check if we're inside a parallel state
	if updated := m.tryUpdateParallelRegion(newStateName); updated {
		return m.state, nil
	}
	return NewStateValue(newStateName), nil
}

func (m *OrcaMachine) isCompoundState(name string) bool {
	state := m.findStateDef(name)
	return state != nil && (len(state.Contains) > 0 || state.Parallel != nil)
}

func (m *OrcaMachine) isParallelState(name string) bool {
	state := m.findStateDef(name)
	return state != nil && state.Parallel != nil
}

func (m *OrcaMachine) getInitialChild(parentName string) string {
	state := m.findStateDef(parentName)
	if state == nil || len(state.Contains) == 0 {
		return parentName
	}
	for _, child := range state.Contains {
		if child.IsInitial {
			return child.Name
		}
	}
	return state.Contains[0].Name
}

func (m *OrcaMachine) buildParallelState(stateName string) StateValue {
	state := m.findStateDef(stateName)
	if state == nil || state.Parallel == nil {
		return NewStateValue(map[string]any{stateName: emptyStruct{}})
	}
	regions := make(map[string]any)
	for _, region := range state.Parallel.Regions {
		initial := region.States[0].Name
		for _, s := range region.States {
			if s.IsInitial {
				initial = s.Name
				break
			}
		}
		regions[region.Name] = map[string]any{initial: emptyStruct{}}
	}
	return NewStateValue(map[string]any{stateName: regions})
}

func (m *OrcaMachine) tryUpdateParallelRegion(targetName string) bool {
	if !m.state.IsCompound() {
		return false
	}

	// Find if target is in a parallel region
	for _, topState := range m.definition.States {
		if topState.Parallel == nil {
			continue
		}
		for _, region := range topState.Parallel.Regions {
			for _, s := range region.States {
				if s.Name == targetName {
					// This is a leaf state in a parallel region
					if m.state.Value() != nil {
						if m2, ok := m.state.Value().(map[string]any); ok {
							if _, exists := m2[topState.Name]; exists {
								if r, ok := m2[topState.Name].(map[string]any); ok {
									r[region.Name] = map[string]any{targetName: emptyStruct{}}
								}
							}
						}
					}
					return true
				}
			}
		}
	}
	return false
}

func (m *OrcaMachine) allRegionsFinal(stateName string) bool {
	state := m.findStateDef(stateName)
	if state == nil || state.Parallel == nil {
		return false
	}
	currentLeaves := m.state.Leaves()
	for _, region := range state.Parallel.Regions {
		finalNames := make(map[string]bool)
		for _, s := range region.States {
			if s.IsFinal {
				finalNames[s.Name] = true
			}
		}
		found := false
		for _, leaf := range currentLeaves {
			if finalNames[leaf] {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (m *OrcaMachine) anyRegionFinal(stateName string) bool {
	state := m.findStateDef(stateName)
	if state == nil || state.Parallel == nil {
		return false
	}
	currentLeaves := m.state.Leaves()
	for _, region := range state.Parallel.Regions {
		finalNames := make(map[string]bool)
		for _, s := range region.States {
			if s.IsFinal {
				finalNames[s.Name] = true
			}
		}
		for _, leaf := range currentLeaves {
			if finalNames[leaf] {
				return true
			}
		}
	}
	return false
}

func (m *OrcaMachine) checkParallelSync() error {
	for _, state := range m.definition.States {
		if state.Parallel == nil || state.OnDone == "" {
			continue
		}
		sync := state.Parallel.Sync
		if sync == "" {
			sync = "all-final"
		}

		shouldTransition := false
		if sync == "all-final" {
			shouldTransition = m.allRegionsFinal(state.Name)
		} else if sync == "any-final" {
			shouldTransition = m.anyRegionFinal(state.Name)
		}

		if shouldTransition {
			oldState := m.state
			m.mu.Lock()
			m.cancelTimeout()
			m.state = NewStateValue(state.OnDone)
			m.mu.Unlock()

			if m.onTransition != nil {
				m.onTransition(oldState, m.state)
			}

			newLeaf := m.state.Leaf()
			if err := m.executeEntryActions(newLeaf); err != nil {
				return err
			}
			m.startTimeoutForState(newLeaf)
		}
	}
	return nil
}

func (m *OrcaMachine) evaluateGuard(guardName string) (bool, error) {
	expr, exists := m.definition.Guards[guardName]
	if !exists {
		return true, nil // Unknown guard = allow
	}
	return m.evalGuard(expr), nil
}

func (m *OrcaMachine) evalGuard(expr GuardExpression) bool {
	switch e := expr.(type) {
	case GuardTrue:
		return true
	case GuardFalse:
		return false
	case GuardNot:
		return !m.evalGuard(e.Expr)
	case GuardAnd:
		return m.evalGuard(e.Left) && m.evalGuard(e.Right)
	case GuardOr:
		return m.evalGuard(e.Left) || m.evalGuard(e.Right)
	case GuardCompare:
		return m.evalCompare(e)
	case GuardNullcheck:
		return m.evalNullcheck(e)
	default:
		return true
	}
}

func (m *OrcaMachine) evalCompare(e GuardCompare) bool {
	lhs := m.resolveVariable(e.Left)
	rhs := m.resolveValue(e.Right)

	// Numeric comparison
	lhsNum, lhsOk := toFloat(lhs)
	rhsNum, rhsOk := toFloat(rhs)

	if lhsOk && rhsOk {
		switch e.Op {
		case "eq":
			return lhsNum == rhsNum
		case "ne":
			return lhsNum != rhsNum
		case "lt":
			return lhsNum < rhsNum
		case "gt":
			return lhsNum > rhsNum
		case "le":
			return lhsNum <= rhsNum
		case "ge":
			return lhsNum >= rhsNum
		}
	}

	// String comparison
	switch e.Op {
	case "eq":
		return fmt.Sprintf("%v", lhs) == fmt.Sprintf("%v", rhs)
	case "ne":
		return fmt.Sprintf("%v", lhs) != fmt.Sprintf("%v", rhs)
	}
	return false
}

func (m *OrcaMachine) evalNullcheck(e GuardNullcheck) bool {
	val := m.resolveVariable(e.Expr)
	isNull := val == nil
	return isNull == e.IsNull
}

func (m *OrcaMachine) resolveVariable(ref VariableRef) any {
	current := any(m.context)
	for _, part := range ref.Path {
		if part == "ctx" || part == "context" {
			continue
		}
		if current == nil {
			return nil
		}
		if m2, ok := current.(map[string]any); ok {
			current = m2[part]
		} else {
			return nil
		}
	}
	return current
}

func (m *OrcaMachine) resolveValue(ref ValueRef) any {
	return ref.Value
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	case float32:
		return float64(n), true
	default:
		return 0, false
	}
}

func (m *OrcaMachine) executeEntryActions(stateName string) error {
	state := m.findStateDef(stateName)
	if state == nil {
		return nil
	}

	// Handle invoke
	if state.Invoke != nil {
		return m.startChildMachine(stateName, state.Invoke)
	}

	if state.OnEntry == "" {
		return nil
	}

	actionDef := m.findActionDef(state.OnEntry)
	if actionDef != nil && actionDef.HasEffect {
		effect := Effect{
			Type: actionDef.EffectType,
			Payload: map[string]any{
				"action": state.OnEntry,
				"context": m.context,
				"event":  nil,
			},
		}
		m.eventBus.Publish(Event{
			Type:   EventTypeEffectExecuting,
			Source: m.definition.Name,
			Payload: map[string]any{"effect": effect.Type},
		})
		result := m.eventBus.ExecuteEffect(effect)
		if result.Status == EffectStatusSuccess {
			m.eventBus.Publish(Event{
				Type:   EventTypeEffectCompleted,
				Source: m.definition.Name,
				Payload: map[string]any{"effect": effect.Type, "result": result.Data},
			})
			if data, ok := result.Data.(map[string]any); ok {
				for k, v := range data {
					m.context[k] = v
				}
			}
		} else {
			m.eventBus.Publish(Event{
				Type:   EventTypeEffectFailed,
				Source: m.definition.Name,
				Payload: map[string]any{"effect": effect.Type, "error": result.Error},
			})
		}
	} else if actionDef != nil {
		return m.executeAction(actionDef.Name, nil)
	}
	return nil
}

func (m *OrcaMachine) executeExitActions(stateName string) error {
	state := m.findStateDef(stateName)
	if state == nil {
		return nil
	}

	// Stop child machine if this state has an invoke
	if state.Invoke != nil {
		m.stopChildMachine(stateName)
	}

	if state.OnExit == "" {
		return nil
	}
	return m.executeAction(state.OnExit, nil)
}

func (m *OrcaMachine) executeAction(actionName string, eventPayload map[string]any) error {
	m.mu.RLock()
	handler, exists := m.actionHandlers[actionName]
	m.mu.RUnlock()

	if !exists || handler == nil {
		return nil
	}

	result := handler(m.context, eventPayload)
	if result != nil {
		for k, v := range result {
			m.context[k] = v
		}
	}
	return nil
}

func (m *OrcaMachine) findActionDef(name string) *ActionSignature {
	for i := range m.definition.Actions {
		if m.definition.Actions[i].Name == name {
			return &m.definition.Actions[i]
		}
	}
	return nil
}

func (m *OrcaMachine) startTimeoutForState(stateName string) {
	state := m.findStateDef(stateName)
	if state == nil || state.Timeout == nil {
		return
	}

	duration, err := parseTimeoutDuration(state.Timeout.Duration)
	if err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), duration)
	m.mu.Lock()
	m.timeoutCancell = cancel
	m.mu.Unlock()

	go func() {
		select {
		case <-ctx.Done():
			if ctx.Err() == context.DeadlineExceeded {
				m.mu.RLock()
				active := m.active
				currentLeaf := m.state.Leaf()
				m.mu.RUnlock()

				if active && currentLeaf == stateName {
					m.executeTimeoutTransition(stateName, state.Timeout.Target)
				}
			}
		case <-m.timeoutDone:
		}
	}()
}

func (m *OrcaMachine) cancelTimeout() {
	if m.timeoutCancell != nil {
		m.timeoutCancell()
		m.timeoutCancell = nil
	}
}

func parseTimeoutDuration(s string) (time.Duration, error) {
	re := regexp.MustCompile(`(\d+)`)
	match := re.FindStringSubmatch(s)
	if match == nil {
		return 0, fmt.Errorf("invalid timeout duration: %s", s)
	}
	n, _ := strconv.Atoi(match[1])
	return time.Duration(n) * time.Second, nil
}

func (m *OrcaMachine) executeTimeoutTransition(fromState, target string) {
	oldState := m.state

	m.mu.Lock()
	m.cancelTimeout()
	m.mu.Unlock()

	m.executeExitActions(fromState)

	if m.isParallelState(target) {
		m.mu.Lock()
		m.state = m.buildParallelState(target)
		m.mu.Unlock()
	} else if m.isCompoundState(target) {
		initial := m.getInitialChild(target)
		m.mu.Lock()
		m.state = NewStateValue(map[string]any{target: map[string]any{initial: emptyStruct{}}})
		m.mu.Unlock()
	} else {
		m.mu.Lock()
		m.state = NewStateValue(target)
		m.mu.Unlock()
	}

	m.eventBus.Publish(Event{
		Type:   EventTypeTransitionStarted,
		Source: m.definition.Name,
		Payload: map[string]any{
			"from":    oldState.String(),
			"to":      target,
			"trigger": "timeout",
		},
	})

	newLeaf := m.state.Leaf()
	m.executeEntryActions(newLeaf)
	m.startTimeoutForState(newLeaf)

	if m.onTransition != nil {
		m.onTransition(oldState, m.state)
	}

	m.eventBus.Publish(Event{
		Type:   EventTypeTransitionCompleted,
		Source: m.definition.Name,
		Payload: map[string]any{
			"from": oldState.String(),
			"to":   m.state.String(),
		},
	})
}

// Snapshot captures the current machine state.
func (m *OrcaMachine) Snapshot() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	children := make(map[string]any)
	for k, v := range m.childMachines {
		children[k] = v.Snapshot()
	}

	return map[string]any{
		"state":        m.state.Value(),
		"context":      m.context,
		"children":     children,
		"active_invoke": m.activeInvoke,
		"timestamp":     time.Now().Unix(),
	}
}

// Restore restores machine state from a snapshot.
func (m *OrcaMachine) Restore(snap map[string]any) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.cancelTimeout()

	if v, ok := snap["state"]; ok {
		m.state = NewStateValue(v)
	}
	if v, ok := snap["context"]; ok {
		if ctx, ok := v.(map[string]any); ok {
			m.context = ctx
		}
	}

	if m.active {
		for _, leaf := range m.state.Leaves() {
			m.startTimeoutForState(leaf)
		}
	}
	return nil
}

// Child machine management

func (m *OrcaMachine) startChildMachine(stateName string, invoke *InvokeDef) error {
	m.mu.RLock()
	siblingMachines := m.siblingMachines
	m.mu.RUnlock()

	if siblingMachines == nil {
		return nil
	}

	childDef, exists := siblingMachines[invoke.Machine]
	if !exists {
		return nil
	}

	// Map input from parent context
	childContext := make(Context)
	for k, v := range childDef.Context {
		childContext[k] = v
	}
	if invoke.Input != nil {
		for key, value := range invoke.Input {
			fieldName := strings.TrimPrefix(value, "ctx.")
			childContext[key] = m.context[fieldName]
		}
	}

	// Create child machine
	child := NewOrcaMachine(childDef, m.eventBus, childContext, nil)

	m.mu.Lock()
	m.childMachines[stateName] = child
	m.activeInvoke = stateName
	m.mu.Unlock()

	// Set up completion listener
	go func() {
		for child.IsActive() {
			time.Sleep(10 * time.Millisecond)
		}

		// Child reached final state
		childState := child.State().Leaf()

		m.mu.RLock()
		stillActive := m.active
		myActiveInvoke := m.activeInvoke
		m.mu.RUnlock()

		if stillActive && myActiveInvoke == stateName {
			if invoke.OnDone != "" {
				m.Send(invoke.OnDone, map[string]any{
					"child":        invoke.Machine,
					"final_state":  childState,
					"context":      child.context,
				})
			}
			m.mu.Lock()
			delete(m.childMachines, stateName)
			m.activeInvoke = ""
			m.mu.Unlock()
		}
	}()

	return child.Start()
}

func (m *OrcaMachine) stopChildMachine(stateName string) {
	m.mu.RLock()
	activeInvoke := m.activeInvoke
	m.mu.RUnlock()

	if activeInvoke != stateName {
		return
	}

	m.mu.RLock()
	child, exists := m.childMachines[stateName]
	m.mu.RUnlock()

	if exists {
		child.Stop()
		m.mu.Lock()
		delete(m.childMachines, stateName)
		m.activeInvoke = ""
		m.mu.Unlock()
	}
}
