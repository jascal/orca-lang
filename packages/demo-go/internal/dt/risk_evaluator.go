package dt

import "fmt"

// RiskAssessmentResult contains the output of risk assessment
type RiskAssessmentResult struct {
	RiskTier               string
	RequiredApprovals      int
	InterestRateModifier   float64
}

// DisbursementResult contains the output of disbursement decision
type DisbursementResult struct {
	DisbursementMethod string
	LoanTerms          string
	APRModifier        float64
}

// RiskAssessmentRule represents a rule in the risk assessment DT
type RiskAssessmentRule struct {
	CreditScore     string  // e.g., "750+", "700-749", "<600", "-"
	Income          string  // e.g., "50k+", "<30k", "-"
	DebtRatio       string  // e.g., "<0.3", "0.3-0.4", ">0.5", "-"
	Employment      string  // e.g., "employed", "self-employed", "unemployed", "-"
	RiskTier        string
	RequiredApprovals int
	InterestRateMod float64
}

// DisbursementRule represents a rule in the disbursement DT
type DisbursementRule struct {
	RiskTier          string
	LoanAmountRange   string  // e.g., "<10k", "10k-50k", "50k-100k", ">100k", "-"
	DisbursementMethod string
	LoanTerms         string
	APRModifier       float64
}

// matches checks if input matches the rule condition (wildcard "-" matches anything)
func matches(ruleVal, inputVal string) bool {
	if ruleVal == "-" {
		return true
	}
	return ruleVal == inputVal
}

// classifyCreditScore determines the credit score band
func classifyCreditScore(score float64) string {
	switch {
	case score >= 750:
		return "750+"
	case score >= 700:
		return "700-749"
	case score >= 650:
		return "650-699"
	case score >= 600:
		return "600-649"
	default:
		return "<600"
	}
}

// classifyIncome determines the income band
func classifyIncome(income float64) string {
	switch {
	case income >= 100000:
		return "100k+"
	case income >= 75000:
		return "75k-99k"
	case income >= 50000:
		return "50k-74k"
	case income >= 30000:
		return "30k-49k"
	default:
		return "<30k"
	}
}

// classifyDebtRatio determines the debt ratio band
func classifyDebtRatio(ratio float64) string {
	switch {
	case ratio < 0.2:
		return "<0.2"
	case ratio < 0.3:
		return "0.2-0.3"
	case ratio < 0.4:
		return "0.3-0.4"
	case ratio < 0.5:
		return "0.4-0.5"
	default:
		return ">0.5"
	}
}

// classifyLoanAmount determines the loan amount band
func classifyLoanAmount(amount float64) string {
	switch {
	case amount < 10000:
		return "<10k"
	case amount < 50000:
		return "10k-50k"
	case amount < 100000:
		return "50k-100k"
	default:
		return ">100k"
	}
}

// evaluateRiskAssessment evaluates the risk assessment decision table
// Uses first-match policy: returns the first rule that matches all conditions
func EvaluateRiskAssessment(
	creditScore float64,
	income float64,
	debtRatio float64,
	employmentStatus string,
) RiskAssessmentResult {
	creditBand := classifyCreditScore(creditScore)
	incomeBand := classifyIncome(income)
	debtBand := classifyDebtRatio(debtRatio)

	rules := []RiskAssessmentRule{
		// Excellent credit, low debt, employed = low risk
		{"750+", "-", "<0.3", "employed", "low", 1, 0.0},
		{"750+", "-", "<0.3", "self-employed", "low", 1, 0.5},

		// Good credit, low debt = low risk
		{"700-749", "-", "<0.3", "employed", "low", 1, 0.5},

		// Good credit, moderate debt = medium risk
		{"700-749", "-", "0.3-0.4", "employed", "medium", 2, 1.5},

		// Fair credit, decent income = medium risk
		{"650-699", "50k+", "<0.4", "employed", "medium", 2, 2.0},
		{"650-699", "50k+", "0.4+", "employed", "high", 2, 3.0},

		// Fair credit, any debt = medium to high
		{"600-649", "-", "<0.4", "employed", "medium", 2, 2.5},
		{"600-649", "-", "0.4+", "-", "high", 3, 4.0},

		// Poor credit = very high risk
		{"<600", "-", "-", "-", "very_high", 3, 5.0},

		// Low income + high debt = very high risk
		{"-", "<30k", "0.5+", "-", "very_high", 3, 5.0},
		{"-", "-", ">0.5", "-", "very_high", 3, 5.0},

		// Unemployed = very high risk
		{"-", "-", "-", "unemployed", "very_high", 3, 5.0},
	}

	for _, rule := range rules {
		if matches(rule.CreditScore, creditBand) &&
			matches(rule.Income, incomeBand) &&
			matches(rule.DebtRatio, debtBand) &&
			matches(rule.Employment, employmentStatus) {
			return RiskAssessmentResult{
				RiskTier:             rule.RiskTier,
				RequiredApprovals:    rule.RequiredApprovals,
				InterestRateModifier: rule.InterestRateMod,
			}
		}
	}

	// Default: high risk
	return RiskAssessmentResult{
		RiskTier:             "high",
		RequiredApprovals:    2,
		InterestRateModifier: 3.0,
	}
}

// evaluateDisbursement evaluates the disbursement decision table
// Uses first-match policy
func EvaluateDisbursement(riskTier string, loanAmount float64) DisbursementResult {
	amountBand := classifyLoanAmount(loanAmount)

	rules := []DisbursementRule{
		// Low risk, various amounts
		{"low", "<10k", "ach", "12mo", 0.0},
		{"low", "10k-50k", "ach", "24mo", 0.0},
		{"low", "50k-100k", "wire", "36mo", 0.5},
		{"low", ">100k", "wire", "48mo", 1.0},

		// Medium risk
		{"medium", "<10k", "ach", "24mo", 2.0},
		{"medium", "10k-50k", "wire", "36mo", 2.5},
		{"medium", "50k-100k", "wire", "48mo", 3.0},
		{"medium", ">100k", "wire", "60mo", 3.5},

		// High risk
		{"high", "-", "wire", "48mo", 5.0},
		{"high", ">50k", "wire", "60mo", 6.0},
	}

	for _, rule := range rules {
		if matches(rule.RiskTier, riskTier) && matches(rule.LoanAmountRange, amountBand) {
			return DisbursementResult{
				DisbursementMethod: rule.DisbursementMethod,
				LoanTerms:          rule.LoanTerms,
				APRModifier:         rule.APRModifier,
			}
		}
	}

	// Default for high risk small loans
	if riskTier == "high" {
		return DisbursementResult{
			DisbursementMethod: "wire",
			LoanTerms:          "48mo",
			APRModifier:        5.0,
		}
	}

	// Default fallback
	return DisbursementResult{
		DisbursementMethod: "ach",
		LoanTerms:          "24mo",
		APRModifier:        2.0,
	}
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
