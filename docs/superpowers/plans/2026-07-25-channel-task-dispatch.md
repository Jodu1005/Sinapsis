# Channel Task Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add workspace channels and turn explicit `/task` chat commands into queued tasks owned by the current channel.

**Architecture:** Extend the existing repository channel API through the typed frontend client. Add a small pure parser for message intent and route parsed task commands to the existing task endpoint with an explicit `channelId`; update `TaskService` to validate this channel belongs to the requested repository instead of always choosing `general`.

**Tech Stack:** React 19, TypeScript, Vitest, Express, SQLite-backed repository ports, lucide-react.

## Global Constraints

- Ordinary chat text and plain `@mention` text must remain ordinary channel messages.
- Only `/task` followed by non-empty task content creates a task.
- The first matching `@mention` in a task command is the optional direct agent assignment.
- New tasks must use the selected channel ID, so lifecycle replies stay in that channel.
- New channels are created in the current workspace's first work directory, matching the current new-task default.
- Keep raw Agent runtime output out of the channel timeline.

---

### Task 1: Preserve explicit task channel ownership in the backend

**Files:**
- Modify: `server/application/task-service.ts:8-64`
- Modify: `server/app.ts:123-141`
- Modify: `server/application/task-service.test.ts`
- Modify: `server/app.test.ts`

**Interfaces:**
- Consumes: `POST /api/repositories/:repositoryId/tasks` and existing `CreateTaskInput.channelId`.
- Produces: `CreateLabeledTaskInput.channelId?: string` and a task whose `channelId` is the validated requested channel, or the repository `general` channel when omitted.

- [ ] **Step 1: Write failing TaskService tests for an explicit valid channel and a foreign channel**

```ts
expect(service.createTask({ repositoryId: repository.id, channelId: build.id, title: 'Build', description: 'Build', acceptanceCriteria: 'Pass' }).channelId).toBe(build.id)
expect(() => service.createTask({ repositoryId: repository.id, channelId: foreign.id, title: 'Build', description: 'Build', acceptanceCriteria: 'Pass' })).toThrow('does not belong')
```

- [ ] **Step 2: Run the focused service tests to verify they fail**

Run: `npm run test:run -- server/application/task-service.test.ts`

Expected: FAIL because the service input does not accept `channelId` and always selects `general`.

- [ ] **Step 3: Add and validate the optional channel field**

```ts
channelId?: string
const channel = input.channelId
  ? repository.channels.find((candidate) => candidate.id === input.channelId)
  : repository.channels.find((candidate) => candidate.name === 'general')
if (!channel) throw new NotFoundError(`Channel ${input.channelId ?? 'general'} does not belong to repository ${repository.id}.`)
```

Pass `channel.id` to `CreateTaskInput.channelId`, retaining the general-channel fallback for the existing task composer.

- [ ] **Step 4: Extend the HTTP request allow-list and mapping**

```ts
assertOnlyKeys(body, ['title', 'description', 'acceptanceCriteria', 'labels', 'directAgentId', 'channelId', 'timeoutMs', 'leaseTtlMs', 'maxRetries'])
channelId: optionalString(body, 'channelId'),
```

Add an app test that posts a valid `channelId` and receives a task with that same channel ID.

- [ ] **Step 5: Run backend verification**

Run: `npm run test:run -- server/application/task-service.test.ts server/app.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit backend channel ownership**

```bash
git add server/application/task-service.ts server/application/task-service.test.ts server/app.ts server/app.test.ts
git commit -m "feat: create tasks in selected channels"
```

### Task 2: Add typed channel creation and command parsing

**Files:**
- Modify: `src/api/client.ts:3-59`
- Create: `src/domain/message-intent.ts`
- Create: `src/domain/message-intent.test.ts`

**Interfaces:**
- Consumes: `WorkspaceApi`, `CreateTaskRequest`, and `AgentView.mentionName`.
- Produces: `WorkspaceApi.createChannel(repositoryId, { name })` and `parseMessageIntent(body, agents): MessageIntent`.

- [ ] **Step 1: Write parser tests**

```ts
expect(parseMessageIntent('大家同步一下。', agents)).toEqual({ kind: 'message', body: '大家同步一下。' })
expect(parseMessageIntent('/task 修复按钮', agents)).toMatchObject({ kind: 'task', body: '修复按钮', directAgentId: undefined })
expect(parseMessageIntent('/task @newton 修复按钮', agents)).toMatchObject({ kind: 'task', body: '修复按钮', directAgentId: 'agent-pi' })
expect(parseMessageIntent('/task @missing 修复按钮', agents)).toEqual({ kind: 'error', message: '找不到 Agent @missing。' })
expect(parseMessageIntent('/task @newton', agents)).toEqual({ kind: 'error', message: '请补充任务内容。' })
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run: `npm run test:run -- src/domain/message-intent.test.ts`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement the pure intent parser**

```ts
export type MessageIntent =
  | { kind: 'message'; body: string }
  | { kind: 'task'; body: string; directAgentId?: string }
  | { kind: 'error'; message: string }
```

