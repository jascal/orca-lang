# decision_table PaymentRouting

## conditions

| Name | Type | Values |
|------|------|--------|
| amount_tier | enum | low, medium, high |
| customer_type | enum | new, returning, vip |
| has_fraud_flag | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| gateway | enum | stripe, adyen, manual_review |
| requires_approval | bool | |
| risk_level | enum | low, medium, high |

## rules

| amount_tier | customer_type | has_fraud_flag | → gateway | → requires_approval | → risk_level |
|-------------|---------------|----------------|-----------|---------------------|--------------|
| high | - | true | manual_review | true | high |
| high | vip | false | stripe | false | low |
| high | returning | false | adyen | false | medium |
| high | new | false | manual_review | true | medium |
| medium | - | - | stripe | false | low |
| low | - | - | stripe | false | low |
| low | vip | false | stripe | false | low |
