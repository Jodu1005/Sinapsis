# Channel Agent Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary channel messages receive a real Agent reply while keeping `/task` code execution separate.

**Architecture:** Introduce an in-memory `ConversationCoordinator` that selects a workspace Agent, starts or reuses a conversation-mode Runtime session, buffers text, and persists a compact Agent reply into the channel. Extend the shared Runtime request with a conversation mode so adapters can use the repository root and a read-only prompt, without task worktrees, commits, task sessions, or review evidence.

**Tech Stack:** TypeScript, Express, Vitest, SQLite message store, OpenCode/Pi/Claude Code runtime adapters, React 19.

## Global Constraints

- All workspace Agents are channel subscribers by default.
- Ordinary human messages get one reply from the earliest idle Agent.
- A precise `@mention` chooses that Agent first.
- `/task` remains a task-only flow and must not start a conversation session.
- Conversation Runtime output must become a compact Agent message; raw runtime output must never appear in the channel.
- Conversation sessions use the repository root and a read-only prompt; no worktree, commit, push, merge, task session, or task evidence is created.

---

### Task 1: Add a conversation-capable Runtime request

**Files:**
- Modify: `server/ports/runtime.ts`
- Modify: `server/adapters/runtime/opencode-runtime-adapter.ts`
- Modify: `server/adapters/runtime/pi-runtime-adapter.ts`
- Modify: `server/adapters/runtime/claude-code-runtime-adapter.ts`
- Modify: `server/adapters/runtime/*-adapter.test.ts`

**Interfaces:**
- Produces: `RuntimeTaskRequest.mode: 'task' | 'conversation'` and `initialMessage?: string`.
- Existing task callers send `mode: 'task'`; conversation callers send `mode: 'conversation'` with a channel-context prompt.

- [ ] Write failing adapter tests that start a `conversation` request and assert its initial prompt prohibits edits, commits, push, and merge.
- [ ] Run adapter tests and observe the missing mode support.
- [ ] Implement shared prompt selection: preserve existing task prompts exactly; conversation prompt contains recent channel context and the initial human message.
- [ ] Run all three adapter test files.
- [ ] Commit with `feat: add conversation runtime mode`.

### Task 2: Implement Agent selection and conversation coordination

**Files:**
- Create: `server/application/conversation-coordinator.ts`
- Create: `server/application/conversation-coordinator.test.ts`
- Modify: `server/application/channel-message-service.ts`

**Interfaces:**
- Consumes: `WorkspaceRepositories`, `RuntimeAdapter`, workspace agents, channel messages, and repository path.
- Produces: `ConversationCoordinator.dispatch(channelId, message): Promise<void>`.

- [ ] Write failing tests for earliest-idle choice, exact mention preference, session reuse, compact reply persistence, and raw output exclusion.
- [ ] Run the focused coordinator test to confirm absence.
- [ ] Implement an in-memory coordinator keyed by `(channelId, agentId)`. Resolve channel workspace/repository; select mentioned Agent or earliest idle Agent; start a conversation Runtime at repository root or enqueue input to its live session.
- [ ] Buffer `text` events per turn and persist one `senderType: 'agent'` message on `settled`; persist a short agent-authored failure response on `error`; ignore artifact events for channel output.
- [ ] Run coordinator tests.
- [ ] Commit with `feat: coordinate channel agent replies`.

### Task 3: Wire ordinary messages to conversation dispatch

**Files:**
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`
- Modify: `server/application/task-execution-coordinator.ts`
- Modify: `server/application/task-execution-coordinator.test.ts`

**Interfaces:**
- Consumes: `ConversationCoordinator.dispatch` after human message persistence.
- Produces: ordinary message API dispatches a conversation; busy task Agent behavior remains task-input-only; `/task` remains frontend task API flow.

- [ ] Write a failing app test that posts an ordinary channel message, observes the coordinator dispatch, and confirms no task is created.
- [ ] Run focused app tests to confirm absence.
- [ ] Construct the coordinator with the app's adapters and call it after `postHuman`; retain existing direct-task claim behavior only when `taskId` is present.
- [ ] Update any task coordinator runtime requests with explicit `mode: 'task'`.
- [ ] Run app and task execution tests.
- [ ] Commit with `feat: dispatch channel messages to agents`.

### Task 4: Verify the end-to-end conversation workflow

**Files:**
- Modify: `docs/superpowers/plans/2026-07-25-channel-agent-conversation.md` to mark execution evidence if needed.

- [ ] Run `npm run test:run && npm run build && git diff --check`.
- [ ] Browser-check that ordinary chat reaches the API and that the latest Agent reply renders with its own identity; do not create user-visible test messages without explicit approval.
- [ ] Review the full diff and push the branch.
