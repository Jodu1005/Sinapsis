# Task 4 Report: Runtime Port, OpenCode/Pi Adapters, and Raw Evidence

## Scope

Implemented only the Task 4 runtime/process boundary. No frontend files, database schema, repositories, scheduler, coordinator, or network/model calls were changed. Existing `.codex/` and `src/.DS_Store` remain untracked and unstaged.

## Delivered

- Added `ProcessRunner` / `ProcessHandle` with `child_process.spawn(command, args, { cwd, env, shell: false })`; runtime overrides are merged with `process.env` only in this local server boundary.
- Added one `RuntimeAdapter` contract that extends the pre-existing `RuntimeAvailabilityDetector`, so `detect()` continues to return the existing `RuntimeAvailability` shape without a second availability model.
- Added LF-only JSONL framing. It accepts CRLF, keeps U+2028/U+2029 inside JSON values, retains incomplete tails, and treats malformed completed lines as raw evidence rather than throwing.
- Added OpenCode per-turn execution: `run --format json --dir <worktree>`, optional stored `--session`, safe-point input queueing, structured text/tool/error/session events, and no shell command interpolation.
- Added Pi RPC execution: `--mode rpc`, initial `prompt`, streaming `steer`, message/tool/queue mapping, `agent_settled`, session metadata capture, post-settlement `get_state`, and `switch_session` before recovery input.
- Added raw artifact events for every stdout chunk, stderr chunk, and exit. Exit artifacts contain command, argument array, cwd, exit state, and never include environment values. Persistence remains intentionally deferred to Task 7.
- Added `FakeRuntimeAdapter` and a controllable fake process runner for later coordinator tests.

## TDD Evidence

1. Created the protocol tests before production modules existed and ran:
   `npm run test -- --run server/adapters/runtime/lf-jsonl-parser.test.ts server/adapters/runtime/opencode-runtime-adapter.test.ts server/adapters/runtime/pi-runtime-adapter.test.ts`
   Result: failed because the three requested modules did not yet exist.
2. Added regression tests for invalid JSONL evidence and child-process launch errors, then ran their focused suite.
   Result: failed respectively at `JSON.parse('not json')` and the missing runtime error event.
3. Added the runtime-exit command-metadata assertion, then ran the OpenCode suite.
   Result: failed because the artifact held only code/signal.
4. Implemented the minimal behavior for each red test and reran the focused runtime suite successfully.

## Verification

- `npm run test -- --run server/adapters/runtime` passed: 4 files, 7 tests.
- `npm run build` passed: TypeScript typecheck and Vite production build.
- `git diff --check` passed with no whitespace errors.

## Concerns

- Pi is not installed on this machine, and Task 4 explicitly forbids starting a real model or making network requests. Both adapters are therefore verified through their process-level protocol fakes; a real authenticated runtime smoke test belongs to the later end-to-end task.

Status: `DONE`.

## Review Follow-up: Pi Session Restore and Fixed Protocol Arguments

Implemented the Task 4 review corrections without changing database or frontend code.

1. Pi now requests `get_state` before its first `prompt`, persists `sessionId` and `sessionFile` from both direct state events and RPC `response.result`, then starts the task prompt.
2. Pi buffers human input while starting or resuming. A resumed process receives `switch_session` first; only its successful response releases queued input in FIFO order, so no `steer` can target an empty session.
3. Runtime profile overrides now append to the fixed protocol arguments. `opencode run` and `pi --mode rpc` are always retained.

### TDD Evidence

- Added failing tests for initial `get_state` ordering, resumed-session input buffering, and fixed protocol argument retention. The focused run failed with the expected missing `get_state`, premature `steer`, and replaced-argument assertions.
- Added a failing RPC `response.result` session-state fixture, then updated the adapter to parse that transport shape before releasing the initial prompt.

### Verification

- `npm run test -- --run server/adapters/runtime/pi-runtime-adapter.test.ts`: passed, 3 tests.
- `npm run test -- --run server/adapters/runtime`: passed, 4 files and 10 tests.
- `git diff --check`: passed.
- `npm run build`: attempted but currently blocked by concurrent, out-of-scope uncommitted changes in `server/adapters/sqlite/sqlite-repositories.test.ts` and `server/application/workspace-service.test.ts` (missing `databasePath` scope and incompatible test-double return type). Runtime production code typechecks through its focused suite; those files were not modified for this scoped fix.

## Review Follow-up: Lock Runtime Protocol Flags

The fixed protocol is now enforced at profile resolution rather than relying on argument order. Pi rejects both split and inline mode overrides (`--mode json` and `--mode=json`), so the managed adapter always launches with `--mode rpc`. OpenCode rejects its top-level CLI subcommands as supplemental arguments, keeping the fixed `opencode run` execution shape intact. Ordinary runtime options remain valid additions.

### TDD Evidence

1. Added RED examples for Pi `args: ['--mode', 'json']`, Pi `args: ['--mode=json']`, and OpenCode supplemental `run` / `serve` subcommands.
2. Ran `npm run test -- --run server/adapters/runtime/runtime-profile.test.ts`; all four new examples failed because the profile appended them unchanged.
3. Added the smallest profile-level validation before fixed and user arguments are combined.

### Verification

- `npm run test -- --run server/adapters/runtime/runtime-profile.test.ts`: passed, 6 tests.
- `npm run test -- --run server/adapters/runtime`: passed, 4 files and 14 tests.
- `npm run build`: passed.
- `git diff --check`: passed.
