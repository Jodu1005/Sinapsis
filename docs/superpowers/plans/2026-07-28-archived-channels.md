# Archived Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible channel archiving with a read-only archived-channel folder in the workspace sidebar.

**Architecture:** Extend the existing `archived_at` channel state through repositories and HTTP endpoints, return both active and archived channels in Bootstrap, and partition the existing sidebar by `archivedAt`. Existing message and task services become the enforcement boundary for read-only archived channels.

**Tech Stack:** TypeScript, Express, SQLite, React, Vitest, Testing Library.

## Global Constraints

- Archive preserves channel IDs, messages, Threads, task associations, and subscriptions.
- Only active channel names are globally unique.
- Archived channels are readable but never writable.

---

### Task 1: Persist and expose archive state

**Files:**
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/app.ts`
- Test: `server/app.test.ts`

- [ ] Write failing API tests for archive, restore, and a duplicate active-name restore conflict.
- [ ] Add repository `archiveChannel(channelId, occurredAt)` and `restoreChannel(channelId, occurredAt)` methods that publish `channel.changed`.
- [ ] Return both active and archived channels from Bootstrap and add archive/restore routes.
- [ ] Run `npm run test:run -- server/app.test.ts server/adapters/sqlite/sqlite-repositories.test.ts`.

### Task 2: Enforce archived channels as read-only

**Files:**
- Modify: `server/application/channel-message-service.ts`
- Modify: `server/application/task-service.ts`
- Test: `server/application/channel-message-service.test.ts`
- Test: `server/application/task-service.test.ts`

- [ ] Write failing tests that reject a message and task for an archived channel.
- [ ] Validate the channel archive state before message and task creation.
- [ ] Run `npm run test:run -- server/application/channel-message-service.test.ts server/application/task-service.test.ts`.

### Task 3: Add archived navigation and read-only UI

**Files:**
- Modify: `src/api/client.ts`
- Modify: `src/ui/RepositorySidebar.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/styles.css`
- Test: `src/ui/WorkspaceShell.test.tsx`

- [ ] Write failing UI tests for an archived folder, archive/restore controls, and disabled archived composer.
- [ ] Add typed archive/restore API calls and partition channels into active and archived sidebar lists.
- [ ] Render the archived state in the channel header and replace the composer with a read-only notice.
- [ ] Run `npm run test:run -- src/ui/WorkspaceShell.test.tsx` and `npm run build`.
