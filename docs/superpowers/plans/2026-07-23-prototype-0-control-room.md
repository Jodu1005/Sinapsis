# 原型 0 控制室实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地可运行的 React 单页控制室，用内存假数据演示 Agent 任务、会话、审查和人工决定的完整前端闭环。

**Architecture:** 界面组件只消费 `ControlRoomService`，该服务通过 `ControlRoomStore` 端口读取与写入快照。原型 0 的 `InMemoryControlRoomStore` 提供可订阅的内存实现；原型 1 仅需替换此适配器，不改变领域模型、用例或 UI 组件。

**Tech Stack:** Vite、React、TypeScript、Vitest、React Testing Library、Lucide React、原生 CSS。

## Global Constraints

- 不执行真实 Runtime、Git、worktree、网络请求或本地进程。
- UI 不得直接导入假数据；只能接收 `ControlRoomService`。
- 任务状态仅使用 `todo`、`running`、`needs_input`、`in_review`、`accepted`、`rejected`。
- 不满足状态前置条件的操作必须在 UI 中禁用，并在应用服务中拒绝变更。
- 所有状态变化必须在任务时间轨和活动记录中可见。
- 使用 ASCII 代码与文件名；用户可见文案使用中文。
- 每完成一个任务运行对应测试，并单独提交。

---

## 文件结构

```text
package.json                         依赖与脚本
vite.config.ts                       Vite 与 Vitest 配置
src/main.tsx                         React 入口
src/app/App.tsx                      创建内存适配器并装配控制室
src/domain/control-room.ts           领域类型和纯函数
src/ports/control-room-store.ts      控制室存储端口
src/application/control-room-service.ts  用例与状态变更规则
src/adapters/in-memory-control-room.ts   假数据和可订阅内存实现
src/ui/use-control-room.ts           React 服务绑定 hook
src/ui/ControlRoomPage.tsx           主布局与选中任务状态
src/ui/ProjectSidebar.tsx            项目、席位和活动摘要
src/ui/TaskBoard.tsx                 状态列与任务选择
src/ui/TaskCard.tsx                  任务卡片
src/ui/TaskInspector.tsx             时间轨、产物和操作区
src/ui/Timeline.tsx                  纯展示型事件轨
src/ui/ReviewActions.tsx             反馈、接受和驳回控件
src/styles.css                       全局令牌、布局与响应式样式
src/application/control-room-service.test.ts  用例测试
src/ui/ControlRoomPage.test.tsx      组件交互测试
src/test/setup.ts                    Testing Library 配置
```

