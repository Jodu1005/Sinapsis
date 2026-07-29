# Channel Membership And Workspace Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent, Channel, and Workspace independent entities, with human-managed Agent membership, configurable channel-workspace bindings, and automatic all-Agent membership for `summit`.

**Architecture:** Preserve the current SQLite tables as compatibility storage while moving all business decisions into explicit membership, workspace-binding, and channel-policy services. Expose global Agents and Channels in bootstrap data, require every code task to select a bound Workspace, and run pure channel conversations in a neutral service-owned directory.

**Tech Stack:** TypeScript, Express, SQLite (`node:sqlite`), React, Vitest, Testing Library.

## Global Constraints

- `summit` is identified by `systemKey = "summit"`; display names never determine special behavior.
- Ordinary channel Agent membership is changed only by human-control API routes.
- `summit` always resolves all current Agents dynamically and never persists membership rows.
- A channel binds zero to `maxWorkspaceBindingsPerChannel` Workspaces; the default is exactly `5`.
- Unbinding never deletes directories, Git worktrees, evidence, artifacts, messages, or tasks.
- Code tasks require one bound Workspace; pure chat requires none.
- Legacy `agents.workspace_id`, `channels.repository_id`, and `tasks.repository_id` remain storage compatibility fields during this phase.
- Existing untracked `.codex/` and `src/.DS_Store` files must not be staged or modified.
- Before Task 1, checkpoint the already verified Summit context-reset implementation in its own commit so feature commits start from a reviewable baseline.

---

### Task 1: Central Channel Policy And Configurable Workspace Limit

**Files:**
- Modify: `shared/channel-policy.ts`
- Create: `shared/channel-policy.test.ts`
- Modify: `server/config.ts`
- Create or modify: `server/config.test.ts`
- Modify: `server/application/channel-context-reset-service.ts`
- Test: `server/application/channel-context-reset-service.test.ts`

**Interfaces:**
- Consumes: existing `canResetChannelContext(channelName: string): boolean`.
- Produces: `summitSystemKey`, `ChannelCapabilities`, `getChannelCapabilities(systemKey)`, and `ServiceConfig.maxWorkspaceBindingsPerChannel`.

- [ ] **Step 1: Write failing policy and configuration tests**

```ts
expect(getChannelCapabilities('summit')).toEqual({
  automaticAllAgents: true,
  resetContext: true,
  mutableMembership: false,
})
expect(getChannelCapabilities(null)).toEqual({
  automaticAllAgents: false,
  resetContext: false,
  mutableMembership: true,
})
expect(getServiceConfig({})).toMatchObject({ maxWorkspaceBindingsPerChannel: 5 })
expect(getServiceConfig({ SINAPSIS_MAX_CHANNEL_WORKSPACES: '8' }))
  .toMatchObject({ maxWorkspaceBindingsPerChannel: 8 })
expect(() => getServiceConfig({ SINAPSIS_MAX_CHANNEL_WORKSPACES: '0' }))
  .toThrow('SINAPSIS_MAX_CHANNEL_WORKSPACES must be a positive integer.')
```

- [ ] **Step 2: Run tests and verify the missing exports fail**

Run: `npm test -- shared/channel-policy.test.ts server/config.test.ts server/application/channel-context-reset-service.test.ts`

Expected: FAIL because channel capabilities and workspace limit do not exist.

- [ ] **Step 3: Implement system-key policy and positive-integer config parsing**

```ts
export const summitSystemKey = 'summit'

export interface ChannelCapabilities {
  automaticAllAgents: boolean
  resetContext: boolean
  mutableMembership: boolean
}

export function getChannelCapabilities(systemKey: string | null | undefined): ChannelCapabilities {
  const summit = systemKey === summitSystemKey
  return {
    automaticAllAgents: summit,
    resetContext: summit,
    mutableMembership: !summit,
  }
}
```

