package orca_runtime_go

import (
	"os"
	"testing"
)

func TestParseSimpleToggle(t *testing.T) {
	source := `# machine Toggle

## events

- toggle
- TIMEOUT

## state off [initial]
> The toggle is off

## state on
> The toggle is on

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| off | toggle | | on | |
| on | toggle | | off | |
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if machine.Name != "Toggle" {
		t.Errorf("Expected machine name 'Toggle', got '%s'", machine.Name)
	}

	if len(machine.Events) != 2 {
		t.Errorf("Expected 2 events, got %d", len(machine.Events))
	}

	if len(machine.States) != 2 {
		t.Errorf("Expected 2 states, got %d", len(machine.States))
	}
}

func TestParseParallel(t *testing.T) {
	source := `# machine Parallel

## events

- start
- done

## state parallel_state [initial, parallel]
> Parallel state

### region region1 [initial]

#### state s1a [initial]
#### state s1b [final]

### region region2 [initial]

#### state s2a [initial]
#### state s2b [final]

## state final_state [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| parallel_state | done | | final_state | |
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if len(machine.States) != 2 {
		t.Errorf("Expected 2 states, got %d", len(machine.States))
	}

	parallel := machine.States[0]
	if !parallel.IsInitial {
		t.Error("Expected parallel state to be initial")
	}
	if parallel.Parallel == nil {
		t.Fatal("Expected parallel regions")
	}
	if parallel.Parallel.Sync != "all-final" {
		t.Errorf("Expected sync 'all-final', got '%s'", parallel.Parallel.Sync)
	}
}

func TestParseGuards(t *testing.T) {
	source := `# machine Guarded

## events

- trigger

## guards

| Name | Expression |
|------|------------|
| is_ready | ctx.ready == true |
| not_ready | ctx.ready == false |
| has_count | ctx.count > 0 |

## state waiting [initial]

## state ready
> Ready state

## state skipped
> Skipped state

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| waiting | trigger | is_ready | ready | |
| waiting | trigger | not_ready | skipped | |
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if len(machine.Transitions) != 2 {
		t.Errorf("Expected 2 transitions, got %d", len(machine.Transitions))
	}

	for _, tr := range machine.Transitions {
		if tr.Guard == "" {
			t.Error("Expected guard on transition")
		}
	}
}

func TestParseActions(t *testing.T) {
	source := `# machine Actions

## events

- step

## actions

| Name | Signature |
|------|-----------|
| init | () |
| process | (data) -> Effect |
| cleanup | () |

## state idle [initial]

## state processing
> Processing

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | step | | processing | init |
| processing | | | idle | process |
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if len(machine.Actions) != 3 {
		t.Errorf("Expected 3 actions, got %d", len(machine.Actions))
	}

	for _, a := range machine.Actions {
		if a.Name == "" {
			t.Error("Expected action name")
		}
	}
}

func TestParseInvoke(t *testing.T) {
	source := `# machine Parent

## events

- CHILD_DONE
- CHILD_ERROR

## state invoking [initial]
> Invoke child

- invoke: ChildMachine input: { id: ctx.order_id }
- on_done: CHILD_DONE
- on_error: CHILD_ERROR

## state done [final]

## state error [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| invoking | CHILD_DONE | | done | |
| invoking | CHILD_ERROR | | error | |

---

# machine ChildMachine

## events

- complete

## state running [initial]

## state finished [final]

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| running | complete | | finished | |
`

	machines, err := parseOrcaMdMulti(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if len(machines) != 2 {
		t.Errorf("Expected 2 machines, got %d", len(machines))
	}

	parent := machines[0]
	if parent.Name != "Parent" {
		t.Errorf("Expected machine 'Parent', got '%s'", parent.Name)
	}

	invoking := parent.States[0]
	if invoking.Invoke == nil {
		t.Fatal("Expected invoke definition")
	}
	if invoking.Invoke.Machine != "ChildMachine" {
		t.Errorf("Expected invoke machine 'ChildMachine', got '%s'", invoking.Invoke.Machine)
	}
	if invoking.Invoke.Input == nil {
		t.Fatal("Expected input mapping")
	}
	if invoking.Invoke.Input["id"] != "ctx.order_id" {
		t.Errorf("Expected input 'ctx.order_id', got '%s'", invoking.Invoke.Input["id"])
	}
	if invoking.Invoke.OnDone != "CHILD_DONE" {
		t.Errorf("Expected on_done 'CHILD_DONE', got '%s'", invoking.Invoke.OnDone)
	}
	if invoking.Invoke.OnError != "CHILD_ERROR" {
		t.Errorf("Expected on_error 'CHILD_ERROR', got '%s'", invoking.Invoke.OnError)
	}
}

func TestParseTimeout(t *testing.T) {
	source := `# machine TimeoutMachine

## events

- start
- tick

## state waiting [initial]
> Wait with timeout

- timeout: 5s -> ready

## state ready
> Ready after timeout

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| waiting | start | | waiting | |
| ready | tick | | done | |

## state done [final]
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	waiting := machine.States[0]
	if waiting.Timeout == nil {
		t.Fatal("Expected timeout")
	}
	if waiting.Timeout.Duration != "5s" {
		t.Errorf("Expected duration '5s', got '%s'", waiting.Timeout.Duration)
	}
	if waiting.Timeout.Target != "ready" {
		t.Errorf("Expected target 'ready', got '%s'", waiting.Timeout.Target)
	}
}

func TestParseIgnore(t *testing.T) {
	source := `# machine IgnoreMachine

## events

- ignore_me
- handle_me

## state idle [initial]
> Idle state

- ignore: ignore_me

## state active
> Active state

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| idle | handle_me | | active | |
`

	machine, err := ParseOrcaMd(source)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	idle := machine.States[0]
	if len(idle.IgnoredEvents) != 1 {
		t.Errorf("Expected 1 ignored event, got %d", len(idle.IgnoredEvents))
	}
	if idle.IgnoredEvents[0] != "ignore_me" {
		t.Errorf("Expected ignored event 'ignore_me', got '%s'", idle.IgnoredEvents[0])
	}
}

func TestParseFile(t *testing.T) {
	source, err := os.ReadFile("../../orca-lang/examples/simple-toggle.orca.md")
	if err != nil {
		t.Skipf("Could not read file: %v", err)
	}

	machine, err := ParseOrcaMd(string(source))
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	// simple-toggle.orca.md has machine name "Toggle" or similar
	if machine.Name == "" {
		t.Error("Expected machine name to be set")
	}
}
