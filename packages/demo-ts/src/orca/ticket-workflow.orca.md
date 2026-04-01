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

## events

- TICKET_RECEIVED
- TRIAGED
- ROUTED
- ASSIGNED
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
> on TICKET_RECEIVED -> triaged

## state triaged "Ticket triaged, routing to team"
> on TRIAGED -> routed
> on REJECTED -> rejected

## state routed "Ticket routed to team/agent"
> on ROUTED -> handling
> on ESCALATED -> escalated

## state handling "Agent working on ticket"
> on RESOLVED -> resolved

## state resolved "Ticket resolved, awaiting closure"
> on CLOSED -> closed

## state closed [final] "Ticket closed"

## state rejected [final] "Ticket rejected"

## state escalated "Ticket escalated to higher tier"
> on ROUTED -> handling

## transitions

| Source | Event | Guard | Target | Action |
|--------|-------|-------|--------|--------|
| new | TICKET_RECEIVED | | triaged | triage_ticket |
| triaged | TRIAGED | | routed | route_ticket |
| triaged | REJECTED | | rejected | |
| routed | ROUTED | | handling | assign_ticket |
| routed | ESCALATED | | escalated | |
| handling | RESOLVED | | resolved | |
| resolved | CLOSED | | closed | |

---

## TicketTriaging Decision Table

The `triage_ticket` action evaluates these rules to determine priority, category, and SLA:

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

## TicketRouting Decision Table

The `route_ticket` action evaluates these rules to determine team, agent, and estimated wait:

| category | priority | tier1_avail | tier2_avail | → team | → agent | → estimated_wait |
|-----------|----------|-------------|-------------|--------|---------|-------------------|
| - | critical | - | - | tier3 | agent-escalation-1 | 5 |
| billing | - | - | - | billing_team | billing-agent-1 | 10 |
| account | - | - | - | account_team | account-agent-1 | 15 |
| technical | high | yes | yes | tier2 | tier2-agent-2 | 20 |
| technical | high | - | - | tier3 | tier3-agent-1 | 30 |
| technical | medium | yes | - | tier1 | tier1-agent-1 | 45 |
| technical | medium | - | yes | tier2 | tier2-agent-1 | 30 |
| technical | medium | - | - | tier3 | tier3-agent-2 | 60 |
| technical | low | yes | - | tier1 | tier1-agent-2 | 120 |
| technical | low | - | - | tier2 | tier2-agent-3 | 180 |
| general | high | - | - | tier2 | tier2-agent-4 | 30 |
| general | - | yes | - | tier1 | tier1-agent-3 | 60 |
| general | - | - | - | tier1 | tier1-agent-4 | 240 |