Add `maxWorkspaceBindingsPerChannel: number` to `ServiceConfig`, parsed from `SINAPSIS_MAX_CHANNEL_WORKSPACES` with a default of `5`. Change `ChannelContextResetService` to authorize with `channel.systemKey`, not the channel name.

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- shared/channel-policy.test.ts server/config.test.ts server/application/channel-context-reset-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/channel-policy.ts shared/channel-policy.test.ts server/config.ts server/config.test.ts server/application/channel-context-reset-service.ts server/application/channel-context-reset-service.test.ts
git commit -m "refactor: centralize channel capabilities"
```

### Task 2: Persist Global Channel Relationships And Migrate Existing Data

**Files:**
- Modify: `server/domain/agent.ts`
- Modify: `server/domain/workspace.ts`
- Modify: `server/domain/task.ts`
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/schema.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Test: `server/adapters/sqlite/sqlite-repositories.test.ts`

**Interfaces:**
- Consumes: `summitSystemKey` and existing migration version `13`.
- Produces:

```ts
interface Agent {
  id: string
  identity: string
  mentionName: string
  // existing runtime and responsibility fields remain
}

interface CreateAgentInput {
  identity: string
  mentionName: string
  runtime: Agent['runtime']
  capabilityTags: string[]
  responsibilities?: string[]
  maxConcurrentTasks: 1
  command: string
  args: string[]
  model: string
  env: Record<string, string>
}

interface Channel {
  id: string
  name: string
  systemKey: string | null
  memberAgentIds: string[]
  boundWorkspaceIds: string[]
  archivedAt?: string | null
  contextResetAt?: string | null
  createdAt: string
}

interface Task {
  workspaceId: string
  // repositoryId remains as the compatibility execution repository
}
```

Repository methods:

```ts
listAgents(): Agent[]
getChannelAgentIds(channelId: string): string[]
addChannelAgent(channelId: string, agentId: string, occurredAt: Date): void
removeChannelAgent(channelId: string, agentId: string): void
getChannelWorkspaceIds(channelId: string): string[]
bindChannelWorkspace(channelId: string, workspaceId: string, occurredAt: Date): void
unbindChannelWorkspace(channelId: string, workspaceId: string): void
hasUnfinishedTask(channelId: string, workspaceId: string, agentId?: string): boolean
```

- [ ] **Step 1: Write a failing migration test using a version-13 fixture**

Create existing Workspace, Repository, Channel, Agent, subscription, and Task rows, reopen the database, then assert:

```ts
expect(repositories.getChannel(summit.id)).toMatchObject({
  systemKey: 'summit',
  memberAgentIds: [agent.id],
  boundWorkspaceIds: [workspace.id],
})
expect(repositories.getChannel(ordinary.id)?.memberAgentIds).toContain(agent.id)
expect(repositories.getTask(task.id)).toMatchObject({ workspaceId: workspace.id })
```

Also create a new Agent after migration and assert it appears in `summit` without any `channel_agent_memberships` row.

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts`

Expected: FAIL because migration `14`, relationship tables, and new domain fields are absent.

- [ ] **Step 3: Add migration 14**

Migration 14 must:

```sql
ALTER TABLE channels ADD COLUMN system_key TEXT;
ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

CREATE UNIQUE INDEX channels_system_key_unique_idx
  ON channels(system_key) WHERE system_key IS NOT NULL;

CREATE TABLE channel_agent_memberships (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE channel_workspace_bindings (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, workspace_id)
);
```

Then:

- Mark the active normalized `summit` channel with `system_key = 'summit'`.
- Copy existing `channel_agent_subscriptions` into `channel_agent_memberships`.
- Insert each Channel's legacy Repository Workspace into `channel_workspace_bindings`.
- Backfill `tasks.workspace_id` through `tasks.repository_id -> repositories.workspace_id`.
- Drop the workspace-scoped Agent mention index and create a global normalized mention-name unique index.

- [ ] **Step 4: Implement repository mapping and relationship operations**

