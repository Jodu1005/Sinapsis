# Summit Context Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `summit` the only channel that can reset its active context without deleting task worktrees, evidence, artifacts, or historical database records.

**Architecture:** A shared channel-policy module declares the special channel capability. SQLite stores a reset boundary on channels; bootstrap and task reads filter records at or before that boundary. A service cancels active channel work, writes the boundary, and an API/UI pair exposes the action only for `summit`.

**Tech Stack:** TypeScript, Express, SQLite (`node:sqlite`), React, Vitest.

---

### Task 1: Add the channel policy and persisted reset boundary

**Files:**
- Create: `shared/channel-policy.ts`
- Modify: `tsconfig.json`
- Modify: `server/domain/workspace.ts`
- Modify: `src/domain/workspace-view.ts`
- Modify: `server/adapters/sqlite/schema.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/ports/repositories.ts`
- Test: `server/adapters/sqlite/sqlite-repositories.test.ts`

- [ ] **Step 1: Write failing repository tests.**

  Verify `contextResetAt` round-trips through a channel and that bootstrap excludes messages and tasks created at or before the reset timestamp while retaining newer records.

- [ ] **Step 2: Run the focused test to confirm it fails.**

  Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts`
  Expected: failure because the schema and repository do not expose a reset timestamp.

- [ ] **Step 3: Implement the data model.**

  Create a shared, named policy rather than checking literal channel names throughout the application:

  ```ts
  export const summitChannelName = 'summit'

  export function canResetChannelContext(channelName: string): boolean {
    return channelName.trim().toLowerCase() === summitChannelName
  }
  ```

  Add `contextResetAt?: string | null` to server and UI channel views. Add SQLite migration 13 for nullable `channels.context_reset_at`, include it in all channel reads, add a transactional `resetChannelContext`, and add channel-scoped task lookup. Filter current bootstrap messages/tasks using the channel's boundary.

- [ ] **Step 4: Run focused data tests.**

  Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts`
  Expected: PASS.

### Task 2: Implement server-side reset orchestration and endpoint

**Files:**
- Create: `server/application/channel-context-reset-service.ts`
- Modify: `server/application/conversation-coordinator.ts`
- Modify: `server/app.ts`
- Test: `server/application/channel-context-reset-service.test.ts`
- Test: `server/app.test.ts`

- [ ] **Step 1: Write failing service tests.**

  Cover allowed `summit`, denied regular channel, cancellation of active conversations, cancellation of unfinished channel tasks, and preservation of records/files outside the logical reset boundary.

- [ ] **Step 2: Run the new test to confirm it fails.**

  Run: `npm test -- server/application/channel-context-reset-service.test.ts`
  Expected: failure because reset orchestration does not exist.

- [ ] **Step 3: Add quiet conversation cancellation.**

  Add `ConversationCoordinator.cancelChannel(channelId)`. It must cancel runtime sessions, remove in-memory executions, and restore affected agents to idle without posting cancellation text into the channel.

- [ ] **Step 4: Implement the reset service.**

  The service validates the shared capability, rejects archived/non-special channels, cancels conversation runs, cancels unfinished tasks with a human-readable reason, then records `context_reset_at`. It must not invoke Git worktree, evidence, or artifact deletion APIs.

- [ ] **Step 5: Add the API route.**

  Register `POST /api/channels/:channelId/context-reset` in `server/app.ts` and return the updated channel view. Wire it to the service created with existing task and conversation coordinators.

- [ ] **Step 6: Run server tests.**

  Run: `npm test -- server/application/channel-context-reset-service.test.ts server/app.test.ts`
  Expected: PASS.

### Task 3: Add the summit-only client action and confirmation dialog

**Files:**
- Create: `src/ui/ChannelContextResetDialog.tsx`
- Modify: `src/api/client.ts`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/styles.css`
- Test: `src/ui/WorkspaceShell.test.tsx`

- [ ] **Step 1: Write failing UI tests.**

  Assert the action appears only on `summit`, opens a confirmation dialog, calls the endpoint after confirmation, clears selected task/thread state, and refreshes current channel data. Assert regular channels never render the destructive control.

- [ ] **Step 2: Run the UI test to confirm it fails.**

  Run: `npm test -- src/ui/WorkspaceShell.test.tsx`
  Expected: failure because no reset action exists.

- [ ] **Step 3: Implement the API client and dialog.**

  Add `resetChannelContext(channelId)` to `WorkspaceApi`. Reuse established dialog patterns, using explicit confirmation text that states the action hides prior context but keeps local task files.

- [ ] **Step 4: Implement conditional context-panel control.**

  Import `canResetChannelContext` from the shared policy and render the reset action only for `summit`. On success close the dialog, clear selected task/thread UI state, and reload bootstrap data.

- [ ] **Step 5: Run focused UI tests.**

  Run: `npm test -- src/ui/WorkspaceShell.test.tsx`
  Expected: PASS.

### Task 4: Rename local active channel and verify end-to-end behavior

**Files:**
- Modify: local SQLite database at `~/.sinapsis/sinapsis.sqlite` (data only)
- Modify: `README.md` only if product-facing naming is currently documented

- [ ] **Step 1: Inspect the target active channel.**

  Run a read-only SQLite query to confirm the existing active roundtable channel ID and verify no active `summit` name collision exists.

- [ ] **Step 2: Rename the existing active channel to `summit`.**

  Update only the local channel name; do not delete rows, task worktrees, evidence, artifacts, or archived channels.

- [ ] **Step 3: Run all automated checks.**

  Run: `npm test && npm run build && git diff --check`
  Expected: all tests/build pass and no whitespace errors.

- [ ] **Step 4: Manual smoke test.**

  In the running app, confirm `#summit` shows the clear action, a regular channel does not, and after confirmation the `summit` message/task panels show only post-reset content.

### Review Checklist

- [ ] The channel name and capability rule have one shared source of truth.
- [ ] Server authorization does not rely on the hidden UI action.
- [ ] Reset cancellation never creates a new visible message after the reset boundary.
- [ ] Old rows and local task output remain recoverable in storage.
- [ ] Full test suite, production build, and diff whitespace checks pass.
