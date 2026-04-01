package handlers

import (
	"fmt"

	orca "github.com/jascal/orca-lang/packages/runtime-go/orca_runtime_go"
	"github.com/jascal/orca-lang/packages/demo-go/internal/dt"
)

// ReviewApplicationHandler validates the loan application
func ReviewApplicationHandler(ctx orca.Context, eventPayload map[string]any) map[string]any {
	applicantID, _ := ctx["applicant_id"].(string)
	loanAmount, _ := ctx["loan_amount"].(float64)
	loanPurpose, _ := ctx["loan_purpose"].(string)

	fmt.Printf("[Review] Processing application %s\n", applicantID)
	fmt.Printf("  Loan Amount: $%.2f\n", loanAmount)
	fmt.Printf("  Purpose: %s\n", loanPurpose)

	// Basic validation
	if loanAmount <= 0 {
		ctx["status"] = "rejected"
		ctx["rejection_reason"] = "Invalid loan amount"
		return ctx
	}

	if loanAmount > 500000 {
		ctx["status"] = "rejected"
		ctx["rejection_reason"] = "Loan amount exceeds maximum"
		return ctx
	}

	ctx["status"] = "reviewed"
	fmt.Printf("  => Application validated, ready for review\n")
	return ctx
}

// AssessRiskHandler evaluates the risk assessment decision table
func AssessRiskHandler(ctx orca.Context, eventPayload map[string]any) map[string]any {
	applicantID, _ := ctx["applicant_id"].(string)
	creditScore, _ := ctx["credit_score"].(float64)
	income, _ := ctx["income"].(float64)
	debtRatio, _ := ctx["debt_ratio"].(float64)
	employmentStatus, _ := ctx["employment_status"].(string)

	fmt.Printf("[RiskAssessment] Evaluating risk for %s\n", applicantID)
	fmt.Printf("  Credit Score: %.0f\n", creditScore)
	fmt.Printf("  Income: $%.0f\n", income)
	fmt.Printf("  Debt Ratio: %.2f\n", debtRatio)
	fmt.Printf("  Employment: %s\n", employmentStatus)

	result := dt.EvaluateRiskAssessment(creditScore, income, debtRatio, employmentStatus)

	ctx["risk_tier"] = result.RiskTier
	ctx["required_approvals"] = result.RequiredApprovals
	ctx["interest_rate"] = result.InterestRateModifier
	ctx["status"] = "risk_assessed"

	fmt.Printf("  => %s\n", dt.FormatRiskSummary(result))

	if result.RiskTier == "very_high" {
		fmt.Printf("  => Application will be REJECTED due to very_high risk\n")
		ctx["rejection_reason"] = fmt.Sprintf("Risk tier %s: too many risk factors", result.RiskTier)
	}

	return ctx
}

// ProcessDisbursementHandler evaluates the disbursement decision table
func ProcessDisbursementHandler(ctx orca.Context, eventPayload map[string]any) map[string]any {
	applicantID, _ := ctx["applicant_id"].(string)
	riskTier, _ := ctx["risk_tier"].(string)
	loanAmount, _ := ctx["loan_amount"].(float64)

	fmt.Printf("[Disbursement] Processing for %s\n", applicantID)
	fmt.Printf("  Risk Tier: %s\n", riskTier)
	fmt.Printf("  Loan Amount: $%.2f\n", loanAmount)

	result := dt.EvaluateDisbursement(riskTier, loanAmount)

	ctx["disbursement_method"] = result.DisbursementMethod
	ctx["loan_terms"] = result.LoanTerms
	ctx["apr_modifier"] = result.APRModifier
	ctx["status"] = "approved"

	fmt.Printf("  => %s\n", dt.FormatDisbursementSummary(result))
	return ctx
}

// GetBaseInterestRate returns the base interest rate based on loan amount
func GetBaseInterestRate(loanAmount float64) float64 {
	switch {
	case loanAmount < 10000:
		return 8.5
	case loanAmount < 50000:
		return 7.5
	case loanAmount < 100000:
		return 6.5
	default:
		return 5.5
	}
}

// CalculateFinalAPR calculates the final APR including all modifiers
func CalculateFinalAPR(baseRate float64, riskModifier float64) float64 {
	return baseRate + riskModifier
}