For `getChannelAgentIds`, use:

```ts
if (channel.systemKey === summitSystemKey) return this.listAgents().map((agent) => agent.id)
return membershipRows.map((row) => row.agent_id)
```

Keep `agents.workspace_id` and `channels.repository_id` private to the SQLite adapter as compatibility storage. New global Agent and Channel inserts use the oldest existing Workspace/Repository only for these ignored non-null columns; return a clear `DomainError` if the local service has not created its first Workspace yet.

- [ ] **Step 5: Run repository and type checks**

Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/domain/agent.ts server/domain/workspace.ts server/domain/task.ts server/ports/repositories.ts server/adapters/sqlite/schema.ts server/adapters/sqlite/sqlite-repositories.ts server/adapters/sqlite/sqlite-repositories.test.ts
git commit -m "feat: persist channel memberships and workspace bindings"
```

### Task 3: Add Membership And Workspace-Binding Application Services

**Files:**
- Create: `server/application/channel-membership-service.ts`
- Create: `server/application/channel-membership-service.test.ts`
- Create: `server/application/channel-workspace-service.ts`
- Create: `server/application/channel-workspace-service.test.ts`
- Modify: `server/app.ts`
- Test: `server/app.test.ts`

**Interfaces:**
- Consumes: repository methods from Task 2 and `getChannelCapabilities`.
- Produces:

```ts
class ChannelMembershipService {
  list(channelId: string): Agent[]
  add(channelId: string, agentId: string, actor: 'human'): Agent[]
  async remove(channelId: string, agentId: string, actor: 'human'): Promise<Agent[]>
}

class ChannelWorkspaceService {
  list(channelId: string): Workspace[]
  bind(channelId: string, workspaceId: string, actor: 'human'): Workspace[]
  unbind(channelId: string, workspaceId: string, actor: 'human'): Workspace[]
}
```

- [ ] **Step 1: Write failing service tests**

Membership tests:

```ts
expect(service.add(ordinary.id, agent.id, 'human')).toContainEqual(expect.objectContaining({ id: agent.id }))
expect(service.add(ordinary.id, agent.id, 'human')).toHaveLength(1)
expect(() => service.add(summit.id, agent.id, 'human')).toThrow('summit membership is automatic')
await expect(service.remove(ordinary.id, busyAgent.id, 'human')).rejects.toThrow('unfinished task')
```

Workspace tests:

```ts
for (const workspace of workspaces.slice(0, 5)) service.bind(channel.id, workspace.id, 'human')
expect(() => service.bind(channel.id, workspaces[5]!.id, 'human')).toThrow('at most 5 workspaces')
expect(() => service.unbind(channel.id, activeTaskWorkspace.id, 'human')).toThrow('unfinished task')
expect(service.unbind(channel.id, idleWorkspace.id, 'human')).not.toContainEqual(expect.objectContaining({ id: idleWorkspace.id }))
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm test -- server/application/channel-membership-service.test.ts server/application/channel-workspace-service.test.ts`

Expected: FAIL because both services are missing.

- [ ] **Step 3: Implement services with server-side authorization and guards**

`ChannelMembershipService.remove` must call `ConversationCoordinator.cancelAgentInChannel(channelId, agentId)` after confirming no unfinished task, then remove the membership.

`ChannelWorkspaceService.bind` must read `maxWorkspaceBindingsPerChannel` from injected config, return existing bindings for duplicate requests, and reject only when adding a new sixth binding.

- [ ] **Step 4: Add API routes**

```text
GET    /api/channels/:channelId/agents
POST   /api/channels/:channelId/agents             body: { agentId }
DELETE /api/channels/:channelId/agents/:agentId
GET    /api/channels/:channelId/workspaces
POST   /api/channels/:channelId/workspaces         body: { workspaceId }
DELETE /api/channels/:channelId/workspaces/:workspaceId
```

The local UI routes pass the internal actor value `'human'`; request bodies do not accept `actorType`. Runtime adapters receive no membership or deletion API tool.

- [ ] **Step 5: Write and run endpoint tests**

Add tests that assert success, idempotency, `summit` rejection, binding limit conflict, and unfinished-task conflict.

Run: `npm test -- server/app.test.ts server/application/channel-membership-service.test.ts server/application/channel-workspace-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/application/channel-membership-service.ts server/application/channel-membership-service.test.ts server/application/channel-workspace-service.ts server/application/channel-workspace-service.test.ts server/app.ts server/app.test.ts
git commit -m "feat: manage channel agents and workspaces"
```

### Task 4: Make Agent And Channel Business APIs Global

**Files:**
- Modify: `server/application/agent-service.ts`
- Modify: `server/application/agent-service.test.ts`
- Modify: `server/application/workspace-service.ts`
- Modify: `server/application/workspace-service.test.ts`
- Modify: `server/app.ts`
- Test: `server/app.test.ts`

**Interfaces:**
- Consumes: storage-compatible global create methods from Task 2.
- Produces:

```ts
AgentService.createAgent(input: CreateAgentInput): Promise<AgentConfiguration>
WorkspaceService.createChannel(input: { name: string }): Channel
POST /api/agents
POST /api/channels
```

- [ ] **Step 1: Write failing global creation tests**

```ts
await service.createAgent({
  identity: 'Newton',
  mention: 'newton',
  runtime: 'pi',
  capabilityTags: ['general'],
})
expect(() => service.createAgent({ ...input, mention: 'newton' }))
  .rejects.toThrow('already exists')

