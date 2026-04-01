# machine HealthCheck

## context
```typescript
{
  results: {
    build: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    test_lang: { status: 'pending' | 'success' | 'failed', output: string, duration: number, passed: number, skipped: number },
    demo_ts: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    demo_ts_ticket: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    demo_python: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    demo_go: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    demo_nanolab: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
    examples: { status: 'pending' | 'success' | 'failed', output: string, duration: number },
  },
  currentStep: string,
  startTime: number,
  endTime: number,
  overallStatus: 'running' | 'passed' | 'failed' | 'partial',
}
```

## states
- idle [initial]
- building_orca_lang
- testing_orca_lang
- testing_demo_ts
- testing_demo_ts_ticket
- testing_demo_python
- testing_demo_go
- testing_demo_nanolab
- verifying_examples
- reporting [final]

## transitions
| idle | START | | building_orca_lang | runBuild |
| building_orca_lang | BUILD_SUCCESS | | testing_orca_lang | recordBuildSuccess |
| building_orca_lang | BUILD_FAILED | | reporting | recordBuildFailure |
| testing_orca_lang | TESTS_SUCCESS | ctx.results.test_lang.passed >= 180 | testing_demo_ts | recordTestLangSuccess |
| testing_orca_lang | TESTS_SUCCESS | ctx.results.test_lang.passed < 180 | testing_demo_ts | recordTestLangLow |
| testing_orca_lang | TESTS_FAILED | | reporting | recordTestLangFailure |
| testing_demo_ts | DEMO_SUCCESS | | testing_demo_ts_ticket | recordDemoTsSuccess |
| testing_demo_ts | DEMO_FAILED | | testing_demo_ts_ticket | recordDemoTsFailure |
| testing_demo_ts_ticket | DEMO_SUCCESS | | testing_demo_python | recordDemoTsTicketSuccess |
| testing_demo_ts_ticket | DEMO_FAILED | | testing_demo_python | recordDemoTsTicketFailure |
| testing_demo_python | DEMO_SUCCESS | | testing_demo_go | recordDemoPythonSuccess |
| testing_demo_python | DEMO_FAILED | | testing_demo_go | recordDemoPythonFailure |
| testing_demo_go | DEMO_SUCCESS | | testing_demo_nanolab | recordDemoGoSuccess |
| testing_demo_go | DEMO_FAILED | | testing_demo_nanolab | recordDemoGoFailure |
| testing_demo_nanolab | DEMO_SUCCESS | | verifying_examples | recordDemoNanolabSuccess |
| testing_demo_nanolab | DEMO_FAILED | | verifying_examples | recordDemoNanolabFailure |
| verifying_examples | EXAMPLES_SUCCESS | | reporting | recordExamplesSuccess |
| verifying_examples | EXAMPLES_FAILED | | reporting | recordExamplesFailure |

## actions
| Name | Signature |
| runBuild | `(ctx) => Context + Effect<'runCommand', { cmd: string, cwd: string, label: string }>` |
| recordBuildSuccess | `(ctx, event) => Context` |
| recordBuildFailure | `(ctx, event) => Context` |
| recordTestLangSuccess | `(ctx, event) => Context` |
| recordTestLangLow | `(ctx, event) => Context` |
| recordTestLangFailure | `(ctx, event) => Context` |
| recordDemoTsSuccess | `(ctx, event) => Context` |
| recordDemoTsFailure | `(ctx, event) => Context` |
| recordDemoTsTicketSuccess | `(ctx, event) => Context` |
| recordDemoTsTicketFailure | `(ctx, event) => Context` |
| recordDemoPythonSuccess | `(ctx, event) => Context` |
| recordDemoPythonFailure | `(ctx, event) => Context` |
| recordDemoGoSuccess | `(ctx, event) => Context` |
| recordDemoGoFailure | `(ctx, event) => Context` |
| recordDemoNanolabSuccess | `(ctx, event) => Context` |
| recordDemoNanolabFailure | `(ctx, event) => Context` |
| recordExamplesSuccess | `(ctx, event) => Context` |
| recordExamplesFailure | `(ctx, event) => Context` |

## effects
| Name | Type | Description |
| runCommand | sync | Run a shell command and return result |
