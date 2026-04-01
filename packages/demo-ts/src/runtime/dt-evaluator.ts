/**
 * Decision Table Evaluator - Support Ticket Escalation System
 *
 * Implements two decision tables:
 * 1. Ticket Triaging: assigns priority, category, and SLA based on
 *    issue type, customer tier, and message sentiment/size
 * 2. Ticket Routing: selects team/agent based on category, priority,
 *    and agent availability
 */

export interface TicketTriagingDecision {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'technical' | 'billing' | 'account' | 'general';
  sla: '1h' | '4h' | '24h' | '72h';
}

export interface TicketRoutingDecision {
  team: 'tier3' | 'tier2' | 'tier1' | 'billing_team' | 'account_team';
  agent: string;
  estimatedWait: number; // minutes
}

interface TriagingRule {
  issueType: string;
  customerTier: string;
  sentiment: string;
  messageSize: string;
  decision: TicketTriagingDecision;
}

interface RoutingRule {
  category: string;
  priority: string;
  availability: string;
  decision: TicketRoutingDecision;
}

/**
 * Evaluate ticket triaging decision table.
 * Uses first-match policy: returns first rule that matches all conditions.
 *
 * @param issueType - billing | technical | account | general | -
 * @param customerTier - vip | premium | standard | -
 * @param sentiment - negative | neutral | positive | -
 * @param messageSize - long (>500 chars) | short | -
 */
export function evaluateTicketTriaging(
  issueType: string,
  customerTier: string,
  sentiment: string,
  messageSize: string
): TicketTriagingDecision {
  // Classify message size if not provided
  let sizeCategory = messageSize;
  if (messageSize !== 'long' && messageSize !== 'short' && messageSize !== '-') {
    // Treat as short if small message
    sizeCategory = messageSize.length > 500 ? 'long' : 'short';
  }

  const rules: TriagingRule[] = [
    // VIP rules (highest priority)
    {
      issueType: '-', customerTier: 'vip', sentiment: 'negative', messageSize: '-',
      decision: { priority: 'critical', category: 'general', sla: '1h' }
    },
    {
      issueType: 'billing', customerTier: 'vip', sentiment: '-', messageSize: '-',
      decision: { priority: 'high', category: 'billing', sla: '1h' }
    },
    {
      issueType: 'technical', customerTier: 'vip', sentiment: '-', messageSize: '-',
      decision: { priority: 'high', category: 'technical', sla: '4h' }
    },
    {
      issueType: 'account', customerTier: 'vip', sentiment: '-', messageSize: '-',
      decision: { priority: 'medium', category: 'account', sla: '4h' }
    },

    // Premium rules
    {
      issueType: 'billing', customerTier: 'premium', sentiment: '-', messageSize: '-',
      decision: { priority: 'high', category: 'billing', sla: '4h' }
    },
    {
      issueType: 'technical', customerTier: 'premium', sentiment: '-', messageSize: '-',
      decision: { priority: 'medium', category: 'technical', sla: '24h' }
    },
    {
      issueType: '-', customerTier: 'premium', sentiment: 'negative', messageSize: '-',
      decision: { priority: 'medium', category: 'general', sla: '24h' }
    },

    // Long negative messages get escalated regardless of tier
    {
      issueType: '-', customerTier: '-', sentiment: 'negative', messageSize: 'long',
      decision: { priority: 'high', category: 'general', sla: '4h' }
    },

    // Technical issues
    {
      issueType: 'technical', customerTier: '-', sentiment: '-', messageSize: '-',
      decision: { priority: 'medium', category: 'technical', sla: '24h' }
    },

    // Billing issues
    {
      issueType: 'billing', customerTier: '-', sentiment: '-', messageSize: '-',
      decision: { priority: 'medium', category: 'billing', sla: '24h' }
    },

    // Account issues
    {
      issueType: 'account', customerTier: '-', sentiment: '-', messageSize: '-',
      decision: { priority: 'low', category: 'account', sla: '72h' }
    },

    // Default: general inquiry
    {
      issueType: '-', customerTier: '-', sentiment: '-', messageSize: '-',
      decision: { priority: 'low', category: 'general', sla: '72h' }
    },
  ];

  for (const rule of rules) {
    if (matches(rule.issueType, issueType) &&
        matches(rule.customerTier, customerTier) &&
        matches(rule.sentiment, sentiment) &&
        matches(rule.messageSize, messageSize)) {
      return rule.decision;
    }
  }

  // Default fallback
  return { priority: 'low', category: 'general', sla: '72h' };
}