const channel = workspaceService.createChannel({ name: 'release' })
expect(channel).toMatchObject({ name: 'release', systemKey: null, boundWorkspaceIds: [] })
```

- [ ] **Step 2: Run focused tests and verify workspace coupling fails**

Run: `npm test -- server/application/agent-service.test.ts server/application/workspace-service.test.ts server/app.test.ts`

Expected: FAIL because Agent and Channel creation still require Workspace/Repository IDs.

- [ ] **Step 3: Remove workspace ownership from application contracts**

Change mention uniqueness to global:

```ts
hasAgentMention(mentionName: string): boolean
```

Change user-facing Agent configuration and API payloads to omit `workspaceId`. Keep the old workspace-scoped create endpoints as temporary compatibility wrappers that call the global services and ignore the path parameter.

Change channel creation to `POST /api/channels` with `{ name }`. Keep `POST /api/repositories/:repositoryId/channels` as a compatibility wrapper that creates a global channel and then binds the Repository's Workspace.

- [ ] **Step 4: Stop creating `general` as a Repository side effect**

`WorkspaceService.addRepository` creates Repository metadata, then calls `ensureSummitChannel(repository.id)`. That method creates the singleton system Channel only when no `system_key = 'summit'` row exists. The Repository ID satisfies the ignored legacy storage column; the new `summit` starts with zero Workspace bindings. Adding later Workspaces never creates another Channel.

- [ ] **Step 5: Run global creation tests**

Run: `npm test -- server/application/agent-service.test.ts server/application/workspace-service.test.ts server/app.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/application/agent-service.ts server/application/agent-service.test.ts server/application/workspace-service.ts server/application/workspace-service.test.ts server/app.ts server/app.test.ts
git commit -m "refactor: make agents and channels global"
```

### Task 5: Enforce Membership And Workspace Selection During Runtime Dispatch

**Files:**
- Modify: `server/application/conversation-coordinator.ts`
- Modify: `server/application/conversation-coordinator.test.ts`
- Modify: `server/application/task-service.ts`
- Modify: `server/application/task-service.test.ts`
- Modify: `server/application/task-scheduler.ts`
- Modify: `server/application/task-scheduler.test.ts`
- Modify: `server/application/task-execution-coordinator.ts`
- Modify: `server/application/task-execution-coordinator.test.ts`
- Modify: `server/app.ts`
- Test: `server/integration/local-workspace-flow.test.ts`

**Interfaces:**
- Consumes: channel membership and binding queries from Task 2.
- Produces:

```ts
interface CreateLabeledTaskInput {
  channelId: string
  workspaceId: string
  directAgentId?: string | null
  // existing task text and policy fields remain
}

