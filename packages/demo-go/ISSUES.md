# Go Demo Issues

## Current Status (2026-03-27)

The demo parses a 5-machine `trip.orca.md` file but only returns the first machine "TripCoordinator" with **only 2 states** instead of the full hierarchy.

## Root Cause

The parsing bug is in `packages/runtime-go/orca_runtime_go/parser.go` in two functions:

### 1. `buildStatesFromEntries` (line ~736)

When processing a state that has child states, the current logic incorrectly skips child states at `level > entry.level`:

```go
if entry.level > entries[startIdx].level {
    i++
    continue
}
```

For a state at level 2 (like `requesting`), children are at level 3+ but the current condition `> 2` causes children at level 3 to be skipped.

**The symptom**: Only top-level states (idle, requesting, pickup, etc.) are returned. Nested states within compound states are lost.

### 2. `buildParallelRegions` (line ~802)

When processing parallel state regions, the condition `entries[i].level > regionLevel` incorrectly skips states at `regionLevel + 1` which are actually the child states of the region.

For `requesting [parallel]` at level 2:
- `region matching` is at level 3
- `finding_driver` is at level 4
- With `regionLevel=3`, the condition `4 > 3` is TRUE, so `finding_driver` is skipped

**The symptom**: Parallel regions have 0 states because their children (at level 4) are incorrectly skipped.

## Expected Parsing Results

The `TripCoordinator` machine should have:
- States: idle, requesting [parallel], pickup, in_trip, completing, completed, no_show, cancelled, failed
- The `requesting` parallel state should have 2 regions:
  - `matching` region: finding_driver, matched, no_drivers
  - `payment` region: authorizing, authorized, declined

## Files Involved

- `packages/runtime-go/orca_runtime_go/parser.go` - Contains the buggy functions
- `packages/demo-go/orca/trip.orca.md` - 5-machine demo file (TripCoordinator, DriverMatching, PaymentAuth, TripExecution, FareSettlement)

## Test Status

All 16 existing tests pass, but they don't cover multi-level compound states with parallel regions. The `TestParseParallel` test passes because it only has 2 levels of nesting.
