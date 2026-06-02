---
"@orcalang/orca-lang": patch
---

v0.1.29 — runtime-python QA fixes (RT-06/07/12/14).

The functional changes are in `orca-runtime-python`: `event.*` guards now resolve
against the event payload (e.g. `event.amount > 100`), ordered comparisons fail
closed on null/non-numeric operands instead of a lexicographic fallback, `on_entry`
runs alongside `invoke` instead of being dropped, and `resume()`/`restore()`
rehydrate invoked child machines and `active_invoke` (so a machine that crashed
inside an invoke state is no longer wedged). The npm packages are version-bumped to
keep the release train in lockstep — no functional changes to them. See
`reports/python-runtime-qa-report.md`.