ConversationCoordinator.cancelAgentInChannel(channelId: string, agentId: string): Promise<void>
```

- [ ] **Step 1: Write failing conversation boundary tests**

```ts
await coordinator.dispatch(channel.id, postHuman('@outsider 请回答'))
expect(runtime.starts).toHaveLength(0)

await coordinator.dispatch(summit.id, postHuman('@outsider 请回答'))
expect(runtime.starts).toHaveLength(1)
```

Also assert a pure-chat Runtime request uses a neutral directory under the service data directory, not any bound Workspace path.

- [ ] **Step 2: Write failing task validation and scheduler tests**

```ts
expect(() => taskService.createTask({ ...input, workspaceId: unbound.id }))
  .toThrow('Workspace is not bound to this channel')
expect(() => taskService.createTask({ ...input, directAgentId: outsider.id }))
  .toThrow('Agent is not a member of this channel')
expect(scheduler.claimNext(outsider.id)).toBeUndefined()
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `npm test -- server/application/conversation-coordinator.test.ts server/application/task-service.test.ts server/application/task-scheduler.test.ts`

Expected: FAIL because current routing derives Agents and paths from Workspace ownership.

- [ ] **Step 4: Implement membership-aware conversation dispatch**

Build candidate Agents from `repositories.getChannelAgentIds(channelId)`. Replace `requireAgentContext` with a neutral conversation directory resolver:

```ts
const worktreePath = path.join(conversationDirectory, channelId, agent.id)
await mkdir(worktreePath, { recursive: true })
```

Add `cancelAgentInChannel` by filtering the existing execution map on both Channel and Agent IDs.

- [ ] **Step 5: Implement workspace-aware task creation and execution**

Validate the selected Workspace is bound, the selected Agent is a member, and the Workspace has a managed execution Repository. Store both `workspaceId` and the resolved compatibility `repositoryId`.

The execution coordinator resolves the Repository from `task.workspaceId`; if a legacy Workspace owns multiple Repositories, use the Task's stored `repositoryId` and verify it still belongs to that Workspace.

The scheduler SQL candidate query must require either `channels.system_key = 'summit'` or a matching `channel_agent_memberships` row.

- [ ] **Step 6: Add channel task endpoint and run integration tests**

Add:

```text
POST /api/channels/:channelId/tasks
body: { workspaceId, directAgentId?, title, description, acceptanceCriteria, labels }
```

Keep the Repository-scoped task endpoint as a compatibility wrapper that derives Workspace and validates Channel binding.

Run: `npm test -- server/application/conversation-coordinator.test.ts server/application/task-service.test.ts server/application/task-scheduler.test.ts server/application/task-execution-coordinator.test.ts server/integration/local-workspace-flow.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/application/conversation-coordinator.ts server/application/conversation-coordinator.test.ts server/application/task-service.ts server/application/task-service.test.ts server/application/task-scheduler.ts server/application/task-scheduler.test.ts server/application/task-execution-coordinator.ts server/application/task-execution-coordinator.test.ts server/app.ts server/integration/local-workspace-flow.test.ts
git commit -m "feat: enforce channel execution boundaries"
```

### Task 6: Expose A Global Bootstrap View

