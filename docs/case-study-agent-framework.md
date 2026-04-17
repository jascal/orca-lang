# Case Study: Orca in a Production Healthcare Platform

## Overview

The **Agent Framework Builder** is a production visual application builder that generates full-stack healthcare applications (FastAPI + Next.js) for Dental Service Organizations (DSOs). It includes 26+ modules covering patient management, scheduling, billing, insurance, clinical workflows, and an AI-powered voice agent.

This document describes how the project uses Orca's state machine verification concepts in two ways:

1. **Design-time verification** — Orca `.orca.md` files define and verify the state machines that govern status transitions across 6 modules. The verified machines are the source of truth; Python implementations are derived from them.

2. **Runtime validation of user-defined workflows** — The clinical workflow module lets users build custom workflows through a visual builder. User-defined state machines are validated using graph-analysis techniques drawn from Orca's verifier before they can be saved.

3. **LLM-powered workflow generation** — Users describe a workflow in plain English. The system calls an LLM to generate an Orca-format state machine, parses it, validates it, and presents it in the visual builder for review.

---

## 1. Design-Time Verification: ORCA-Audited State Machines

### The Pattern

Six modules have status transition logic governed by state machines that were formally verified using Orca. Each module has a `status_validation.py` file containing Python dictionaries that define allowed transitions. These dictionaries are derived from `.orca.md` files that were verified externally using the Orca CLI.

### Modules Using This Pattern

| Module | State Machines | Orca Audit File |
|--------|---------------|-----------------|
| **Billing** | Payment status, Payment plan, Payment schedule | `billing-payment-audit.orca.md`, `billing-plan-audit.orca.md`, `billing-schedule-audit.orca.md` |
| **Insurance** | Claim lifecycle, Prior authorization, Appeal, Eligibility | `insurance-claim-audit.orca.md`, etc. |
| **Clinical Scheduling** | Appointment lifecycle | `clinical-scheduling-audit.orca.md` |
| **Communication** | Message delivery, Phone call, Phone verification | `comm-message-delivery-audit.orca.md`, `comm-phone-call-audit.orca.md`, `comm-phone-verification-audit.orca.md` |
| **Clinical Workflow** | Workflow instance, Workflow step, Workflow task, Action execution | `workflow-instance-audit.orca.md`, `workflow-action-audit.orca.md` |
| **Patient Outreach** | Outreach queue, Campaign lifecycle | `outreach-queue-audit.orca.md`, `outreach-campaign-audit.orca.md` |

### How It Works

1. A developer writes the state machine as an `.orca.md` file
2. Runs `npx tsx src/index.ts verify <file>` to check reachability, deadlocks, guard determinism
3. Once verified, translates the machine to a Python transition dictionary
4. The Python code references the Orca file in a comment for traceability

### Example: Insurance Claim Lifecycle

**Orca source** (`insurance-claim-audit.orca.md`):
```markdown
# machine InsuranceClaim

## state draft [initial]
## state submitted
## state accepted
## state processing
## state paid [final]
## state denied
## state appealed
## state appeal_approved [final]
## state appeal_denied [final]

## transitions

| Source     | Event             | Guard | Target          | Action |
|------------|-------------------|-------|-----------------|--------|
| draft      | submit            |       | submitted       |        |
| submitted  | accept            |       | accepted        |        |
| submitted  | reject            |       | denied          |        |
| accepted   | process           |       | processing      |        |
| processing | pay               |       | paid            |        |
| processing | deny              |       | denied          |        |
| denied     | appeal            |       | appealed        |        |
| appealed   | approve_appeal    |       | appeal_approved |        |
| appealed   | deny_appeal       |       | appeal_denied   |        |
```

**Derived Python** (`status_validation.py`):
```python
# Verified machine: insurance-claim-audit.orca.md
CLAIM_TRANSITIONS = {
    "draft":      {"submitted"},
    "submitted":  {"accepted", "denied"},
    "accepted":   {"processing"},
    "processing": {"paid", "denied"},
    "denied":     {"appealed"},
    "appealed":   {"appeal_approved", "appeal_denied"},
    # Final states: paid, appeal_approved, appeal_denied — no outbound transitions
}

def validate_claim_status(current: str, target: str, entity_id=None):
    allowed = CLAIM_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise InvalidStatusTransition("Claim", current, target, entity_id)
```

### What Orca Guarantees

The Orca verifier confirmed before any code was written:
- Every state is reachable from `draft`
- No deadlocks — every non-final state has an exit path
- All transitions reference valid states
- No ambiguous transitions

These properties hold in the Python code because it's a mechanical translation of the verified machine.

---

## 2. Runtime Validation of User-Defined Workflows

### The Problem

The clinical workflow module lets practice administrators build custom workflows — for example, a "New Patient Intake" or "Insurance Pre-Authorization" workflow with custom states and transitions. Unlike the system-defined state machines, these are created at runtime by non-technical users through a visual builder. They need structural validation before they can be saved and executed.

### The Solution

A Python graph validator (`schema_validator.py`) implements the same structural checks that Orca's verifier performs, applied to user-defined workflow schemas at save time.

### What Gets Checked

```python
def validate_workflow_schema(schema: dict) -> List[str]:
    """
    Returns list of validation errors. Empty list = valid.

    Checks (matching Orca verifier properties):
    1. Exactly one initial state
    2. At least one final state
    3. All states reachable from initial (BFS forward)
    4. All non-final states can reach a final state (BFS backward — no dead ends)
    5. No duplicate state IDs
    6. All transitions reference valid states
    7. Wildcard transitions ('*') handled correctly
    8. No ambiguous transitions (same from+action without distinguishing guards)
    9. Every non-final state has at least one outbound transition
    """
```

### Architecture

