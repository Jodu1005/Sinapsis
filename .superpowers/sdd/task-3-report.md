# Task 3 Report: 控制室交互界面

## Scope

- Added a service-driven control room page with project and Agent seats, task board, task inspector, timeline, and review controls.
- `App` creates the in-memory store and control room service once with `useMemo`.
- UI components receive the service through `ControlRoomPage`; no UI fake data was added.

## RED Evidence

1. Added `src/ui/ControlRoomPage.test.tsx` before any page components.
2. Ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`.
3. Result: failed as expected because Vite could not resolve `./ControlRoomPage` from the new test file.

## GREEN Evidence

1. Implemented `useControlRoom` with `useSyncExternalStore` and the requested semantic, classable UI components.
2. Ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`.
3. Result: 1 test file passed, 3 tests passed.
4. The full suite initially exposed the pre-existing App heading contract. Root cause: the new page rendered only the project heading. Restored the `控制室` page heading and retained `Sinapsis` as a nested heading.
5. Re-ran focused component tests: 1 test file passed, 3 tests passed.
6. Re-ran `npm run test -- --run`: 3 test files passed, 12 tests passed.

## Final Verification

- `npm run build`: passed (`tsc --noEmit` and Vite production build).
- `git diff --check`: passed with no output.

## Review Fixes

### RED Evidence

1. Added seven focused interaction tests to `src/ui/ControlRoomPage.test.tsx` before changing production components.
2. Ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`.
3. Result: 10 tests ran; 7 passed and 3 failed at assertions.
4. The accepted and rejected cases failed because no `已完成` region existed.
5. The Agent-state case failed because `进行中` was absent and raw English states were still rendered.

### GREEN Evidence

1. Added an `已完成` board section that groups `accepted` and `rejected` tasks while preserving all four active columns.
2. Mapped Agent seat states to `进行中`, `等待中`, and `审查中`.
3. The first focused GREEN run had 9 passing tests and one ambiguous legacy assertion because `已接受` now correctly appeared in both the terminal card and inspector.
4. Scoped the preserved assertion to the terminal task card, matching its stated intent.
5. Re-ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`: 1 test file passed, 10 tests passed.

### Verification

- `npm run test -- --run`: 3 test files passed, 19 tests passed.
- `npm run build`: passed (`tsc --noEmit` and Vite production build).
- `git diff --check`: passed with no output.

## Feedback Draft Isolation Fix

### RED Evidence

1. Added a focused component test that enters feedback for `审查速率限制改动`, switches to `验证旧版登录分支`, and checks the new task has no inherited or submittable draft.
2. Ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`.
3. Result: 11 tests ran; 10 passed and 1 failed at the empty-textarea assertion.
4. Expected the textarea value to be empty, but received `只适用于速率限制任务`.

### GREEN Evidence

1. Keyed `ReviewActions` by `task.id` at the `TaskInspector` boundary so its local feedback state is recreated when task selection changes.
2. Re-ran `npm run test -- --run src/ui/ControlRoomPage.test.tsx`: 1 test file passed, 11 tests passed.

### Verification

- `npm run test -- --run`: 3 test files passed, 20 tests passed.
- `npm run build`: passed (`tsc --noEmit` and Vite production build).
- `git diff --check`: passed with no output.
