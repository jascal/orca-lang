# Benchmark Proposal: Measuring Orca's Value for LLM Code Generation

## Motivation

Orca's core claim is that separating program topology (state machine structure) from computation (action functions) produces more correct LLM-generated code with fewer iterations, because the topology is independently verifiable before any runtime code exists.

This document proposes experiments to measure that claim rigorously. The goal is not to prove Orca is universally better — it's to identify where the approach delivers measurable advantage, where it breaks even, and where it doesn't help.

---

## Hypothesis

For stateful workflow problems, LLMs generating Orca definitions will:

1. Produce fewer structural defects on the first attempt
2. Converge to correctness in fewer iterations (via verifier feedback)
3. Introduce fewer regressions when modifying existing machines
4. Maintain quality better as state count increases

The expected mechanism: Orca's tabular transition format is a natural serialization for state machines (the format textbooks use), and the verifier provides actionable feedback that closes the loop faster than test failures or human review.

---

## Problem Domain Selection

### Where Orca Should Excel

Problems with these characteristics are the target domain:

| Characteristic | Why It Matters |
|---------------|----------------|
| Many states and transitions (10+) | Holding full topology in context is hard for LLMs |
| Critical correctness properties | Deadlocks, unreachable states, unhandled events have real consequences |
| Guard-heavy branching | Mutual exclusivity and completeness are exactly what the verifier checks |
| Iterative refinement | Requirements change; modifications must not break existing behavior |
| Multi-target deployment | Same workflow in TS + Python multiplies the bug surface |

### Candidate Domains

Benchmark specs should span these categories:

- **E-commerce workflows**: order processing, payment flows, refund/return handling, subscription lifecycle
- **DevOps pipelines**: deployment state machines, CI/CD flows with approval gates, incident response
- **Agent orchestration**: multi-step LLM agent workflows with branching, retries, error recovery, tool use coordination
- **Authentication/authorization**: login flows, MFA, session management, OAuth handshakes
- **Game logic**: turn-based games, quest systems, dialogue trees, inventory management
- **Form/wizard flows**: multi-step forms with conditional paths, validation, save/resume

### Where Orca May Not Help

For honest benchmarking, include problems where Orca's advantage is expected to be small or zero:

- Simple linear workflows (3-4 states, no guards) — too simple for verification to matter
- Computation-heavy problems where the state machine is trivial but actions are complex
- Problems that don't naturally decompose into states (pure data transformation, CRUD)

---

## Comparison Targets

### Treatment A: Orca + LLM

LLM generates `.orca.md` definition, then action function stubs. Orca verifier checks structural correctness. Verifier errors fed back for iteration.

### Treatment B: Direct LLM Generation

LLM generates equivalent implementation directly in Python or TypeScript. No intermediate representation. Test suite used for iteration feedback.

Subtypes:
- **B1**: Raw implementation (switch/match pattern, custom state tracking)
- **B2**: XState v5 config (structured, but no Orca verifier)

### Treatment C: LLM + Existing Frameworks

LLM generates equivalent definitions in competing workflow frameworks:
- **C1**: LangGraph (Python, agent-focused)
- **C2**: AWS Step Functions (JSON, cloud-native)
- **C3**: Temporal workflow definitions

This comparison tests whether Orca's advantage comes from (a) the tabular format, (b) the verifier, or (c) the two-layer separation — or some combination.

---

## Experiments

### Experiment 1: First-Shot Structural Correctness

**Question**: Does Orca's format produce fewer structural defects on the LLM's first attempt?

**Setup**: 20-30 workflow specifications at three complexity tiers:
- Small: 5-7 states, 1-2 guards
- Medium: 10-15 states, 3-5 guards
- Large: 20+ states, 5+ guards, hierarchical or parallel structure

Each spec is a natural language description of the desired workflow. Same spec given to all treatments.

**Measurement**: Count structural defects per generated artifact:
- Unreachable states
- Deadlock states (non-final with no fireable outbound transitions)
- Unhandled events (state/event pairs with no transition and no explicit ignore)
- Non-deterministic transitions (overlapping guards)
- Missing initial or final states
- Unreferenced events or actions

