package main

import (
	"fmt"
	"os"
	"strings"

	orca "orca-runtime-go/orca_runtime_go"
)

const runID = "trip-demo"

func main() {
	resumeMode := len(os.Args) > 1 && os.Args[1] == "--resume"

	fmt.Println("╔════════════════════════════════════════════════════════════╗")
	fmt.Println("║      Ride-Hailing Trip Coordinator — Go Runtime Demo       ║")
	fmt.Println("╚════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// ── Parse all 5 machines ──────────────────────────────────────────────────
	data, err := os.ReadFile("orca/trip.orca.md")
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		os.Exit(1)
	}
	machines, err := orca.ParseOrcaMdAll(string(data))
	if err != nil {
		fmt.Printf("Error parsing: %v\n", err)
		os.Exit(1)
	}

	byName := make(map[string]*orca.MachineDef)
	for _, m := range machines {
		byName[m.Name] = m
	}

	fmt.Println("── Machines ─────────────────────────────────────────────────")
	for _, m := range machines {
		effectNames := make([]string, 0, len(m.Effects))
		for _, e := range m.Effects {
			effectNames = append(effectNames, e.Name)
		}
		effectsStr := "—"
		if len(effectNames) > 0 {
			effectsStr = strings.Join(effectNames, ", ")
		}
		fmt.Printf("  %-20s  %2d states  effects: %s\n", m.Name, len(m.States), effectsStr)
	}
	fmt.Println()

	// ── Logging: ConsoleSink + FileSink via MultiSink ─────────────────────────
	if err := os.MkdirAll("runs/trip", 0o755); err != nil {
		fmt.Printf("Error creating runs dir: %v\n", err)
		os.Exit(1)
	}
	fileSink, err := orca.NewFileSink("runs/trip/audit.jsonl")
	if err != nil {
		fmt.Printf("Error opening log: %v\n", err)
		os.Exit(1)
	}
	defer fileSink.Close()
	sink := orca.NewMultiSink(&orca.ConsoleSink{}, fileSink)

	// ── Persistence ───────────────────────────────────────────────────────────
	persistence := orca.NewFilePersistence("runs/trip")

	// ── FareSettlement machine ────────────────────────────────────────────────
	fareSettlement, ok := byName["FareSettlement"]
	if !ok {
		fmt.Println("FareSettlement machine not found")
		os.Exit(1)
	}

	ctx := orca.Context{
		"actual_distance":  5.2,
		"actual_duration":  12.0,
		"surge_multiplier": 1.1,
		"pre_auth_id":      "pre-auth-abc123",
		"driver_id":        "driver-xyz789",
	}

	// Track the last sent event so we can include it in log entries.
	var lastEvent string
	machine := orca.NewOrcaMachine(fareSettlement, nil, ctx,
		func(from, to orca.StateValue) {
			entry := orca.MakeEntry(runID, "FareSettlement", lastEvent,
				from.String(), to.String(), map[string]any{})
			sink.Write(entry) //nolint:errcheck
		},
	)

	send := func(event string) {
		lastEvent = event
		if err := machine.Send(event, nil); err != nil {
			fmt.Printf("  [error] %v\n", err)
		}
	}

	fmt.Println("── FareSettlement run ───────────────────────────────────────")

	if resumeMode {
		// ── Resume from checkpoint ────────────────────────────────────────────
		snap, err := persistence.Load(runID)
		if err != nil || snap == nil {
			fmt.Println("No checkpoint found — run without --resume first")
			os.Exit(1)
		}
		if err := machine.Resume(snap); err != nil {
			fmt.Printf("Resume error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("  Resumed from checkpoint at state: %s\n\n", machine.State().String())

		send("RIDER_CHARGED")
		send("DRIVER_PAID")
		send("RECEIPTS_SENT")
	} else {
		// ── Happy path ────────────────────────────────────────────────────────
		machine.Start()
		fmt.Printf("  Initial state: %s\n\n", machine.State().String())

		send("FARE_CALCULATED")

		// Save checkpoint after fare is calculated
		snap := machine.Snapshot()
		if err := persistence.Save(runID, snap); err != nil {
			fmt.Printf("  [warn] checkpoint save failed: %v\n", err)
		} else {
			fmt.Printf("\n  ✓ Checkpoint saved at state: %s\n", machine.State().String())
			fmt.Println("    (run with --resume to continue from here)\n")
		}

		send("RIDER_CHARGED")
		send("DRIVER_PAID")
		send("RECEIPTS_SENT")
	}

	fmt.Printf("\n  Final state: %s\n", machine.State().String())
	fmt.Println()
	fmt.Println("── Audit log ────────────────────────────────────────────────")
	fmt.Println("  Written to: runs/trip/audit.jsonl")
}
