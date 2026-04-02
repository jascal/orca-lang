/**
 * Support Ticket Escalation System Demo
 *
 * Demonstrates a state machine with multiple decision tables:
 * - TicketTriaging DT: assigns priority, category, SLA
 * - TicketRouting DT: selects team/agent based on category, priority, availability
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tokenize, parse, createOrcaMachine } from './runtime/orca-shim';
import { evaluateTicketTriaging, evaluateTicketRouting } from './runtime/dt-evaluator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TicketContext {
  ticket_id: string;
  customer_id: string;
  customer_tier: string;
  issue_type: string;
  subject: string;
  message: string;
  sentiment: string;
  message_size: string;
  status: string;
  priority: string;
  category: string;
  sla: string;
  team: string;
  assigned_agent: string;
  estimated_wait: number;
  tier1_avail: boolean;
  tier2_avail: boolean;
}

// Action handlers for the ticket workflow
function createTicketHandlers() {
  return {
    triage_ticket: async (ctx: Record<string, unknown>) => {
      const ticketCtx = ctx as unknown as TicketContext;
      console.log(`[Triage] Evaluating ticket ${ticketCtx.ticket_id}...`);
      console.log(`  Issue: ${ticketCtx.issue_type || '(not specified)'}`);
      console.log(`  Customer: ${ticketCtx.customer_tier}`);
      console.log(`  Sentiment: ${ticketCtx.sentiment}`);
      console.log(`  Message size: ${ticketCtx.message_size}`);

      const decision = evaluateTicketTriaging(
        ticketCtx.issue_type || '-',
        ticketCtx.customer_tier,
        ticketCtx.sentiment,
        ticketCtx.message_size
      );

      ticketCtx.priority = decision.priority;
      ticketCtx.category = decision.category;
      ticketCtx.sla = decision.sla;
      ticketCtx.status = 'triaged';

      console.log(`  => Priority: ${decision.priority}, Category: ${decision.category}, SLA: ${decision.sla}`);
      return ticketCtx;
    },

    route_ticket: async (ctx: Record<string, unknown>) => {
      const ticketCtx = ctx as unknown as TicketContext;
      console.log(`[Route] Routing ticket ${ticketCtx.ticket_id}...`);
      console.log(`  Category: ${ticketCtx.category}`);
      console.log(`  Priority: ${ticketCtx.priority}`);

      // Simulate availability check — set on context for DT evaluation
      ticketCtx.tier1_avail = Math.random() > 0.3; // 70% chance available
      ticketCtx.tier2_avail = Math.random() > 0.2; // 80% chance available

      console.log(`  Tier1 available: ${ticketCtx.tier1_avail}`);
      console.log(`  Tier2 available: ${ticketCtx.tier2_avail}`);

      const decision = evaluateTicketRouting(
        ticketCtx.category,
        ticketCtx.priority,
        ticketCtx.tier1_avail,
        ticketCtx.tier2_avail
      );

      ticketCtx.team = decision.team;
      ticketCtx.assigned_agent = decision.agent;
      ticketCtx.estimated_wait = decision.estimatedWait;
      ticketCtx.status = 'routed';

      console.log(`  => Team: ${decision.team}, Agent: ${decision.agent}, Est. wait: ${decision.estimatedWait}min`);
      return ticketCtx;
    },

    assign_ticket: async (ctx: Record<string, unknown>) => {
      const ticketCtx = ctx as unknown as TicketContext;
      console.log(`[Assign] Ticket ${ticketCtx.ticket_id} assigned to ${ticketCtx.assigned_agent}`);
      ticketCtx.status = 'handling';
      return ticketCtx;
    },
  };
}

async function runTicketDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('SUPPORT TICKET ESCALATION SYSTEM - DECISION TABLE DEMO');
  console.log('='.repeat(60) + '\n');

  // Load the ticket workflow
  const orcaPath = join(__dirname, 'orca', 'ticket-workflow.orca.md');
  const source = readFileSync(orcaPath, 'utf-8');

  console.log('Loading TicketEscalation state machine...');
  const parseResult = parse(tokenize(source));
  console.log(`Machine: ${parseResult.machine.name}`);
  console.log(`States: ${parseResult.machine.states.map((s: any) => s.name).join(' → ')}\n`);

  // Create action handlers
  const handlers = createTicketHandlers();

  // Shared state for callback
  let transitionResolve: (() => void) | null = null;

  // Helper to wait for a state transition
  const waitForTransition = (): Promise<void> => {
    return new Promise((resolve) => {
      transitionResolve = resolve;
      setTimeout(() => {
        if (transitionResolve === resolve) {
          transitionResolve = null;
          resolve();
        }
      }, 1000); // 1 second timeout
    });
  };

  // Initial context for a VIP billing issue
  const initialContext: TicketContext = {
    ticket_id: 'TKT-2026-042',
    customer_id: 'CUST-VIP-789',
    customer_tier: 'vip',
    issue_type: 'billing',
    subject: 'Incorrect charge on invoice',
    message: 'I have been charged twice for my subscription this month. This is unacceptable and I demand an immediate refund of $99.99. This is a serious issue that needs urgent attention!!!',
    sentiment: 'negative',
    message_size: 'long',
    status: 'pending',
    priority: '',
    category: '',
    sla: '',
    team: '',
    assigned_agent: '',
    estimated_wait: 0,
    tier1_avail: false,
    tier2_avail: false,
  };

  // Create the machine with initial context
  const machineWrapper = createOrcaMachine(parseResult.machine as any, {
    context: initialContext as any,
    onTransition: (state: any) => {
      if (transitionResolve) {
        transitionResolve();
        transitionResolve = null;
      }
    },
  });

  // Register action handlers on the machine
  for (const [name, handler] of Object.entries(handlers)) {
    machineWrapper.registerAction(name, handler);
  }

  // Start the machine
  machineWrapper.start();
  console.log('Machine started\n');

  // Scenario 1: VIP Billing Issue
  console.log('-'.repeat(60));
  console.log('SCENARIO 1: VIP Customer Billing Issue (Negative, Long)');
  console.log('-'.repeat(60));

  await waitForTransition();
  machineWrapper.send({ type: 'TICKET_RECEIVED' });
  await waitForTransition();

  console.log('\n> Current state:', machineWrapper.getState().value);
  console.log('> Context:', machineWrapper.getState().context);

  machineWrapper.send({ type: 'TRIAGED' });
  await waitForTransition();

  console.log('\n> Current state:', machineWrapper.getState().value);
  console.log('> Context:', machineWrapper.getState().context);

  machineWrapper.send({ type: 'ROUTED' });
  await waitForTransition();

  console.log('\n> Current state:', machineWrapper.getState().value);
  console.log('> Context:', machineWrapper.getState().context);

  machineWrapper.send({ type: 'RESOLVED' });
  await waitForTransition();

  console.log('\n> Current state:', machineWrapper.getState().value);
  console.log('> Context:', machineWrapper.getState().context);

  machineWrapper.send({ type: 'CLOSED' });
  await waitForTransition();

  console.log('\n> Final state:', machineWrapper.getState().value);

  machineWrapper.stop();

  // Scenario 2: Standard Technical Issue
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 2: Standard Customer Technical Issue');
  console.log('='.repeat(60) + '\n');

  const initialContext2: TicketContext = {
    ticket_id: 'TKT-2026-043',
    customer_id: 'CUST-STD-123',
    customer_tier: 'standard',
    issue_type: 'technical',
    subject: 'Cannot login to dashboard',
    message: 'Getting 404 error when trying to access the dashboard.',
    sentiment: 'neutral',
    message_size: 'short',
    status: 'pending',
    priority: '',
    category: '',
    sla: '',
    team: '',
    assigned_agent: '',
    estimated_wait: 0,
  };

  const machine2 = createOrcaMachine(parseResult.machine as any, {
    context: initialContext2 as any,
    onTransition: () => {},
  });

  for (const [name, handler] of Object.entries(createTicketHandlers())) {
    machine2.registerAction(name, handler);
  }

  machine2.start();

  console.log('Ticket: ', initialContext2.subject);
  console.log('Customer tier:', initialContext2.customer_tier);
  console.log('Issue type:', initialContext2.issue_type);
  console.log();

  machine2.send({ type: 'TICKET_RECEIVED' });
  await waitForTransition();

  console.log('After triage:');
  const ctx2 = machine2.getState().context;
  console.log(`  Priority: ${ctx2.priority}, Category: ${ctx2.category}, SLA: ${ctx2.sla}`);

  machine2.send({ type: 'TRIAGED' });
  await waitForTransition();

  machine2.send({ type: 'ROUTED' });
  await waitForTransition();

  console.log('After routing:');
  console.log(`  Team: ${machine2.getState().context.team}, Agent: ${machine2.getState().context.assigned_agent}`);

  machine2.stop();

  // Scenario 3: Premium Customer Account Issue
  console.log('\n' + '='.repeat(60));
  console.log('SCENARIO 3: Premium Customer Account Issue');
  console.log('='.repeat(60) + '\n');

  const initialContext3: TicketContext = {
    ticket_id: 'TKT-2026-044',
    customer_id: 'CUST-PREM-456',
    customer_tier: 'premium',
    issue_type: 'account',
    subject: 'Update company information',
    message: 'Please update our company address to the new location.',
    sentiment: 'positive',
    message_size: 'short',
    status: 'pending',
    priority: '',
    category: '',
    sla: '',
    team: '',
    assigned_agent: '',
    estimated_wait: 0,
  };

  const machine3 = createOrcaMachine(parseResult.machine as any, {
    context: initialContext3 as any,
    onTransition: () => {},
  });

  for (const [name, handler] of Object.entries(createTicketHandlers())) {
    machine3.registerAction(name, handler);
  }

  machine3.start();

  console.log('Ticket: ', initialContext3.subject);
  console.log('Customer tier:', initialContext3.customer_tier);
  console.log('Issue type:', initialContext3.issue_type);
  console.log();

  machine3.send({ type: 'TICKET_RECEIVED' });
  await waitForTransition();

  console.log('After triage:');
  const ctx3 = machine3.getState().context;
  console.log(`  Priority: ${ctx3.priority}, Category: ${ctx3.category}, SLA: ${ctx3.sla}`);

  machine3.send({ type: 'TRIAGED' });
  await waitForTransition();

  machine3.send({ type: 'ROUTED' });
  await waitForTransition();

  console.log('After routing:');
  console.log(`  Team: ${machine3.getState().context.team}, Agent: ${machine3.getState().context.assigned_agent}`);

  machine3.stop();

  console.log('\n' + '='.repeat(60));
  console.log('ALL SCENARIOS COMPLETED');
  console.log('='.repeat(60) + '\n');
}

runTicketDemo().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
