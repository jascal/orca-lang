# machine TicketEscalation

## context

| Field | Type | Default |
|-------|------|---------|
| ticket_id | string | "" |
| customer_id | string | "" |
| customer_tier | string | "standard" |
| issue_type | string | "" |
| subject | string | "" |
| message | string | "" |
| sentiment | string | "neutral" |
| message_size | string | "short" |
| status | string | "pending" |
| priority | string | "" |
| category | string | "" |
| sla | string | "" |
| team | string | "" |
| assigned_agent | string | "" |
| estimated_wait | number | 0 |
| tier1_avail | bool | false |
| tier2_avail | bool | false |

## events

- TICKET_RECEIVED
- TRIAGED
- ROUTED
- RESOLVED
- CLOSED
- ESCALATED
- REJECTED

## actions

| Name | Signature |
|------|-----------|
| triage_ticket | `(ctx) -> Context` |
| route_ticket | `(ctx) -> Context` |
| assign_ticket | `(ctx) -> Context` |

## state new [initial] "Ticket received, awaiting triage"
- ignore: *

## state triaged "Ticket triaged, routing to team"
- ignore: *

## state routed "Ticket routed to team/agent"
- ignore: *

## state handling "Agent working on ticket"
- ignore: *

## state resolved "Ticket resolved, awaiting closure"
- ignore: *

## state escalated "Ticket escalated to higher tier"
- ignore: *

## state closed [final] "Ticket closed"

## state rejected [final] "Ticket rejected"

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| new | TICKET_RECEIVED | | triaged | triage_ticket |
| triaged | TRIAGED | | routed | route_ticket |
| triaged | REJECTED | | rejected | |
| routed | ROUTED | | handling | assign_ticket |
| routed | ESCALATED | | escalated | |
| handling | RESOLVED | | resolved | |
| handling | ESCALATED | | escalated | |
| resolved | CLOSED | | closed | |
| escalated | ROUTED | | handling | assign_ticket |

---

# decision_table TicketTriaging

## conditions

| Name | Type | Values |
|------|------|--------|
| issue_type | enum | billing, technical, account, general |
| customer_tier | enum | vip, premium, standard |
| sentiment | enum | negative, neutral, positive |
| message_size | enum | long, short |

## actions

| Name | Type | Values |
|------|------|--------|
| priority | enum | critical, high, medium, low |
| category | enum | billing, technical, account, general |
| sla | enum | 1h, 4h, 24h, 72h |

## rules

| issue_type | customer_tier | sentiment | message_size | → priority | → category | → sla |
|------------|---------------|-----------|--------------|------------|------------|-------|
| - | vip | negative | - | critical | general | 1h |
| billing | vip | - | - | high | billing | 1h |
| technical | vip | - | - | high | technical | 4h |
| account | vip | - | - | medium | account | 4h |
| billing | premium | - | - | high | billing | 4h |
| technical | premium | - | - | medium | technical | 24h |
| - | premium | negative | - | medium | general | 24h |
| - | - | negative | long | high | general | 4h |
| technical | - | - | - | medium | technical | 24h |
| billing | - | - | - | medium | billing | 24h |
| account | - | - | - | low | account | 72h |
| - | - | - | - | low | general | 72h |

---

# decision_table TicketRouting

## conditions

| Name | Type | Values |
|------|------|--------|
| category | enum | billing, account, technical, general |
| priority | enum | critical, high, medium, low |
| tier1_avail | bool | |
| tier2_avail | bool | |

## actions

| Name | Type | Values |
|------|------|--------|
| team | enum | tier3, tier2, tier1, billing_team, account_team |
| assigned_agent | string | |
| estimated_wait | string | |

## rules

| category | priority | tier1_avail | tier2_avail | → team | → assigned_agent | → estimated_wait |
|----------|----------|-------------|-------------|--------|------------------|-----------------|
| - | critical | - | - | tier3 | agent-escalation-1 | 5 |
| billing | - | - | - | billing_team | billing-agent-1 | 10 |
| account | - | - | - | account_team | account-agent-1 | 15 |
| technical | high | false | true | tier2 | tier2-agent-2 | 20 |
| technical | high | - | - | tier3 | tier3-agent-1 | 30 |
| technical | medium | true | - | tier1 | tier1-agent-1 | 45 |
| technical | medium | false | true | tier2 | tier2-agent-1 | 30 |
| technical | medium | - | - | tier3 | tier3-agent-2 | 60 |
| technical | low | true | - | tier1 | tier1-agent-2 | 120 |
| technical | low | - | - | tier2 | tier2-agent-3 | 180 |
| general | high | - | - | tier2 | tier2-agent-4 | 30 |
| general | - | true | - | tier1 | tier1-agent-3 | 60 |
| general | - | - | - | tier1 | tier1-agent-4 | 240 |