**Files:**
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/app.ts`
- Modify: `src/domain/workspace-view.ts`
- Modify: `src/api/client.ts`
- Test: `server/adapters/sqlite/sqlite-repositories.test.ts`
- Test: `server/app.test.ts`

**Interfaces:**
- Consumes: domain relationships from Task 2.
- Produces:

```ts
interface BootstrapSnapshot {
  agents: Agent[]
  channels: Channel[]
  workspaces: Array<Workspace & { repositories: Repository[] }>
  tasks: Task[]
  recentMessages: Message[]
  maxWorkspaceBindingsPerChannel: number
}
```

- [ ] **Step 1: Write a failing bootstrap shape test**

```ts
expect(snapshot).toMatchObject({
  agents: [expect.objectContaining({ id: agent.id })],
  channels: [expect.objectContaining({
    id: summit.id,
    memberAgentIds: expect.arrayContaining([agent.id]),
    boundWorkspaceIds: [workspace.id],
  })],
  workspaces: [expect.objectContaining({ id: workspace.id })],
  tasks: [expect.objectContaining({ workspaceId: workspace.id })],
  maxWorkspaceBindingsPerChannel: 5,
})
expect(snapshot.workspaces[0]).not.toHaveProperty('agents')
```

- [ ] **Step 2: Run bootstrap tests and verify nested ownership fails**

Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts server/app.test.ts`

Expected: FAIL because bootstrap still nests Agents and Channels under Workspace/Repository.

- [ ] **Step 3: Implement the global snapshot**

Query each entity once. Apply `context_reset_at` filtering to Messages and Tasks through their Channel joins. Resolve `summit.memberAgentIds` dynamically. Return the configured workspace binding limit from `/api/bootstrap`.

Update `snapshotAgents` and `snapshotChannelMessages` to consume top-level arrays; remove compatibility traversal from new UI code.

- [ ] **Step 4: Run server and client type tests**

Run: `npm test -- server/adapters/sqlite/sqlite-repositories.test.ts server/app.test.ts src/domain && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ports/repositories.ts server/adapters/sqlite/sqlite-repositories.ts server/adapters/sqlite/sqlite-repositories.test.ts server/app.ts server/app.test.ts src/domain/workspace-view.ts src/api/client.ts
git commit -m "refactor: expose global control room snapshot"
```

### Task 7: Build Channel Member And Workspace Management UI

**Files:**
- Create: `src/ui/ChannelAgentMembers.tsx`
- Create: `src/ui/ChannelAgentMembers.test.tsx`
- Create: `src/ui/ChannelWorkspaceBindings.tsx`
- Create: `src/ui/ChannelWorkspaceBindings.test.tsx`
- Create: `src/ui/EntityPickerDialog.tsx`
- Modify: `src/api/client.ts`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: global snapshot and REST endpoints from Tasks 3 and 6.
- Produces:

```ts
WorkspaceApi.addChannelAgent(channelId: string, agentId: string): Promise<AgentView[]>
WorkspaceApi.removeChannelAgent(channelId: string, agentId: string): Promise<AgentView[]>
WorkspaceApi.bindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]>
WorkspaceApi.unbindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]>
```

- [ ] **Step 1: Write failing component tests**

Ordinary Channel:

```ts
expect(screen.getByRole('button', { name: '添加 Agent' })).toBeEnabled()
await user.click(screen.getByRole('button', { name: '添加 Agent' }))
await user.click(screen.getByRole('option', { name: 'Newton' }))
expect(api.addChannelAgent).toHaveBeenCalledWith(channel.id, newton.id)
```

`summit`:

```ts
expect(screen.getByText('自动同步所有 Agent')).toBeInTheDocument()
expect(screen.queryByRole('button', { name: '添加 Agent' })).not.toBeInTheDocument()
expect(screen.queryByRole('button', { name: /移除/ })).not.toBeInTheDocument()
```

Workspace limit:

```ts
expect(screen.getByText('5/5')).toBeInTheDocument()
expect(screen.getByRole('button', { name: '添加工作空间' })).toBeDisabled()
```

- [ ] **Step 2: Run UI tests and verify components are missing**

Run: `npm test -- src/ui/ChannelAgentMembers.test.tsx src/ui/ChannelWorkspaceBindings.test.tsx src/ui/WorkspaceShell.test.tsx`

