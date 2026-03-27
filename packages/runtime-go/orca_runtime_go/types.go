// Package orca_runtime_go provides a standalone Go runtime for Orca state machines.
// Zero external dependencies.
package orca_runtime_go

import (
	"fmt"
)

// Context is the machine's state context.
type Context map[string]any

// emptyStruct is an empty struct used for state values.
type emptyStruct struct{}

// StateValue represents the current state of a machine.
type StateValue struct {
	value any // string or map[string]any
}

func NewStateValue(v any) StateValue {
	return StateValue{v}
}

func (sv StateValue) String() string {
	switch v := sv.value.(type) {
	case string:
		return v
	case map[string]any:
		return formatCompound(v)
	}
	return fmt.Sprintf("%v", sv.value)
}

func formatCompound(m map[string]any) string {
	var parts []string
	for k, v := range m {
		switch vv := v.(type) {
		case map[string]any:
			parts = append(parts, formatCompound(vv))
		default:
			parts = append(parts, k)
		}
	}
	if len(parts) == 0 {
		return "{}"
	}
	return join(parts, ", ")
}

func join(parts []string, sep string) string {
	if len(parts) == 0 {
		return ""
	}
	result := parts[0]
	for i := 1; i < len(parts); i++ {
		result += sep + parts[i]
	}
	return result
}

func (sv StateValue) IsCompound() bool {
	_, ok := sv.value.(map[string]any)
	return ok
}

// Leaf returns the leaf state name.
func (sv StateValue) Leaf() string {
	switch v := sv.value.(type) {
	case string:
		return v
	case map[string]any:
		for k, vv := range v {
			if m, ok := vv.(map[string]any); ok && len(m) > 0 {
				if r := NewStateValue(m).Leaf(); r != "" {
					return r
				}
			}
			return k
		}
	}
	return ""
}

// Leaves returns all leaf state names.
func (sv StateValue) Leaves() []string {
	switch v := sv.value.(type) {
	case string:
		return []string{v}
	case map[string]any:
		var result []string
		var collect func(m map[string]any)
		collect = func(m map[string]any) {
			for k, vv := range m {
				if mm, ok := vv.(map[string]any); ok && len(mm) > 0 {
					collect(mm)
				} else {
					result = append(result, k)
				}
			}
		}
		collect(v)
		if len(result) == 0 {
			return []string{sv.String()}
		}
		return result
	}
	return []string{}
}

func (sv StateValue) Value() any {
	return sv.value
}

func (sv StateValue) Equals(other StateValue) bool {
	return fmt.Sprintf("%v", sv.value) == fmt.Sprintf("%v", other.value)
}
