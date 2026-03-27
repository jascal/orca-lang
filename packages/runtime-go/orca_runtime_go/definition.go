package orca_runtime_go

// RegionDef represents a region inside a parallel state.
type RegionDef struct {
	Name   string
	States []StateDef
}

// ParallelDef represents parallel regions inside a state.
type ParallelDef struct {
	Regions []RegionDef
	Sync   string // all-final, any-final, custom
}

// InvokeDef represents machine invocation.
type InvokeDef struct {
	Machine string            // Name of machine to invoke
	Input   map[string]string // ctx.field -> child param mapping
	OnDone  string            // Event to emit when child completes
	OnError string            // Event to emit when child errors
}

// StateDef represents a state definition.
type StateDef struct {
	Name          string
	IsInitial     bool
	IsFinal       bool
	OnEntry       string
	OnExit        string
	OnDone        string
	Description   string
	Contains      []StateDef
	Parallel      *ParallelDef
	Parent        string
	Timeout       *TimeoutDef // {duration, target}
	IgnoredEvents []string
	Invoke        *InvokeDef
}

// TimeoutDef represents a timeout configuration.
type TimeoutDef struct {
	Duration string
	Target   string
}

// Transition represents a state transition.
type Transition struct {
	Source string
	Event  string
	Target string
	Guard  string
	Action string
}

// ActionSignature represents an action function signature.
type ActionSignature struct {
	Name       string
	Parameters []string
	ReturnType string
	HasEffect  bool
	EffectType string
}

// MachineDef represents a complete Orca machine definition.
type MachineDef struct {
	Name        string
	Context     Context
	Events      []string
	States      []StateDef
	Transitions []Transition
	Guards      map[string]GuardExpression
	Actions     []ActionSignature
}

// GuardExpression union types
type GuardExpression interface {
	isGuard()
}

// GuardTrue is the always-true guard.
type GuardTrue struct{}
type GuardFalse struct{}

type GuardCompare struct {
	Op   string // eq, ne, lt, gt, le, ge
	Left VariableRef
	Right ValueRef
}

type GuardAnd struct {
	Left  GuardExpression
	Right GuardExpression
}

type GuardOr struct {
	Left  GuardExpression
	Right GuardExpression
}

type GuardNot struct {
	Expr GuardExpression
}

type GuardNullcheck struct {
	Expr   VariableRef
	IsNull bool
}

type VariableRef struct {
	Path []string
}

type ValueRef struct {
	Type  string // string, number, boolean, null
	Value any
}

func (GuardTrue) isGuard()    {}
func (GuardFalse) isGuard()   {}
func (GuardCompare) isGuard() {}
func (GuardAnd) isGuard()    {}
func (GuardOr) isGuard()     {}
func (GuardNot) isGuard()    {}
func (GuardNullcheck) isGuard() {}

// Effect represents an effect (async operation).
type Effect struct {
	Type    string
	Payload map[string]any
}

// EffectResult is the result of an effect execution.
type EffectResult struct {
	Status EffectStatus
	Data   any
	Error  string
}

// EffectStatus is the effect execution status.
type EffectStatus string

const (
	EffectStatusSuccess EffectStatus = "success"
	EffectStatusFailure EffectStatus = "failure"
)
