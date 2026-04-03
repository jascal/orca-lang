package dt

import "fmt"

// RiskAssessmentInput defines the input conditions for the RiskAssessment decision table
type RiskAssessmentInput struct {
	CreditScore int
	Income      int
	DebtRatio   float64
	Employment  string // employed, self-employed, unemployed
}

// RiskAssessmentResult contains the output of risk assessment
type RiskAssessmentResult struct {
	RiskTier             string
	RequiredApprovals    int
	InterestRateModifier float64
}

// DisbursementInput defines the input conditions for the DisbursementDecision decision table
type DisbursementInput struct {
	RiskTier   string
	LoanAmount int
}

// DisbursementResult contains the output of disbursement decision
type DisbursementResult struct {
	DisbursementMethod string
	LoanTerms          string
	APRModifier        float64
}

// EvaluateRiskAssessment evaluates the RiskAssessment decision table (first-match policy)
// Generated from loan-workflow.orca.md formal decision table
func EvaluateRiskAssessment(creditScore float64, income float64, debtRatio float64, employmentStatus string) RiskAssessmentResult {
	input := RiskAssessmentInput{
		CreditScore: int(creditScore),
		Income:      int(income),
		DebtRatio:   debtRatio,
		Employment:  employmentStatus,
	}

	// Rule 1
	if input.CreditScore >= 750 && input.DebtRatio < 0.3 && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "low", RequiredApprovals: 1, InterestRateModifier: 0.0}
	}
	// Rule 2
	if input.CreditScore >= 750 && input.DebtRatio < 0.3 && input.Employment == "self-employed" {
		return RiskAssessmentResult{RiskTier: "low", RequiredApprovals: 1, InterestRateModifier: 0.5}
	}
	// Rule 3
	if (input.CreditScore >= 700 && input.CreditScore <= 749) && input.DebtRatio < 0.3 && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "low", RequiredApprovals: 1, InterestRateModifier: 0.5}
	}
	// Rule 4
	if (input.CreditScore >= 700 && input.CreditScore <= 749) && (input.DebtRatio >= 0.3 && input.DebtRatio <= 0.4) && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "medium", RequiredApprovals: 2, InterestRateModifier: 1.5}
	}
	// Rule 5
	if (input.CreditScore >= 650 && input.CreditScore <= 699) && input.Income >= 50000 && input.DebtRatio < 0.4 && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "medium", RequiredApprovals: 2, InterestRateModifier: 2.0}
	}
	// Rule 6
	if (input.CreditScore >= 650 && input.CreditScore <= 699) && input.Income >= 50000 && input.DebtRatio >= 0.4 && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "high", RequiredApprovals: 2, InterestRateModifier: 3.0}
	}
	// Rule 7
	if (input.CreditScore >= 600 && input.CreditScore <= 649) && input.DebtRatio < 0.4 && input.Employment == "employed" {
		return RiskAssessmentResult{RiskTier: "medium", RequiredApprovals: 2, InterestRateModifier: 2.5}
	}
	// Rule 8
	if (input.CreditScore >= 600 && input.CreditScore <= 649) && input.DebtRatio >= 0.4 {
		return RiskAssessmentResult{RiskTier: "high", RequiredApprovals: 3, InterestRateModifier: 4.0}
	}
	// Rule 9
	if input.CreditScore < 600 {
		return RiskAssessmentResult{RiskTier: "very_high", RequiredApprovals: 3, InterestRateModifier: 5.0}
	}
	// Rule 10
	if input.Income < 30000 && input.DebtRatio >= 0.5 {
		return RiskAssessmentResult{RiskTier: "very_high", RequiredApprovals: 3, InterestRateModifier: 5.0}
	}
	// Rule 11
	if input.DebtRatio > 0.5 {
		return RiskAssessmentResult{RiskTier: "very_high", RequiredApprovals: 3, InterestRateModifier: 5.0}
	}
	// Rule 12
	if input.Employment == "unemployed" {
		return RiskAssessmentResult{RiskTier: "very_high", RequiredApprovals: 3, InterestRateModifier: 5.0}
	}

	// Default: high risk
	return RiskAssessmentResult{RiskTier: "high", RequiredApprovals: 2, InterestRateModifier: 3.0}
}

// EvaluateDisbursement evaluates the DisbursementDecision decision table (first-match policy)
// Generated from loan-workflow.orca.md formal decision table
func EvaluateDisbursement(riskTier string, loanAmount float64) DisbursementResult {
	input := DisbursementInput{
		RiskTier:   riskTier,
		LoanAmount: int(loanAmount),
	}

	// Rule 1
	if input.RiskTier == "low" && input.LoanAmount < 10000 {
		return DisbursementResult{DisbursementMethod: "ach", LoanTerms: "12mo", APRModifier: 0.0}
	}
	// Rule 2
	if input.RiskTier == "low" && (input.LoanAmount >= 10000 && input.LoanAmount <= 50000) {
		return DisbursementResult{DisbursementMethod: "ach", LoanTerms: "24mo", APRModifier: 0.0}
	}
	// Rule 3
	if input.RiskTier == "low" && (input.LoanAmount >= 50000 && input.LoanAmount <= 100000) {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "36mo", APRModifier: 0.5}
	}
	// Rule 4
	if input.RiskTier == "low" && input.LoanAmount >= 100000 {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "48mo", APRModifier: 1.0}
	}
	// Rule 5
	if input.RiskTier == "medium" && input.LoanAmount < 10000 {
		return DisbursementResult{DisbursementMethod: "ach", LoanTerms: "24mo", APRModifier: 2.0}
	}
	// Rule 6
	if input.RiskTier == "medium" && (input.LoanAmount >= 10000 && input.LoanAmount <= 50000) {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "36mo", APRModifier: 2.5}
	}
	// Rule 7
	if input.RiskTier == "medium" && (input.LoanAmount >= 50000 && input.LoanAmount <= 100000) {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "48mo", APRModifier: 3.0}
	}
	// Rule 8
	if input.RiskTier == "medium" && input.LoanAmount >= 100000 {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "60mo", APRModifier: 3.5}
	}
	// Rule 9
	if input.RiskTier == "high" {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "48mo", APRModifier: 5.0}
	}
	// Rule 10
	if input.RiskTier == "high" && input.LoanAmount >= 50000 {
		return DisbursementResult{DisbursementMethod: "wire", LoanTerms: "60mo", APRModifier: 6.0}
	}

	// Default fallback
	return DisbursementResult{DisbursementMethod: "ach", LoanTerms: "24mo", APRModifier: 2.0}
}

// FormatRiskSummary returns a human-readable summary of the risk assessment
func FormatRiskSummary(result RiskAssessmentResult) string {
	return fmt.Sprintf("Risk Tier: %s, Required Approvals: %d, Rate Modifier: %.1f%%",
		result.RiskTier, result.RequiredApprovals, result.InterestRateModifier)
}

// FormatDisbursementSummary returns a human-readable summary of the disbursement decision
func FormatDisbursementSummary(result DisbursementResult) string {
	return fmt.Sprintf("Method: %s, Terms: %s, APR Modifier: %.1f%%",
		result.DisbursementMethod, result.LoanTerms, result.APRModifier)
}