## Task 1: 建立 Vite、React 与测试基线

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/test/setup.ts`
- Create: `src/app/App.test.tsx`

**Interfaces:**
- Produces: `App` React 组件，以及 `npm run dev`、`npm run test`、`npm run build` 脚本。

- [ ] **Step 1: 手工创建不会覆盖现有文档的项目配置**

Create `package.json`:

```json
{
  "name": "sinapsis-control-room",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest"
  },
  "dependencies": {
    "lucide-react": "latest",
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "latest",
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
```

Run: `npm install`

Create `index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sinapsis 控制室</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 写入会失败的入口组件测试**

Create `src/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the control room heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: '控制室' })).toBeInTheDocument()
})
```

- [ ] **Step 3: 创建测试设置并确认测试因缺少界面失败**

Create `src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

Run: `npm run test -- --run src/app/App.test.tsx`  
Expected: FAIL because no heading named `控制室` exists.

- [ ] **Step 4: 实现最小入口并确认测试通过**

Set `src/app/App.tsx` to:

```tsx
export default function App() {
  return <main><h1>控制室</h1></main>
}
```

Set `src/main.tsx` to:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
```

Run: `npm run test -- --run src/app/App.test.tsx`  
Expected: PASS, 1 test.

- [ ] **Step 5: 提交基线**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json index.html src
git commit -m "feat: bootstrap control room prototype"
```

## Task 2: 以测试驱动领域用例和内存适配器

**Files:**
- Create: `src/domain/control-room.ts`
- Create: `src/ports/control-room-store.ts`
- Create: `src/application/control-room-service.ts`
- Create: `src/adapters/in-memory-control-room.ts`
- Create: `src/application/control-room-service.test.ts`

**Interfaces:**
- Consumes: React/测试基线。
- Produces: `createControlRoomService(store)`，其返回 `getSnapshot`、`subscribe`、`requestSummary`、`requestDecision`、`sendFeedback`、`accept`、`reject`。

- [ ] **Step 1: 写入失败的应用服务测试**

Create `src/application/control-room-service.test.ts`:

```ts
import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import { createControlRoomService } from './control-room-service'

function createSubject() {
  const store = createInMemoryControlRoomStore()
  return createControlRoomService(store)
}

test('accepting a review task records a decision and activity', () => {
  const service = createSubject()

  service.accept('review-rate-limit')

  const snapshot = service.getSnapshot()
  expect(snapshot.tasks.find((task) => task.id === 'review-rate-limit')?.status).toBe('accepted')
  expect(snapshot.activities.at(0)?.message).toContain('已接受')
})

test('requesting a decision moves only a running task to needs input', () => {
  const service = createSubject()

  service.requestDecision('refactor-auth')
  service.requestDecision('review-rate-limit')

  expect(service.getSnapshot().tasks.find((task) => task.id === 'refactor-auth')?.status).toBe('needs_input')
  expect(service.getSnapshot().tasks.find((task) => task.id === 'review-rate-limit')?.status).toBe('in_review')
})

test('empty feedback does not create a timeline event', () => {
  const service = createSubject()
  const before = service.getSnapshot().tasks.find((task) => task.id === 'test-legacy-login')!.events.length

  service.sendFeedback('test-legacy-login', '   ')

  expect(service.getSnapshot().tasks.find((task) => task.id === 'test-legacy-login')!.events).toHaveLength(before)
})
```

- [ ] **Step 2: 运行测试并确认失败原因是缺少模块**

Run: `npm run test -- --run src/application/control-room-service.test.ts`  
Expected: FAIL with missing `in-memory-control-room` and `control-room-service` modules.

- [ ] **Step 3: 定义领域模型与端口**

Create `src/domain/control-room.ts` with:

```ts
export type TaskStatus = 'todo' | 'running' | 'needs_input' | 'in_review' | 'accepted' | 'rejected'
export type EventKind = 'agent' | 'checkpoint' | 'feedback' | 'decision' | 'artifact'

export interface AgentSeat { id: string; name: string; role: string; runtime: string; state: 'active' | 'waiting' | 'reviewing' }
export interface SessionEvent { id: string; kind: EventKind; message: string; at: string }
export interface Task { id: string; title: string; ownerId: string; status: TaskStatus; summary: string; updatedAt: string; events: SessionEvent[]; changedFiles: string[]; diffSummary?: string; testOutput?: string }
export interface Activity { id: string; taskId: string; message: string; at: string }
export interface ControlRoomSnapshot { projectName: string; branch: string; agents: AgentSeat[]; tasks: Task[]; activities: Activity[] }
```

Create `src/ports/control-room-store.ts` with:

```ts
import type { ControlRoomSnapshot } from '../domain/control-room'

export interface ControlRoomStore {
  getSnapshot(): ControlRoomSnapshot
  replace(snapshot: ControlRoomSnapshot): void
  subscribe(listener: () => void): () => void
}
```

- [ ] **Step 4: 实现内存快照与服务的最小规则**

Create `createInMemoryControlRoomStore()` with exactly four tasks (`refactor-auth`, `test-legacy-login`, `review-rate-limit`, `queue-observability`) and three seats. The store must clone no data, keep a `Set<() => void>` listener list, call listeners after `replace`, and return an unsubscribe function.

Implement a private `commit` helper in `createControlRoomService`. It must produce new task, event and activity arrays before calling `store.replace`. Use the following decision messages exactly:

```ts
'人工决定：已接受此改动'
'人工决定：已驳回此改动'
'人工反馈：' + trimmedFeedback
'请求人工决策：请确认是否继续覆盖旧版分支'
'Agent 正在整理本次工作总结'
```

`accept` and `reject` only change tasks whose status is `in_review`; `requestDecision` and `requestSummary` only change tasks whose status is `running`; `sendFeedback` only appends a non-empty trimmed string to `needs_input` or `in_review` tasks.

- [ ] **Step 5: 运行服务测试并确认通过**

Run: `npm run test -- --run src/application/control-room-service.test.ts`  
Expected: PASS, 3 tests.

- [ ] **Step 6: 提交领域闭环**

```bash
git add src/domain src/ports src/application src/adapters
git commit -m "feat: add control room domain workflow"
```

## Task 3: 以测试驱动控制室交互界面

**Files:**
- Modify: `src/app/App.tsx`
- Create: `src/ui/use-control-room.ts`
- Create: `src/ui/ControlRoomPage.tsx`
- Create: `src/ui/ProjectSidebar.tsx`
- Create: `src/ui/TaskBoard.tsx`
- Create: `src/ui/TaskCard.tsx`
- Create: `src/ui/TaskInspector.tsx`
- Create: `src/ui/Timeline.tsx`
- Create: `src/ui/ReviewActions.tsx`
- Create: `src/ui/ControlRoomPage.test.tsx`

**Interfaces:**
- Consumes: `ControlRoomService` from Task 2.
- Produces: 可选择任务、请求总结/决策、发送反馈、接受与驳回的控制室界面。

- [ ] **Step 1: 写入失败的用户行为测试**

Create `src/ui/ControlRoomPage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInMemoryControlRoomStore } from '../adapters/in-memory-control-room'
import { createControlRoomService } from '../application/control-room-service'
import { ControlRoomPage } from './ControlRoomPage'