**For Treatment A**: Run Orca verifier directly (automated).
**For Treatments B/C**: Requires either manual structural audit or building lightweight analyzers for each target format. See "Evaluation Tooling" below.

**Primary metric**: Defect rate per state (total structural defects / total states) at each complexity tier.

**Secondary metric**: First-shot pass rate (percentage of specs that produce zero defects).

### Experiment 2: Verification-Guided Iteration

**Question**: Does Orca's verifier feedback help LLMs converge to correctness faster?

**Setup**: Take all specs where the LLM produced defects on first shot. Feed errors back and allow iteration.

**Treatment A feedback**: Orca verifier output — structured, localized errors ("State `processing` is unreachable from initial state", "Event `TIMEOUT` is unhandled in state `waiting`").

**Treatment B feedback**: Test suite failures — behavioral symptoms ("test_payment_timeout failed: expected state 'retrying', got 'processing'").

**Treatment C feedback**: Framework-specific validation errors (varies by framework).

**Measurement**:
- Rounds to zero defects
- Total tokens consumed across all iterations
- Regression rate per round (how often fixing one defect introduces another)

**Primary metric**: Median iterations to structural correctness.

**Secondary metric**: Token cost to correctness (total input + output tokens across iterations).

### Experiment 3: Modification Safety

**Question**: Does Orca catch regressions that test suites miss?

**Setup**: Start with a correct 10-15 state machine (generated and verified). Apply a series of modification requests:
- Add a retry mechanism to a specific state
- Add an admin override path (reachable from multiple states)
- Split one state into two sequential states
- Add a timeout to a state that didn't have one
- Remove a state and reroute its transitions

**Measurement**:
- Detected regressions: defects caught by verifier (A) or test suite (B/C)
- Undetected regressions: defects that pass tests but violate structural properties
- False regression rate: verifier warnings that aren't actual problems

**Primary metric**: Undetected regression rate — structural defects that pass the test suite.

**Secondary metric**: Time (iterations) to confident modification.