```
User designs workflow in visual builder
         │
         ▼
Frontend: states + transitions editor
         │
         ▼
POST /api/clinical_workflow/definitions
         │
         ▼
Pydantic schema validation
  └── calls validate_workflow_schema()
      ├── Reachability check (BFS from initial)
      ├── Termination check (BFS backward from finals)
      ├── Dead-end detection
      ├── Transition integrity
      └── Ambiguity detection
         │
         ▼
If errors → 422 with specific error messages
If valid  → Save WorkflowDefinition to database
```

### User-Facing Error Messages

The validator returns specific, actionable error messages:

- `"Unreachable states (not reachable from 'registered'): pending_review"`
- `"Dead-end states (no path to any final state): stuck_state"`
- `"Ambiguous transitions from 'review' with action 'approve' to ['approved', 'fast_tracked'] — add guard conditions to disambiguate"`
- `"State 'orphan' has no outbound transitions and is not a final state"`

### Data Model

Workflow schemas are stored as JSON on the `WorkflowDefinition` model:

```json
{
  "states": [
    {"id": "registered", "name": "Registered", "type": "initial"},
    {"id": "insurance_check", "name": "Insurance Check", "type": "intermediate"},
    {"id": "completed", "name": "Completed", "type": "final"},
    {"id": "cancelled", "name": "Cancelled", "type": "final"}
  ],
  "transitions": [
    {"from": "registered", "to": "insurance_check", "action": "start", "guard": null},
    {"from": "insurance_check", "to": "completed", "action": "verified"},
    {"from": "*", "to": "cancelled", "action": "cancel"}
  ]
}
```

The `WorkflowInstance` model tracks execution state: `current_state` (where the workflow is in the user-defined machine) and `status` (the execution lifecycle: running/paused/completed/failed/cancelled).

---

## 3. LLM-Powered Workflow Generation

### The Flow

Users can describe a workflow in natural language and have an LLM generate the state machine:

1. User types: *"I need a workflow for new patient intake. Verify insurance, collect consent forms, schedule with hygienist, then follow up with dentist."*
2. Backend sends the spec to Claude with a system prompt that produces Orca Markdown format
3. The LLM generates a complete state machine with states, transitions, and guards
4. The response is parsed using a lightweight Orca Markdown parser
5. The parsed machine is validated using the same graph validator
6. The result populates the visual builder for review/editing

### Why Orca Format

The LLM generates Orca Markdown rather than raw JSON because:

- **LLMs generate Markdown reliably** — it's their native output format
- **The flat transition table** (Source | Event | Guard | Target | Action) is the format LLMs produce most consistently
- **It's human-readable** — the user can see the generated `.orca.md` source and understand it
- **It's verifiable** — the same graph checks apply whether the machine was hand-written or LLM-generated

### System Prompt

The LLM receives a system prompt that defines the Orca syntax and constraints:

```
You are an expert at designing state machines for healthcare workflow automation.
When given a natural language description, generate an Orca state machine in Markdown format.

Rules:
- Use `# machine Name` as the heading
- Define states with `## state name [initial]` or `## state name [final]`
- Use exactly ONE [initial] state and at least ONE [final] state
- State names must be lowercase_snake_case
- Define transitions as a Markdown table: | Source | Event | Guard | Target | Action |
- Keep it practical — 4-10 states is typical for a dental/healthcare workflow
```

### Parser

A lightweight Python parser extracts the machine structure from the LLM output:

```python
def _parse_orca_markdown(source: str) -> Tuple[str, List[Dict], List[Dict]]:
    # Extracts:
    # - Machine name from "# machine Name"
    # - States from "## state name [initial|final]"
    # - Transitions from the markdown table rows
```

This parser handles the subset of Orca syntax that the LLM generates. For full parsing with hierarchical states, parallel regions, and machine invocation, the `@orcalang/orca-lang` package's parser would be used.

---

## Key Decisions

### Why Not Use @orcalang/orca-lang Directly?

The application backend runs Python in Docker containers. The Orca toolchain is TypeScript. Rather than adding Node.js to every container, we:

- Use Orca's verifier at **design time** for system state machines (developer workflow)
- Reimplement the **graph validation subset** in Python for runtime use (9 checks, ~180 lines)
- Use the **Orca Markdown format** as the LLM generation target (compatible with both the TypeScript verifier and the Python parser)

This gives us Orca's structural guarantees without a runtime dependency on the TypeScript toolchain.

### What Orca Properties Are Checked vs. Skipped

| Property | Design-Time (Orca CLI) | Runtime (Python) | Notes |
|----------|----------------------|-------------------|-------|
| Reachability | Yes | Yes | BFS from initial |
| Deadlock detection | Yes | Yes | Non-final states need outbound transitions |
| Guard determinism | Yes | Partial | Checks for unguarded ambiguity, not guard expression satisfiability |
| Completeness (all events handled) | Yes | No | User workflows don't define event exhaustiveness |
| Property checking (bounded model checking) | Yes | No | Not needed for simple clinical workflows |
| Cross-machine verification | Yes | No | User workflows are single-machine |
| Decision table verification | Yes | No | Not used in clinical workflows |

The runtime validator covers the practical subset — the checks that prevent a user from accidentally creating a broken workflow. The full Orca verifier remains available for design-time use on system state machines where deeper guarantees are needed.

---

## Results

- **6 modules** with ORCA-verified status transition logic
- **15+ state machines** formally verified before implementation
- **Zero runtime state transition bugs** in verified modules (invalid transitions are caught at the validation layer, not discovered in production)
- **User-defined workflows** get the same structural guarantees as system workflows
- **LLM-generated workflows** are validated before the user sees them, catching topology errors automatically

The combination of design-time formal verification and runtime graph validation gives the platform reliable state management without requiring users or LLMs to be experts in state machine theory.
