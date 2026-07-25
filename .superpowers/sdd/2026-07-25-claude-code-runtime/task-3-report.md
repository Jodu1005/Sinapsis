# Task 3 Report

## Date

- 2026-07-25

## Scope

- Task 3: service wiring and runtime refresh
- Constraints followed:
  - kept changes on the server/test side only
  - did not modify UI
  - wrote failing tests before implementation

## Changes

- Added `AgentService.refreshAvailability(agentId)` in `server/application/agent-service.ts`.
- Extended the Agent workspace/repository read path so persisted Agents can be loaded by id:
  - `server/ports/repositories.ts`
  - `server/adapters/sqlite/sqlite-repositories.ts`
  - `server/app.ts` repository catalog bridge
- Implemented guarded refresh behavior:
  - non-busy `available/unverified` Agents move to `idle`
  - non-busy `missing/unhealthy` Agents move to `offline`
  - `busy` Agents are probed but never have their status changed
- Added `POST /api/agents/:agentId/refresh-runtime` and sanitized its response so env values are not returned.
- Wired `ClaudeCodeRuntimeAdapter` into the default service runtime composition in `server/app.ts`.
- Added coordinator coverage proving a `claude-code` claim selects the Claude adapter.
- Fixed the runtime health integration assertion to include the `claude-code` runtime-command pair.

## TDD Notes

- Red:
  - added failing tests in:
    - `server/application/agent-service.test.ts`
    - `server/app.test.ts`
    - `server/application/task-execution-coordinator.test.ts`
    - `server/integration/local-workspace-flow.test.ts`
  - ran:
    - `npm run test:run -- server/application/agent-service.test.ts server/app.test.ts server/application/task-execution-coordinator.test.ts server/integration/local-workspace-flow.test.ts`
  - confirmed expected failures:
    - `AgentService.refreshAvailability` missing
    - `/api/agents/:agentId/refresh-runtime` returned 404
- Green:
  - implemented the refresh service flow, app route, repository lookup, and Claude runtime wiring
  - re-ran the focused tests until all were green

## Verification

- `npm run test:run -- server/application/agent-service.test.ts server/app.test.ts server/application/task-execution-coordinator.test.ts`
  - Passed: 39 tests
- `npm run test:run -- server/integration/local-workspace-flow.test.ts`
  - Passed: 2 tests
- `npm run build`
  - Passed

## Risks

- The refresh endpoint intentionally returns only the sanitized persisted Agent view; it does not expose raw detector results.
- Busy Agents are still probed during refresh but deliberately keep their current status to avoid stomping active execution state.

## Commit

- `feat: refresh managed runtime availability`
