# Claude Code Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code as a managed Runtime and let users explicitly revalidate non-busy Agent runtimes into the idle pool.

**Architecture:** Add `claude-code` to the existing runtime discriminator and implement a dedicated short-lived print/stream-json adapter. Add a service command that probes persisted Agent commands and only updates non-busy statuses, then expose it as a sidebar icon command.

**Tech Stack:** Node.js, TypeScript, Express, React, Vitest, existing ProcessRunner and LF JSONL parser.

## Global Constraints

- Claude Code uses existing local login/default model and no Sinapsis API key storage.
- Launch only with `claude -p --output-format stream-json --permission-mode acceptEdits`; never use bypass flags.
- Initial turns use a generated UUID in `--session-id`; queued input launches a new `--resume <session-id>` turn.
- Child processes use argument arrays and `shell: false`; raw output stays task evidence.
- Refresh preserves busy Agents; available/unverified non-busy Agents become idle and missing/unhealthy non-busy Agents become offline.

---

### Task 1: Runtime Types and Health

**Files:**
- Modify: `server/adapters/runtime/runtime-profile.ts`
- Modify: `server/domain/agent.ts`
- Modify: `src/domain/workspace-view.ts`
- Modify: `src/api/client.ts`
- Modify: `scripts/runtime-health-check.mjs`
- Test: `server/application/agent-service.test.ts`

- [ ] Write a failing test: `resolveRuntimeProfile('claude-code')` returns `{ command: 'claude', args: [], policy: 'task-worktree' }`.
- [ ] Run `npm run test:run -- server/application/agent-service.test.ts`; expect the unsupported discriminator to fail.
- [ ] Add `claude-code` to every runtime union and preset, and add `{ runtime: 'claude-code', command: 'claude' }` to health-check defaults.
- [ ] Run `npm run test:run -- server/application/agent-service.test.ts && npm run build`; expect pass.
- [ ] Commit `feat: add claude code runtime profile`.

### Task 2: Claude Code Adapter

**Files:**
- Create: `server/adapters/runtime/claude-code-runtime-adapter.ts`
- Create: `server/adapters/runtime/claude-code-runtime-adapter.test.ts`

**Interfaces:** Produces `ClaudeCodeRuntimeAdapter implements RuntimeAdapter`; consumes `RuntimeTaskRequest`, `ProcessRunner`, `LfJsonlParser`, and `cancel(session)`.

- [ ] Write failing tests for initial args `-p --output-format stream-json --permission-mode acceptEdits --session-id <uuid>`, `--resume` follow-up, stream text/tool/error translation, successful final settling, cancellation, and token argument redaction.
- [ ] Run `npm run test:run -- server/adapters/runtime/claude-code-runtime-adapter.test.ts`; expect adapter-not-found failure.
- [ ] Implement an adapter that generates a `randomUUID()` session, launches in the task worktree, saves raw chunks, starts queued input before settling, emits `error` on nonzero exit, and sanitizes exit metadata.
- [ ] Run `npm run test:run -- server/adapters/runtime/claude-code-runtime-adapter.test.ts && npm run build`; expect pass.
- [ ] Commit `feat: add claude code runtime adapter`.

### Task 3: Service Wiring and Runtime Refresh

**Files:**
- Modify: `server/application/agent-service.ts`
- Modify: `server/application/agent-service.test.ts`
- Modify: `server/application/task-execution-coordinator.ts`
- Modify: `server/application/task-execution-coordinator.test.ts`
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`

**Interfaces:** Produces `AgentService.refreshAvailability(agentId): Promise<Agent>` and `POST /api/agents/:agentId/refresh-runtime`.

- [ ] Write failing tests: successful refresh sets an offline Agent to idle; missing/unhealthy sets non-busy Agent offline; busy stays busy; route returns a sanitized Agent; a claude-code claim selects the Claude adapter.
- [ ] Run `npm run test:run -- server/application/agent-service.test.ts server/app.test.ts server/application/task-execution-coordinator.test.ts`; expect failures.
- [ ] Implement persisted-Agent lookup, detector probe, guarded status transition, endpoint, and application composition mapping for `ClaudeCodeRuntimeAdapter`.
- [ ] Run the same focused command plus `npm run build`; expect pass.
- [ ] Commit `feat: refresh managed runtime availability`.

### Task 4: Workspace Controls

**Files:**
- Modify: `src/ui/AgentCreateDialog.tsx`
- Modify: `src/ui/AgentStatusList.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/ui/AgentConfigDialog.tsx`

- [ ] Write failing UI tests for a `Claude Code` runtime option and an icon-only `重新检测 Agent Runtime` command that calls `api.refreshAgentRuntime('agent-1')`.
- [ ] Run `npm run test:run -- src/ui/WorkspaceShell.test.tsx`; expect failures.
- [ ] Implement the option, Lucide refresh icon with tooltip, disabled in-flight state, bootstrap refresh, and Claude Code configuration copy.
- [ ] Run `npm run test:run -- src/ui/WorkspaceShell.test.tsx && npm run build`; expect pass.
- [ ] Commit `feat: manage claude code agents in workspace`.

### Task 5: Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-25-claude-code-runtime-design.md`

- [ ] Document local Claude login, the explicit revalidation control, and guarded status transitions.
- [ ] Run `npm run test:run && npm run build && npm run runtime:check && git diff --check`; expect all pass and all three local CLIs available.
- [ ] Browser smoke-test `http://localhost:5173/`: refresh existing OpenCode/Pi Agents to `空闲`, create a Claude Code Agent, verify it becomes `空闲`, and verify no credentials are shown.
- [ ] Commit `docs: explain managed claude code runtime`.