Use `body.trim()`, only recognize `/task` at the beginning, match the first `@` token, resolve it against `agent.mentionName`, remove the resolved token, and preserve all remaining text as the task body.

- [ ] **Step 4: Extend the client contract**

```ts
createChannel(repositoryId: string, input: { name: string }): Promise<ChannelView>
export interface CreateTaskRequest { /* existing fields */ channelId?: string }
```

Implement `createChannel` with `POST /api/repositories/${repositoryId}/channels` and serialize the optional `channelId` through the existing task request.

- [ ] **Step 5: Run focused frontend unit tests**

Run: `npm run test:run -- src/domain/message-intent.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit frontend contracts**

```bash
git add src/api/client.ts src/domain/message-intent.ts src/domain/message-intent.test.ts
git commit -m "feat: parse chat task commands"
```

### Task 3: Add channel creation UI and dispatch task commands from chat

**Files:**
- Create: `src/ui/ChannelCreateDialog.tsx`
- Create: `src/ui/ChannelCreateDialog.test.tsx`
- Modify: `src/ui/RepositorySidebar.tsx:22-40`
- Modify: `src/ui/MessageComposer.tsx:4-24`
- Modify: `src/ui/WorkspaceShell.tsx:17-145`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `WorkspaceApi.createChannel`, `parseMessageIntent`, `TaskService` HTTP support from Task 1, and `useModalDialog`.
- Produces: a channel plus-button, `ChannelCreateDialog`, and `MessageComposer` dispatch feedback.

- [ ] **Step 1: Write failing component tests**

```tsx
await user.click(screen.getByRole('button', { name: '添加频道' }))
await user.type(screen.getByLabelText('频道名称'), 'release')
await user.click(screen.getByRole('button', { name: '创建频道' }))
expect(api.createChannel).toHaveBeenCalledWith('repository-1', { name: 'release' })

await user.type(screen.getByRole('textbox', { name: '发送消息' }), '/task @dev 修复导航')
await user.click(screen.getByRole('button', { name: '发送消息' }))
expect(api.createTask).toHaveBeenCalledWith('repository-1', expect.objectContaining({ channelId: 'channel-general', title: '修复导航', directAgentId: 'agent-1' }))
expect(api.postMessage).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run component tests to verify they fail**

Run: `npm run test:run -- src/ui/WorkspaceShell.test.tsx src/ui/ChannelCreateDialog.test.tsx`

Expected: FAIL because the add-channel control, dialog, and command dispatch do not exist.

- [ ] **Step 3: Implement the accessible channel dialog and sidebar trigger**

Use `useModalDialog`, a required `频道名称` input, close button, cancel button, inline API error, and a primary `创建频道` button. Add a `Plus` icon button with accessible name `添加频道` beside the channel section title.

- [ ] **Step 4: Route message intent in WorkspaceShell**

```ts
const intent = parseMessageIntent(body, workspace.agents)
if (intent.kind === 'error') throw new Error(intent.message)
if (intent.kind === 'message') return api.postMessage(selection.channel.id, { body: intent.body })
const task = await api.createTask(selection.repository.id, {
  title: intent.body,
  description: intent.body,
  acceptanceCriteria: '任务完成后在当前频道说明结果。',
  labels: [],
  directAgentId: intent.directAgentId,
  channelId: selection.channel.id,
})
```

After either successful branch, refresh. For a task branch, select the task, open context, and return a success message from the callback so the composer can render `任务已派发。`.

- [ ] **Step 5: Update MessageComposer result feedback**

Change its callback type to `Promise<{ notice?: string } | void>`, preserve existing error behavior, and render the returned notice as a non-error `role="status"` message. Keep clearing the input only after successful completion.

- [ ] **Step 6: Run focused UI verification**

Run: `npm run test:run -- src/ui/WorkspaceShell.test.tsx src/ui/ChannelCreateDialog.test.tsx src/domain/message-intent.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit UI workflow**

```bash
git add src/ui/ChannelCreateDialog.tsx src/ui/ChannelCreateDialog.test.tsx src/ui/RepositorySidebar.tsx src/ui/MessageComposer.tsx src/ui/WorkspaceShell.tsx src/ui/WorkspaceShell.test.tsx src/styles.css
git commit -m "feat: add channels and dispatch chat tasks"
```

### Task 4: Run end-to-end verification

**Files:**
- Modify: no production files expected.

**Interfaces:**
- Consumes: completed tasks 1-3.
- Produces: validated local UI and a pushed feature branch.

- [ ] **Step 1: Run all tests and production build**

Run: `npm run test:run && npm run build && git diff --check`

Expected: all tests PASS, TypeScript clean, and Vite production build succeeds.

- [ ] **Step 2: Browser-check the local workflow**

At `http://localhost:5173/`, create a channel, verify it appears and is selected, then submit `/task <description>` in that channel. Verify the task appears in the task list and that no duplicate plain human message is added.

- [ ] **Step 3: Commit and push the finished feature**

```bash
git status --short
git push
```

Expected: only intentional product changes are committed; untracked local metadata remains untouched.