**Critical detail**: The test suites for Treatments B/C must be representative of what a real project would have (not exhaustively testing every structural property, since real test suites don't do that). This means writing realistic but imperfect test suites — edge cases omitted, happy path bias.

### Experiment 4: Complexity Scaling

**Question**: Does Orca's advantage grow with machine complexity?

**Setup**: Generate machines at 5, 10, 15, 20, 30, and 50 states within the same domain (e.g., order processing at increasing detail levels). Each tier adds states, events, and guards to the previous tier.

**Measurement**: Plot Experiment 1's defect rate against state count for each treatment.

**Primary metric**: Slope of the defect-rate vs. state-count curve.

**Hypothesis**: Direct generation (B) degrades super-linearly with complexity. Orca (A) degrades linearly or sub-linearly because the tabular format compresses topology and the verifier catches what the LLM loses track of.

---

## Evaluation Tooling

### Automated (Treatment A)

Orca's verifier already produces machine-readable output covering reachability, deadlocks, completeness, determinism, and property checking. No additional tooling needed.

### Semi-Automated (Treatments B, C)

For fair comparison, structural analysis of generated code requires one of:

**Option 1: Target-specific analyzers**
Build lightweight structural checkers for:
- Python: analyze `match`/`if-elif` state patterns, extract transition graph
- TypeScript/XState: parse XState config, check reachability and completeness
- LangGraph: parse graph definition, check node connectivity

Pros: automated, reproducible. Cons: significant upfront investment, may not cover all code patterns LLMs produce.

**Option 2: LLM-assisted extraction**
Have the LLM extract a transition table from its own generated code, then run Orca's verifier on the extracted table. Measures whether the LLM's mental model matches its code.

Pros: works for any target language, reuses existing verifier. Cons: extraction step could mask or introduce errors.

**Option 3: Manual audit with inter-rater reliability**
Two independent reviewers audit each generated artifact against a structural checklist. Compute Cohen's kappa for inter-rater agreement.

Pros: ground truth. Cons: slow, expensive, doesn't scale.

**Recommended approach**: Option 2 as primary (scalable), validated by Option 3 on a random 20% sample (ground truth calibration).

---

## LLM Variation

Run all experiments across multiple models to distinguish format advantage from model-specific effects:

| Model | Why Include |
|-------|-------------|
| Claude Sonnet | Strong general-purpose, likely primary Orca user |
| Claude Opus | Top-tier reasoning, tests ceiling performance |
| Claude Haiku | Cost-optimized, tests floor performance |
| GPT-4o | Cross-vendor comparison |
| Gemini 2.5 Pro | Cross-vendor comparison |

If Orca helps all models roughly equally, the value is in the format and verifier. If it helps weaker models disproportionately, the value is in compensating for capability gaps. Both are useful findings.

---

## Evidence Thresholds

### Strong Evidence For

| Finding | Interpretation |
|---------|---------------|
| Orca first-shot defect rate < 50% of direct generation | Format produces meaningfully better topology |
| Orca converges in ≤ 2 iterations where direct takes ≥ 4 | Verifier feedback loop delivers practical value |
| Orca undetected regression rate near zero vs. 10-20% for tests | Verification catches what tests miss — unique value |
| Orca defect rate flat at 20+ states while direct climbs | Scalability advantage for complex workflows |

### Weak or Null Evidence

| Finding | Interpretation |
|---------|---------------|
| Orca and XState (B2) have similar defect rates | Value is in the verifier, not the format — build a verifier for XState instead |
| All treatments have low defect rates at 30+ states | LLMs have gotten good enough that verification adds marginal value |
| Action function bugs dominate topology bugs | Two-layer separation doesn't net out — topology correctness is necessary but insufficient |

### Evidence Against

| Finding | Interpretation |
|---------|---------------|
| Direct generation consistently matches Orca across complexity tiers | Format and verifier provide no measurable advantage |
| Verifier feedback doesn't reduce iteration count vs. test feedback | Structured errors aren't more actionable than test failures for LLMs |
| Orca's format constraints cause LLMs to produce worse action code | The separation hurts more than it helps |

---

## Benchmark Spec Format

Each benchmark spec should include:

```markdown
# Benchmark: [name]

## Domain
[e-commerce | devops | agent | auth | game | form]

## Complexity
[small | medium | large]

## State Count Target
[number]

## Natural Language Specification
[The workflow description given to the LLM — 1-3 paragraphs]

## Required Properties
[Structural properties the correct solution must satisfy]
- reachable: [state] from [initial]
- unreachable: [state] from [other state]
- passes_through: [state] on way to [final]
- responds: [event] leads to [outcome] within [N] steps
- invariant: [condition] always holds

## Gold Standard (Orca)
[A verified .orca.md definition — the known-correct reference]

## Evaluation Checklist
- [ ] All states reachable from initial
- [ ] No deadlocks (non-final states have outbound transitions)
- [ ] All events handled or explicitly ignored in every state
- [ ] Guards are mutually exclusive on shared transitions
- [ ] Required properties satisfied
- [Additional domain-specific checks]
```

---

## Execution Plan

This benchmark is not ready to run yet. Preconditions:

1. **Phase 4 (machine invocation) complete** — multi-machine benchmarks need invoke support
2. **10+ benchmark specs written** — enough to draw statistical conclusions at each complexity tier
3. **Evaluation tooling decided** — Option 2 (LLM extraction) needs validation against manual audit
4. **LLM API access budgeted** — 5 models x 30 specs x 3 treatments x multiple iterations = significant token spend

### Suggested Sequence

1. Write 5 small-complexity benchmark specs with gold-standard Orca definitions and property specs
2. Validate the evaluation methodology: run Experiment 1 on those 5 specs with 2 models, compare Option 2 evaluation against manual audit
3. If methodology holds, expand to 20-30 specs across all complexity tiers
4. Run full Experiment 1 across all models
5. Run Experiments 2-4 based on Experiment 1 results
6. Write up findings

---

*Document created 2026-03-26. Pre-implementation — benchmark execution depends on Phase 4 completion and benchmark spec authoring.*
