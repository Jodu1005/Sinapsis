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

The command runs only each Runtime command's `--version` check and prints JSON. It does not send a model prompt. On this machine, OpenCode is available and Pi is not installed, so Pi is reported as `missing` rather than treated as a failed test. Install Pi and run the command again before configuring Pi Agents.

An Agent whose command is found enters the idle pool after the version check. This confirms the executable exists, not that its credentials, model access, or a real task run will succeed.

## Local data and boundaries

By default data lives in `~/.sinapsis`. Set `SINAPSIS_DATA_DIR` to use another location and `SINAPSIS_PORT` to change the service port. The data directory contains:

- `sinapsis.sqlite`, the local source of truth.
- `artifacts/`, raw Runtime output stored for task review.
- `worktrees/`, isolated task worktrees under repository and task IDs.

This first version does not automatically remove task worktrees. After a human has reviewed a task and no longer needs its evidence, clean up the corresponding Git worktree manually with normal Git commands. Do not delete a worktree that still belongs to an active task.

Agents may edit their assigned task worktree, run tests, and create a commit. Sinapsis does not expose automatic `git push` or merge actions. Acceptance is not a merge, and any push, merge, deletion outside the task worktree, or other external side effect remains a separate human decision.

## Verify

```bash
npm run test:run
npm run build
npm run runtime:check
```

The integration flow uses a temporary Git repository and `FakeRuntimeAdapter`. It verifies FIFO claims, distinct worktrees, queued input, committed task review, and the absence of automatic merge or push without sending a real model request.