Expected: FAIL because management sections and API methods are absent.

- [ ] **Step 3: Implement one reusable searchable picker**

`EntityPickerDialog` accepts:

```ts
interface EntityPickerItem {
  id: string
  label: string
  description: string
}
```

It renders a modal listbox, filters by label and description, supports ArrowUp/ArrowDown/Enter/Escape, and returns exactly one selected ID.

- [ ] **Step 4: Implement Channel Agent management**

Show current members with status and Runtime. Ordinary Channels show add/remove controls. `summit` shows every Agent plus “自动同步所有 Agent”, with no membership mutation controls.

- [ ] **Step 5: Implement Channel Workspace management**

Show bound Workspaces and `${count}/${limit}`. Add uses the global Workspace picker. Unbind uses an explicit confirmation dialog that states it does not delete local files.

- [ ] **Step 6: Integrate sections and run UI tests**

Place both sections in the right context panel above “频道操作”. On mutation, refresh bootstrap and preserve the selected Channel.

Run: `npm test -- src/ui/ChannelAgentMembers.test.tsx src/ui/ChannelWorkspaceBindings.test.tsx src/ui/WorkspaceShell.test.tsx && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ChannelAgentMembers.tsx src/ui/ChannelAgentMembers.test.tsx src/ui/ChannelWorkspaceBindings.tsx src/ui/ChannelWorkspaceBindings.test.tsx src/ui/EntityPickerDialog.tsx src/api/client.ts src/ui/WorkspaceShell.tsx src/ui/WorkspaceShell.test.tsx src/styles.css
git commit -m "feat: manage channel members and workspaces"
```

### Task 8: Rebuild Navigation And Task Composition Around Channel Bindings

**Files:**
- Modify: `src/ui/RepositorySidebar.tsx`
- Modify: `src/ui/RepositorySidebar.test.tsx`
- Modify: `src/ui/TaskComposerPanel.tsx`
- Modify: `src/ui/TaskComposerPanel.test.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/domain/message-intent.ts`
- Modify: `src/domain/message-intent.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `Channel.boundWorkspaceIds`, `Channel.memberAgentIds`, and global Workspace/Agent lists.
- Produces: Channel-first navigation and `CreateTaskRequest.workspaceId`.

- [ ] **Step 1: Write failing navigation tests**

```ts
await user.click(screen.getByRole('button', { name: '# release' }))
expect(screen.getByRole('group', { name: 'release 的工作空间' }))
  .toHaveTextContent('Frontend')
expect(screen.queryByText('Unbound Workspace')).not.toBeInTheDocument()
```

Verify the sidebar order is Channel, bound Workspaces, then tasks grouped under their selected Workspace.

- [ ] **Step 2: Write failing task composer tests**

```ts
expect(screen.getByLabelText('工作空间')).toHaveValue(singleWorkspace.id)
expect(screen.getByLabelText('工作空间')).toBeDisabled()

expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()
await user.selectOptions(screen.getByLabelText('工作空间'), secondWorkspace.id)
expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled()
```

For zero bound Workspaces, show “请先为频道绑定工作空间” and do not submit.

- [ ] **Step 3: Run focused UI tests and verify old ownership assumptions fail**

Run: `npm test -- src/ui/RepositorySidebar.test.tsx src/ui/TaskComposerPanel.test.tsx src/ui/WorkspaceShell.test.tsx src/domain/message-intent.test.ts`

Expected: FAIL because navigation and task creation still derive Channel ownership from Repository.

- [ ] **Step 4: Implement Channel-first navigation**

The selected Channel determines visible Workspaces:

```ts
const boundWorkspaces = snapshot.workspaces
  .filter((workspace) => channel.boundWorkspaceIds.includes(workspace.id))