/**
 * Evaluate ticket routing decision table.
 * Selects team and agent based on category, priority, and availability.
 *
 * @param category - technical | billing | account | general
 * @param priority - critical | high | medium | low
 * @param tier1Available - true if tier1 agents are available
 * @param tier2Available - true if tier2 agents are available
 */
export function evaluateTicketRouting(
  category: string,
  priority: string,
  tier1Available: boolean,
  tier2Available: boolean
): TicketRoutingDecision {
  const rules: RoutingRule[] = [
    // Critical issues always go to tier3
    {
      category: '-', priority: 'critical', availability: '-',
      decision: { team: 'tier3', agent: 'agent-escalation-1', estimatedWait: 5 }
    },

    // Billing category routes to billing team
    {
      category: 'billing', priority: '-', availability: '-',
      decision: { team: 'billing_team', agent: 'billing-agent-1', estimatedWait: 10 }
    },

    // Account category routes to account team
    {
      category: 'account', priority: '-', availability: '-',
      decision: { team: 'account_team', agent: 'account-agent-1', estimatedWait: 15 }
    },

    // High priority technical: tier2 if available, else tier3
    {
      category: 'technical', priority: 'high', availability: 'tier2',
      decision: { team: 'tier2', agent: 'tier2-agent-2', estimatedWait: 20 }
    },
    {
      category: 'technical', priority: 'high', availability: '-',
      decision: { team: 'tier3', agent: 'tier3-agent-1', estimatedWait: 30 }
    },

    // Medium priority technical: tier1 if available
    {
      category: 'technical', priority: 'medium', availability: 'tier1',
      decision: { team: 'tier1', agent: 'tier1-agent-1', estimatedWait: 45 }
    },
    {
      category: 'technical', priority: 'medium', availability: 'tier2',
      decision: { team: 'tier2', agent: 'tier2-agent-1', estimatedWait: 30 }
    },
    {
      category: 'technical', priority: 'medium', availability: '-',
      decision: { team: 'tier3', agent: 'tier3-agent-2', estimatedWait: 60 }
    },

    // Low priority technical: tier1 preferred
    {
      category: 'technical', priority: 'low', availability: 'tier1',
      decision: { team: 'tier1', agent: 'tier1-agent-2', estimatedWait: 120 }
    },
    {
      category: 'technical', priority: 'low', availability: '-',
      decision: { team: 'tier2', agent: 'tier2-agent-3', estimatedWait: 180 }
    },

    // General category: tier1 for high priority
    {
      category: 'general', priority: 'high', availability: '-',
      decision: { team: 'tier2', agent: 'tier2-agent-4', estimatedWait: 30 }
    },
    {
      category: 'general', priority: '-', availability: 'tier1',
      decision: { team: 'tier1', agent: 'tier1-agent-3', estimatedWait: 60 }
    },
    {
      category: 'general', priority: '-', availability: '-',
      decision: { team: 'tier1', agent: 'tier1-agent-4', estimatedWait: 240 }
    },
  ];

  // Determine availability string
  let availability = '-';
  if (tier1Available && tier2Available) {
    availability = 'tier1,tier2';
  } else if (tier2Available) {
    availability = 'tier2';
  } else if (tier1Available) {
    availability = 'tier1';
  }

  for (const rule of rules) {
    if (matches(rule.category, category) &&
        matches(rule.priority, priority) &&
        (rule.availability === '-' || rule.availability.includes(availability) || availability.includes(rule.availability))) {
      return rule.decision;
    }
  }

  // Default fallback
  return { team: 'tier1', agent: 'tier1-agent-1', estimatedWait: 480 };
}

/**
 * Check if an input value matches a rule condition.
 * '-' in rule means "any" (wildcard).
 */
function matches(ruleValue: string, inputValue: string): boolean {
  if (ruleValue === '-') return true;
  return ruleValue.toLowerCase() === inputValue.toLowerCase();
}
