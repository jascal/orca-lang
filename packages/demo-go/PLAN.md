# Loan Application Processor Demo - Go Implementation Plan

## Overview
Implement Idea #3 (Loan Application Processor) as a Go demo for demo-go, demonstrating:
- Decision tables with numeric conditions (`int_range`), enum conditions, and bool conditions
- Multiple DTs in the same workflow
- Go runtime's action handler pattern

## Files Created

### 1. `orca/loan-workflow.orca.md` ✅
New Orca machine definition with states:
```
submitted [initial] → reviewed → risk_assessed → approved → disbursed [final]
                                    ↓
                                  rejected [final]
```

Context fields: applicant_id, credit_score, income, debt_ratio, employment_status, loan_amount, loan_purpose, status, risk_tier, required_approvals, interest_rate, disbursement_method, loan_terms, apr_modifier, rejection_reason

Actions: review_application, assess_risk, process_disbursement

### 2. `cmd/loan/main.go` ✅
Main entry point that:
- Parses loan-workflow.orca.md
- Runs 5 test scenarios with different credit profiles
- Registers action handlers

### 3. `internal/handlers/loan.go` ✅
Action handler implementations:
- ReviewApplicationHandler
- AssessRiskHandler
- ProcessDisbursementHandler

### 4. `internal/dt/risk_evaluator.go` ✅
Decision table implementations:
- RiskAssessment DT: credit_score, income, debt_ratio, employment → risk_tier, required_approvals, interest_rate_modifier
- Disbursement DT: risk_tier, loan_amount → disbursement_method, loan_terms, apr_modifier

## Build Issue

⚠️ **Note**: There is a pre-existing issue with the runtime-go module that prevents building from source (`go run cmd/loan/main.go` fails). The `trip` binary works because it was pre-built. This needs to be resolved separately.

The error:
```
go: errors parsing go.mod:
go.mod:1: usage: module module/path
```

This appears to be an environment-specific issue with Go module validation in Go 1.25.

## Commands (when build issue is resolved)

```bash
cd packages/demo-go
go run cmd/loan/main.go
```

## Testing Scenarios

| Scenario | credit_score | income | debt_ratio | employment | Expected risk |
|----------|--------------|--------|------------|------------|---------------|
| 1 | 780 | 95k | 0.15 | employed | low |
| 2 | 720 | 60k | 0.32 | employed | medium |
| 3 | 680 | 55k | 0.45 | self-employed | high |
| 4 | 580 | 28k | 0.52 | unemployed | very_high (rejected) |
| 5 | 655 | 48k | 0.38 | employed | medium |
