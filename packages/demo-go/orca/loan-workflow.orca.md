# machine LoanProcessor

## context

| Field | Type | Default |
|-------|------|---------|
| applicant_id | string | "" |
| credit_score | number | 0 |
| income | number | 0 |
| debt_ratio | number | 0 |
| employment_status | string | "" |
| loan_amount | number | 0 |
| loan_purpose | string | "" |
| status | string | "pending" |
| risk_tier | string | "" |
| required_approvals | number | 0 |
| interest_rate | number | 0 |
| disbursement_method | string | "" |
| loan_terms | string | "" |
| apr_modifier | number | 0 |
| rejection_reason | string | "" |

## events

- APPLICATION_SUBMITTED
- REVIEW_COMPLETE
- RISK_ASSESSED
- APPROVED
- REJECTED
- DISBURSED

## actions

| Name | Signature |
|------|-----------|
| review_application | `(ctx) -> Context` |
| assess_risk | `(ctx) -> Context` |
| process_disbursement | `(ctx) -> Context` |

## state submitted [initial] "Loan application received"
> on APPLICATION_SUBMITTED -> reviewed

## state reviewed "Application details being verified"
> on REVIEW_COMPLETE -> risk_assessed

## state risk_assessed "Risk assessment in progress"
> on RISK_ASSESSED -> approved : check_risk_outcome
> on RISK_ASSESSED -> rejected : check_risk_outcome

## state approved "Loan approved, processing disbursement"
> on APPROVED -> disbursed

## state disbursed [final] "Funds disbursed to applicant"

## state rejected [final] "Loan application rejected"

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| submitted | APPLICATION_SUBMITTED | | reviewed | review_application |
| reviewed | REVIEW_COMPLETE | | risk_assessed | assess_risk |
| risk_assessed | RISK_ASSESSED | risk_passed | approved | process_disbursement |
| risk_assessed | RISK_ASSESSED | | rejected | |
| approved | APPROVED | | disbursed | |
| rejected | REJECTED | | rejected | |

## guards

| Name | Expression |
|------|------------|
| risk_passed | `ctx.risk_tier != "very_high"` |

## effects

| Name | Input | Output |
|------|-------|--------|
| CreditBureauCheck | `{ credit_score: number }` | `{ score: number, alert: bool }` |
| IncomeVerification | `{ income: number, employment_status: string }` | `{ verified: bool, stability_score: number }` |
| DisburseFunds | `{ method: string, amount: number, account_id: string }` | `{ transfer_id: string, status: string }` |

---

# decision_table RiskAssessment

The `assess_risk` action evaluates these rules (first-match policy).

## conditions

| Name | Type | Values |
|------|------|--------|
| credit_score | int_range | 300..850 |
| income | int_range | 0..500000 |
| debt_ratio | decimal_range | 0.0..1.0 |
| employment | enum | employed, self-employed, unemployed |

## actions

| Name | Type | Values |
|------|------|--------|
| risk_tier | enum | low, medium, high, very_high |
| required_approvals | enum | 1, 2, 3 |
| interest_rate_modifier | enum | 0.0, 0.5, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0 |

## rules

| credit_score | income | debt_ratio | employment | → risk_tier | → required_approvals | → interest_rate_modifier |
|--------------|--------|------------|------------|-------------|----------------------|--------------------------|
| 750+ | - | <0.3 | employed | low | 1 | 0.0 |
| 750+ | - | <0.3 | self-employed | low | 1 | 0.5 |
| 700-749 | - | <0.3 | employed | low | 1 | 0.5 |
| 700-749 | - | 0.3-0.4 | employed | medium | 2 | 1.5 |
| 650-699 | 50000+ | <0.4 | employed | medium | 2 | 2.0 |
| 650-699 | 50000+ | 0.4+ | employed | high | 2 | 3.0 |
| 600-649 | - | <0.4 | employed | medium | 2 | 2.5 |
| 600-649 | - | 0.4+ | - | high | 3 | 4.0 |
| <600 | - | - | - | very_high | 3 | 5.0 |
| - | <30000 | 0.5+ | - | very_high | 3 | 5.0 |
| - | - | >0.5 | - | very_high | 3 | 5.0 |
| - | - | - | unemployed | very_high | 3 | 5.0 |

---

# decision_table DisbursementDecision

The `process_disbursement` action evaluates these rules (first-match policy).

## conditions

| Name | Type | Values |
|------|------|--------|
| risk_tier | enum | low, medium, high |
| loan_amount | int_range | 0..500000 |

## actions

| Name | Type | Values |
|------|------|--------|
| disbursement_method | enum | ach, wire |
| loan_terms | enum | 12mo, 24mo, 36mo, 48mo, 60mo |
| apr_modifier | enum | 0.0, 0.5, 1.0, 2.0, 2.5, 3.0, 3.5, 5.0, 6.0 |

## rules

| risk_tier | loan_amount | → disbursement_method | → loan_terms | → apr_modifier |
|-----------|-------------|----------------------|---------------|----------------|
| low | <10000 | ach | 12mo | 0.0 |
| low | 10000-50000 | ach | 24mo | 0.0 |
| low | 50000-100000 | wire | 36mo | 0.5 |
| low | 100000+ | wire | 48mo | 1.0 |
| medium | <10000 | ach | 24mo | 2.0 |
| medium | 10000-50000 | wire | 36mo | 2.5 |
| medium | 50000-100000 | wire | 48mo | 3.0 |
| medium | 100000+ | wire | 60mo | 3.5 |
| high | - | wire | 48mo | 5.0 |
| high | 50000+ | wire | 60mo | 6.0 |
