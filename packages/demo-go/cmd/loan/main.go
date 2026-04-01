package main

import (
	"fmt"
	"os"
	"strings"

	orca "github.com/jascal/orca-lang/packages/runtime-go/orca_runtime_go"
	"github.com/jascal/orca-lang/packages/demo-go/internal/handlers"
)

type LoanScenario struct {
	name         string
	applicantID  string
	creditScore  float64
	income       float64
	debtRatio    float64
	employment   string
	loanAmount   float64
	loanPurpose  string
	expectedRisk string
}

func main() {
	fmt.Println("╔════════════════════════════════════════════════════════════╗")
	fmt.Println("║        Loan Application Processor - Go Runtime Demo        ║")
	fmt.Println("║  Decision Tables: Risk Assessment + Disbursement           ║")
	fmt.Println("╚════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// Parse the loan workflow machine
	data, err := os.ReadFile("orca/loan-workflow.orca.md")
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		os.Exit(1)
	}

	machines, err := orca.ParseOrcaMdAll(string(data))
	if err != nil {
		fmt.Printf("Error parsing: %v\n", err)
		os.Exit(1)
	}

	if len(machines) == 0 {
		fmt.Println("No machines found in loan-workflow.orca.md")
		os.Exit(1)
	}

	loanMachine := machines[0]
	fmt.Printf("Loaded: %s (%d states)\n\n", loanMachine.Name, len(loanMachine.States))

	// Define test scenarios
	scenarios := []LoanScenario{
		{
			name:         "Excellent Credit, Low Risk",
			applicantID:  "APP-001",
			creditScore:  780,
			income:       95000,
			debtRatio:    0.15,
			employment:   "employed",
			loanAmount:   25000,
			loanPurpose:  "home_improvement",
			expectedRisk: "low",
		},
		{
			name:         "Good Credit, Moderate Debt",
			applicantID:  "APP-002",
			creditScore:  720,
			income:       60000,
			debtRatio:    0.32,
			employment:   "employed",
			loanAmount:   45000,
			loanPurpose:  "debt_consolidation",
			expectedRisk: "medium",
		},
		{
			name:         "Self-Employed, High Debt",
			applicantID:  "APP-003",
			creditScore:  680,
			income:       55000,
			debtRatio:    0.45,
			employment:   "self-employed",
			loanAmount:   30000,
			loanPurpose:  "business",
			expectedRisk: "high",
		},
		{
			name:         "Poor Credit, Very High Risk",
			applicantID:  "APP-004",
			creditScore:  580,
			income:       28000,
			debtRatio:    0.52,
			employment:   "unemployed",
			loanAmount:   15000,
			loanPurpose:  "personal",
			expectedRisk: "very_high",
		},
		{
			name:         "Borderline Case",
			applicantID:  "APP-005",
			creditScore:  655,
			income:       48000,
			debtRatio:    0.38,
			employment:   "employed",
			loanAmount:   75000,
			loanPurpose:  "auto",
			expectedRisk: "medium",
		},
	}

	// Run each scenario
	for i, scenario := range scenarios {
		fmt.Println(strings.Repeat("━", 60))
		fmt.Printf("SCENARIO %d: %s\n", i+1, scenario.name)
		fmt.Println(strings.Repeat("━", 60))

		// Create context for this scenario
		ctx := orca.Context{
			"applicant_id":      scenario.applicantID,
			"credit_score":      scenario.creditScore,
			"income":            scenario.income,
			"debt_ratio":        scenario.debtRatio,
			"employment_status": scenario.employment,
			"loan_amount":       scenario.loanAmount,
			"loan_purpose":      scenario.loanPurpose,
			"status":            "submitted",
			"risk_tier":         "",
			"required_approvals": 0,
			"interest_rate":     0,
			"disbursement_method": "",
			"loan_terms":        "",
			"apr_modifier":      0,
			"rejection_reason":   "",
		}

		// Create machine
		machine := orca.NewOrcaMachine(loanMachine, nil, ctx, nil)

		// Register action handlers
		machine.RegisterAction("review_application", handlers.ReviewApplicationHandler)
		machine.RegisterAction("assess_risk", handlers.AssessRiskHandler)
		machine.RegisterAction("process_disbursement", handlers.ProcessDisbursementHandler)

		// Start machine
		machine.Start()
		fmt.Printf("Initial state: %s\n\n", machine.State().String())

		// Submit application
		fmt.Println("> APPLICATION_SUBMITTED")
		machine.Send("APPLICATION_SUBMITTED", nil)
		fmt.Printf("  State: %s, Status: %s\n", machine.State().String(), ctx["status"])

		// Review complete
		fmt.Println("\n> REVIEW_COMPLETE")
		machine.Send("REVIEW_COMPLETE", nil)
		fmt.Printf("  State: %s, Status: %s\n", machine.State().String(), ctx["status"])

		// Risk assessed
		fmt.Println("\n> RISK_ASSESSED")
		machine.Send("RISK_ASSESSED", nil)
		fmt.Printf("  State: %s, Risk Tier: %s\n", machine.State().String(), ctx["risk_tier"])

		// Check if rejected
		if ctx["risk_tier"] == "very_high" {
			fmt.Printf("\n  *** REJECTED: %s ***\n", ctx["rejection_reason"])
			fmt.Printf("  Final State: %s\n\n", machine.State().String())
			machine.Stop()
			continue
		}

		// Approved
		fmt.Println("\n> APPROVED")
		machine.Send("APPROVED", nil)
		fmt.Printf("  State: %s, Disbursement: %s, Terms: %s\n",
			machine.State().String(), ctx["disbursement_method"], ctx["loan_terms"])

		// Calculate final APR
		baseRate := handlers.GetBaseInterestRate(scenario.loanAmount)
		finalAPR := handlers.CalculateFinalAPR(baseRate, ctx["apr_modifier"].(float64))
		fmt.Printf("  Final APR: %.1f%% (base %.1f%% + modifier %.1f%%)\n",
			finalAPR, baseRate, ctx["apr_modifier"].(float64))

		fmt.Printf("\n  Final State: %s\n\n", machine.State().String())
		machine.Stop()
	}

	fmt.Println(strings.Repeat("═", 60))
	fmt.Println("ALL SCENARIOS COMPLETED")
	fmt.Println(strings.Repeat("═", 60))
}
