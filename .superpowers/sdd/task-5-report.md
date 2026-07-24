# Task 5 Report: Labeled Tasks and Isolated Git Worktrees

## Scope

Implemented only the Task 5 label inference, task APIs, structured task detail/input storage, and Git worktree isolation.

## RED Evidence

1. `server/application/task-service.test.ts` was written before task routes existed. Running it produced two expected `404` versus `201` failures for task creation.
2. `server/adapters/git/git-worktree-manager.test.ts` was written before the adapter existed. The test runner failed to resolve `./git-worktree-manager`.
3. The list/input/cancel tests were then added before their routes and failed with expected `404` versus `200` failures.
4. A regression test changed a task override to `maxRetries: 0`; it failed with `400` until the API treated zero as a valid no-retry policy.
5. The persisted event test required the exact `labels_inferred` history event and caught the initial `task.labels_inferred` mismatch.

## Delivered Behavior

- `inferCapabilityTags` uses explicit keyword rules for `frontend`, `test`, `backend`, and `review`; unrecognized text becomes `general`.
- `POST /api/repositories/:repositoryId/tasks` accepts only the planned task fields, creates a `queued` task in the repository's `general` channel, stores inferred labels, and records a `labels_inferred` task event. Human-provided labels replace inferred labels. `timeoutMs` must be positive and `maxRetries` may be zero.
- Added task list, structured detail, human-input queue, cancel, and on-demand artifact-read endpoints. Detail responses separate task, sessions, leases, inputs, decisions, artifact metadata, and event history; artifact paths are not exposed in detail responses.
- Added SQLite repository read/write boundaries for task inputs, task history events, task lists, task detail records, and artifact metadata lookup. All writes remain transaction-bound and publish only after commit.
- `GitWorktreeManager` creates `sinapsis/task-<task-id>` branches at `<data-dir>/worktrees/<repository-id>/<task-id>` using `git -C <repository-root> worktree add -b ...`. It validates path segments, confines paths to the configured worktree root, rejects worktrees inside protected repository roots, uses `shell: false`, and never removes worktrees.
- `createGitFixture()` creates a temporary repository with an initial `main` commit. Tests clean up only their temporary fixture directories.

## Verification

- Focused task and worktree suite: 2 files, 6 tests passed.
- Full regression suite: 14 files, 75 tests passed.
- `npm run build` passed.
- `git diff --check` passed.

## Self Review

- Worktree paths are deterministic and cannot escape the configured worktree directory through task or repository identifiers.
- Source repository paths are not deleted or rewritten by the manager; task worktrees remain in place after creation.
- Task API validation prevents callers from injecting unrelated task fields or changing the repository through request body data.
- Task detail exposes artifact metadata only; raw artifact content requires a task-and-artifact-scoped request.

## Review Follow-up (2026-07-25)

- Worktree allocation now resolves existing filesystem ancestors with `realpath` before creating directories or invoking Git. A symlink under the configured worktree root that points into a protected source repository is rejected, and neither source repositories nor worktrees are deleted.
- Human input is accepted only while a task is `claimed`, `running`, or `waiting_input`. Every other task status rejects the request before an input row or event can be created.
- Schema migration 4 preserves legacy duplicate channels by retaining the oldest name and deterministically renaming subsequent duplicates before adding the repository-local `(repository_id, name)` unique index. New conflicts are mapped to a `DomainError`, so the existing API boundary returns HTTP 409.

## Review Verification

- Focused Task 5 suites: 4 files, 28 tests passed.
- Full regression suite: 14 files, 91 tests passed.
- `npm run build` and `git diff --check` passed.
