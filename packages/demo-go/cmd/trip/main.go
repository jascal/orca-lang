package main

import (
	"fmt"
	"os"
	"strings"

	"orca-runtime-go/orca_runtime_go"
)

func main() {
	// Check for failure mode flags
	failureMode := os.Args[1:]

	fmt.Println("╔════════════════════════════════════════════════════════════╗")
	fmt.Println("║     Ride-Hailing Trip Coordinator - Go Runtime Demo      ║")
	fmt.Println("╚════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// Read the orca file
	data, err := os.ReadFile("orca/trip.orca.md")
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		os.Exit(1)
	}

	// Parse multi-machine file (only parses first machine currently)
	machine, err := orca_runtime_go.ParseOrcaMd(string(data))
	if err != nil {
		fmt.Printf("Error parsing: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Loaded machine: %s\n", machine.Name)
	fmt.Printf("  States: %d\n", len(machine.States))
	fmt.Printf("  Transitions: %d\n", len(machine.Transitions))
	fmt.Printf("  Events: %d\n", len(machine.Events))
	fmt.Println()

	// Show failure mode if specified
	for _, f := range failureMode {
		fmt.Printf("Failure mode: %s\n", f)
	}

	// For now, just demonstrate parsing works
	// The full interactive demo with failure modes would require
	// implementing action handlers and the full orchestration

	if len(failureMode) == 0 {
		fmt.Println("\nDemo would run the happy path:")
		fmt.Println("  1. Request trip -> finds driver + authorizes payment")
		fmt.Println("  2. Pickup -> driver en route")
		fmt.Println("  3. In-trip -> ride to destination")
		fmt.Println("  4. Settling fare -> charge rider, pay driver")
		fmt.Println("  5. Complete")
	} else {
		if strings.Contains(failureMode[0], "no-drivers") {
			fmt.Println("\nWould demonstrate: no drivers available")
		} else if strings.Contains(failureMode[0], "payment") {
			fmt.Println("\nWould demonstrate: payment declined")
		} else if strings.Contains(failureMode[0], "no-show") {
			fmt.Println("\nWould demonstrate: rider no-show")
		} else if strings.Contains(failureMode[0], "cancel") {
			fmt.Println("\nWould demonstrate: rider cancellation")
		}
	}
}
