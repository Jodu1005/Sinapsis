# Sinapsis

Sinapsis is a local, channel-first control room for coordinating coding agents. Agents, Channels, and Workspaces are independent global entities: a Channel chooses which Agents participate and which local Workspaces can be used for code tasks.

## Start locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173/](http://localhost:5173/). The first screen creates a Workspace and registers a local Git repository.

The local service listens only on `127.0.0.1:4174`. The browser uses `/api` and `/events` through Vite's local proxy.

## Use the first version

1. Create one or more Workspaces that point at local Git repositories.
2. Create global Agents from the left sidebar. Enter each Agent's identity, `@mention`, Runtime, and responsibilities.
3. Create or select a Channel, then manage its Agent members and bound Workspaces in the context panel.
4. Chat directly in the Channel, or use `/task [@Agent] task title` to dispatch code work.
5. A code task requires a bound Workspace. One binding is selected automatically; multiple bindings require an explicit choice.
6. A compatible idle Agent claims queued tasks in FIFO order. Each claimed task gets its own branch and Git worktree.
7. Use the task detail panel for queued input, runtime evidence, and acceptance. Acceptance records a review decision only.

Ordinary Channel membership is managed by a human. The system Channel `summit` is different: it always includes every global Agent automatically and does not expose member add/remove controls. The special behavior is keyed by `systemKey`, so renaming a normal Channel to `summit` does not grant system capabilities.

Each ordinary Channel can bind zero or more Workspaces. The default maximum is five and is enforced by both the API and UI. A Channel with no bound Workspace can still host conversation, but cannot dispatch code tasks.

`@Agent` messages address a specific Agent in the current Channel. A busy Agent receives the message through its active task input queue at the next safe Runtime step.

## Runtime health

```bash
npm run runtime:check
```

The command runs only each configured `(Runtime, command)` pair's `--version` check and prints JSON. Identical pairs are checked once and list their associated Agents. It does not send a model prompt. A missing executable is reported as `missing` rather than treated as a failed test.

Creating an Agent performs its local executable detection; an available executable with unverified task execution places that new Agent in the idle pool. `runtime:check` is observational and does not change Agent state. Either result confirms only that the executable exists, not that its credentials, model access, or a real task run will succeed.

## Local data and boundaries

By default data lives in `~/.sinapsis`. Set `SINAPSIS_DATA_DIR` to use another location and `SINAPSIS_PORT` to change the service port. The data directory contains:

- `sinapsis.sqlite`, the local source of truth.
- `artifacts/`, raw Runtime output stored for task review.
- `worktrees/`, isolated task worktrees under repository and task IDs.

This first version does not automatically remove task worktrees. After a human has reviewed a task and no longer needs its evidence, clean up the corresponding Git worktree manually with normal Git commands. Do not delete a worktree that still belongs to an active task.

Unbinding a Workspace from a Channel only removes that relationship. It does not delete the Workspace, repository directory, task history, Git worktrees, evidence files, or Runtime artifacts. Removing an Agent from an ordinary Channel likewise preserves the global Agent and historical messages.

Agents are instructed to edit their assigned task worktree, run tests, and create a commit. The built-in API has no automatic `git push` or merge action. Acceptance is not a merge; pushing, merging, or other external side effects remain separate human decisions.

This first version has no OS-level sandbox. A task worktree is a collaboration convention, not a filesystem permission boundary. Run a local CLI only after you trust it: an untrusted process can still access files, the network, or credentials available to the current OS user, and can explicitly provide its own credentials.

Runtime processes start with a small inherited environment (`PATH`, `HOME`, locale, temporary-directory, and timezone settings). Inherited Git, SSH, CI, and common remote-credential variables are not passed through; Git is configured to avoid terminal prompts and ignore global credential helpers. Explicit Agent profile environment variables are still passed to the process. This reduces accidental credential inheritance; it is not an OS sandbox and does not prevent a trusted or untrusted CLI from explicitly supplying credentials.

## Verify

```bash
npm run test:run
npm run build
npm run runtime:check
```

The integration flow uses a temporary Git repository, a local bare Git remote, and `FakeRuntimeAdapter`. It verifies FIFO claims, distinct worktrees, queued input, committed task review, no automatic merge into `main`, an unchanged remote `main` SHA, and no task-branch ref pushed to the local remote after acceptance. It sends no real model request or network traffic.
