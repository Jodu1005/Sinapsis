# Sinapsis

Sinapsis is a local, channel-first workspace for coordinating coding agents. A workspace groups local Git repositories, repository channels, manually configured Agents, FIFO tasks, and review evidence.

## Start locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173/](http://localhost:5173/). The first screen creates a workspace and can bind a local Git repository. Each repository receives a `general` channel.

The local service listens only on `127.0.0.1:4174`. The browser uses `/api` and `/events` through Vite's local proxy.

## Use the first version

1. Create a workspace and select a local Git repository.
2. Add an Agent from the left sidebar. Enter its identity, `@mention`, Runtime, and capability tags.
3. Start a channel conversation or create a task from the repository's plus button.
4. A compatible idle Agent claims queued tasks in FIFO order. Each claimed task gets its own branch and Git worktree.
5. Use the task detail panel for queued input, runtime evidence, and acceptance. Acceptance records a review decision only.

`@Agent` messages address a specific Agent. A busy Agent receives the message through its active task input queue at the next safe Runtime step. Ordinary channel messages remain ordinary collaboration records in this version.

## Runtime health

```bash
npm run runtime:check
```

The command runs only each configured `(Runtime, command)` pair's `--version` check and prints JSON. Identical pairs are checked once and list their associated Agents. It does not send a model prompt. On this machine, OpenCode is available and Pi is not installed, so Pi is reported as `missing` rather than treated as a failed test. Install Pi and run the command again before configuring Pi Agents.

Creating an Agent performs its local executable detection; an available executable with unverified task execution places that new Agent in the idle pool. `runtime:check` is observational and does not change Agent state. Either result confirms only that the executable exists, not that its credentials, model access, or a real task run will succeed.

## Local data and boundaries

By default data lives in `~/.sinapsis`. Set `SINAPSIS_DATA_DIR` to use another location and `SINAPSIS_PORT` to change the service port. The data directory contains:

- `sinapsis.sqlite`, the local source of truth.
- `artifacts/`, raw Runtime output stored for task review.
- `worktrees/`, isolated task worktrees under repository and task IDs.

This first version does not automatically remove task worktrees. After a human has reviewed a task and no longer needs its evidence, clean up the corresponding Git worktree manually with normal Git commands. Do not delete a worktree that still belongs to an active task.

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