function renderPage() {
  const service = createControlRoomService(createInMemoryControlRoomStore())
  render(<ControlRoomPage service={service} />)
  return userEvent.setup()
}

test('shows the three seats and all four initial task columns', () => {
  renderPage()
  expect(screen.getByText('实现者')).toBeInTheDocument()
  expect(screen.getByText('测试者')).toBeInTheDocument()
  expect(screen.getByText('审查者')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '待开始' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '执行中' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '等待输入' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '审查中' })).toBeInTheDocument()
})

test('accepting the selected review task updates its card and activity record', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '审查速率限制改动' }))
  await user.click(screen.getByRole('button', { name: '接受改动' }))

  expect(screen.getByText('已接受')).toBeInTheDocument()
  expect(screen.getByText('人工决定：已接受此改动')).toBeInTheDocument()
})

test('disables review decisions for a running task', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '重构身份验证中间件' }))

  expect(screen.getByRole('button', { name: '接受改动' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '驳回改动' })).toBeDisabled()
})
```

- [ ] **Step 2: 运行组件测试并确认失败原因是缺少页面组件**

Run: `npm run test -- --run src/ui/ControlRoomPage.test.tsx`  
Expected: FAIL with missing `ControlRoomPage` module.

- [ ] **Step 3: 实现 hook 与展示组件**

Implement `useControlRoom(service)` with `useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)`.

Implement `ControlRoomPage` to select `review-rate-limit` initially. Render its regions with landmark labels:

```tsx
<aside aria-label="项目与 Agent 席位" />
<section aria-label="任务看板" />
<aside aria-label="任务详情与审查" />
```

`TaskBoard` must create headings for `待开始` (`todo`), `执行中` (`running`), `等待输入` (`needs_input`) and `审查中` (`in_review`). `TaskCard` is a button named exactly as its task title. `TaskInspector` must render the title, status label, changed files, optional diff summary and test output, then a `Timeline`.

`ReviewActions` must expose these exact button labels: `请求总结`、`需要决策`、`发送反馈`、`接受改动`、`驳回改动`. Disable actions when their task status does not meet the conditions in Task 2. Use a labeled textarea named `发送给 Agent 的反馈` and disable the send button for whitespace-only values.

Set `App` to create one `InMemoryControlRoomStore` and one service only once with `useMemo`, then render `<ControlRoomPage service={service} />`.

- [ ] **Step 4: 运行组件测试并确认通过**

Run: `npm run test -- --run src/ui/ControlRoomPage.test.tsx`  
Expected: PASS, 3 tests.

- [ ] **Step 5: 运行全部测试并提交界面行为**

Run: `npm run test -- --run`  
Expected: PASS, 7 tests.

```bash
git add src/app src/ui
git commit -m "feat: add interactive control room interface"
```

## Task 4: 完成视觉系统、响应式样式与浏览器验收

**Files:**
- Create: `src/styles.css`
- Modify: `src/app/App.tsx`
- Modify: `src/ui/ControlRoomPage.tsx`
- Modify: `src/ui/ProjectSidebar.tsx`
- Modify: `src/ui/TaskBoard.tsx`
- Modify: `src/ui/TaskCard.tsx`
- Modify: `src/ui/TaskInspector.tsx`
- Modify: `src/ui/Timeline.tsx`
- Modify: `src/ui/ReviewActions.tsx`

**Interfaces:**
- Consumes: Task 3 的语义化 React 结构。
- Produces: 可在桌面与移动视口阅读和操作的高密度操作台。

- [ ] **Step 1: 实现视觉令牌和响应式布局**

Create `src/styles.css` using these root tokens:

```css
:root {
  --canvas: #eef1ef;
  --surface: #f9faf8;
  --ink: #1c2925;
  --muted: #60706a;
  --line: #ccd4cf;
  --running: #007e71;
  --waiting: #a85a00;
  --review: #1c5e78;
  --danger: #b42a50;
}
```

Use a three-column CSS grid at widths above 1100px. Between 700px and 1099px use a two-row grid with the inspector spanning the width. At widths below 700px, stack the sidebar, horizontally scrollable board and inspector vertically. Keep task columns at a stable minimum width, set buttons to visible focus styles, and include `@media (prefers-reduced-motion: reduce)` to disable transitions.

Use status text plus color for every state. Use 8px maximum border radii. Keep the time rail visible through a left border and event dots, but do not use decorative gradients or floating section cards.

- [ ] **Step 2: 运行全部测试和生产构建**

Run:

```bash
npm run test -- --run
npm run build
```

Expected: all tests PASS and Vite build exits 0.

- [ ] **Step 3: 启动本地服务器并用 gstack 验收**

Run: `npm run dev -- --host 127.0.0.1`

Using gstack browse:

```bash
$B goto http://127.0.0.1:5173
$B snapshot -i
$B click <审查速率限制改动对应按钮>
$B click <接受改动对应按钮>
$B snapshot -D
$B console --errors
$B responsive /tmp/control-room
```

Expected: 接受后任务和活动记录都更新；控制台无错误；桌面、平板、移动截图中没有重叠或截断。

- [ ] **Step 4: 提交完成版本**

```bash
git add src/styles.css src/app src/ui
git commit -m "feat: style responsive control room prototype"
```

## 计划自检

- 规格中的三个席位、四种初始任务状态、五个动作、时间轨、产物区和响应式要求都由 Task 2 至 Task 4 覆盖。
- 原型 0 排除的真实 Runtime、Git、网络、文件系统和持久化没有进入任何任务。
- 所有状态变更通过应用服务发生，UI 不导入假数据。
- Task 2 和 Task 3 的测试先于对应实现；禁用状态测试已在 Task 3 的界面实现前写入。