```

Store only `channelId` as the durable page selection. Workspace and Task selections are subordinate and reset when changing Channel.

- [ ] **Step 5: Implement explicit Workspace task selection**

Add `workspaceId` to `CreateTaskRequest`. Auto-select when there is exactly one binding; require user choice when there are several. Agent choices contain only current Channel members.

For `/task` chat commands, open the task composer with parsed title and Agent prefilled when Workspace selection is ambiguous. Dispatch immediately only when exactly one bound Workspace exists.

- [ ] **Step 6: Run UI tests**

Run: `npm test -- src/ui/RepositorySidebar.test.tsx src/ui/TaskComposerPanel.test.tsx src/ui/WorkspaceShell.test.tsx src/domain/message-intent.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/RepositorySidebar.tsx src/ui/RepositorySidebar.test.tsx src/ui/TaskComposerPanel.tsx src/ui/TaskComposerPanel.test.tsx src/ui/WorkspaceShell.tsx src/ui/WorkspaceShell.test.tsx src/domain/message-intent.ts src/domain/message-intent.test.ts src/styles.css
git commit -m "feat: navigate and dispatch by channel workspace"
```

### Task 9: Migration Smoke Test, Full Verification, And Documentation

**Files:**
- Modify: `README.md`
- Test: all automated test files

**Interfaces:**
- Consumes: completed Tasks 1-8.
- Produces: verified local migration and user-facing operating instructions.

- [ ] **Step 1: Back up and migrate a copy of the local database**

Create a temporary directory with `mktemp -d`, copy `~/.sinapsis/sinapsis.sqlite` into it, and run `createSqliteDatabase` against the copied path. Do not mutate the live database in this step.

Verify with read-only queries:

```sql
SELECT system_key FROM channels WHERE name = 'summit';
SELECT COUNT(*) FROM channel_workspace_bindings;
SELECT COUNT(*) FROM channel_agent_memberships;
SELECT COUNT(*) FROM tasks WHERE workspace_id IS NULL;
```

Expected: `summit` has the system key, existing relationships are migrated, and existing tasks have Workspace IDs.

- [ ] **Step 2: Run the complete automated suite**

Run: `npm test && npm run build && git diff --check`

Expected: all tests pass, Vite production build succeeds, and no whitespace errors are reported.

- [ ] **Step 3: Perform browser smoke tests without destructive confirmation**

At desktop and narrow viewports:

- Open an ordinary Channel, add an existing Agent, and remove it when idle.
- Bind an existing Workspace and confirm the counter updates.
- Verify the sixth Workspace cannot be bound when the configured limit is five.
- Open `summit` and verify all Agents appear automatically with no member mutation controls.
- Create a task in a single-Workspace Channel and verify automatic Workspace selection.
- Open a multi-Workspace Channel and verify explicit selection is required.
- Open unbind and context-reset confirmations, then cancel them so local files and context remain untouched.

- [ ] **Step 4: Update README**

Document:

- Agent, Channel, and Workspace are global independent entities.
- Ordinary membership is human-managed; `summit` is automatic.
- Channel Workspace binding defaults to five.
- Code tasks require a bound Workspace.
- Unbinding does not delete local files.

- [ ] **Step 5: Final commit**

```bash
git add README.md
git commit -m "docs: explain channel execution boundaries"
```

### Self-Review Checklist

- [ ] Every confirmed design requirement maps to a task.
- [ ] `summit` behavior uses `systemKey`, not its display name.
- [ ] Global Agent and Channel semantics do not rely on legacy ownership fields.
- [ ] Pure chat has a valid neutral working directory when no Workspace is bound.
- [ ] Task creation, scheduling, and Runtime execution all enforce the same membership and Workspace constraints.
- [ ] Both API and UI enforce the configurable Workspace limit.
- [ ] Membership removal and Workspace unbinding preserve historical and local files.
- [ ] Migration is tested on a copied database before touching live data.
- [ ] No placeholder instructions or undefined neighboring interfaces remain.
