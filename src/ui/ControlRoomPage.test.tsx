import { render, screen, within } from '@testing-library/react'
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

test('shows a labeled recent activity region with an explicit empty state', () => {
  renderPage()

  const recentActivity = screen.getByRole('region', { name: '近期活动' })
  expect(within(recentActivity).getByText('尚无活动')).toBeInTheDocument()

  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  expect(within(timeline).queryByText('尚无活动')).not.toBeInTheDocument()
})

test('shows a textual empty state without a timeline rail for a task with no events', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '补充队列可观测性' }))

  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  expect(within(timeline).getByText('暂无活动')).toBeInTheDocument()
  expect(within(timeline).queryByRole('list', { name: '任务活动' })).not.toBeInTheDocument()
})

test('renders the real initial review evidence and typed timeline', () => {
  renderPage()

  expect(within(screen.getByRole('region', { name: '差异摘要' })).getByText(/速率限制/)).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '测试输出' })).getByText(/通过/)).toBeInTheDocument()

  const timeline = screen.getByRole('list', { name: '任务活动' })
  expect(within(timeline).getAllByRole('listitem').map((item) => item.dataset.kind)).toEqual([
    'agent',
    'artifact',
    'checkpoint',
  ])
})

test('renders selected typed task events in append order with rejected decision tone', () => {
  const service = createControlRoomService(createInMemoryControlRoomStore())
  const initialSnapshot = service.getSnapshot()
  const events = [
    {
      id: 'event-agent',
      kind: 'agent' as const,
      message: '完成编译检查',
      at: '2026-07-23T00:01:00.000Z',
    },
    {
      id: 'event-artifact',
      kind: 'artifact' as const,
      message: '生成测试产物',
      at: '2026-07-23T00:02:00.000Z',
    },
    {
      id: 'event-decision',
      kind: 'decision' as const,
      message: '停止合入',
      at: '2026-07-23T00:03:00.000Z',
    },
  ]
  const snapshot = {
    ...initialSnapshot,
    activities: [],
    tasks: initialSnapshot.tasks.map((task) => (
      task.id === 'review-rate-limit'
        ? { ...task, status: 'rejected' as const, events }
        : task
    )),
  }
  const staticService = {
    ...service,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  }

  render(<ControlRoomPage service={staticService} />)

  const timeline = screen.getByRole('list', { name: '任务活动' })
  const timelineItems = within(timeline).queryAllByRole('listitem')
  expect(timelineItems.map((item) => item.textContent)).toEqual([
    '2026-07-23T00:01:00.000Z完成编译检查',
    '2026-07-23T00:02:00.000Z生成测试产物',
    '2026-07-23T00:03:00.000Z停止合入',
  ])
  expect(timelineItems.map((item) => item.dataset.kind)).toEqual([
    'agent',
    'artifact',
    'decision',
  ])
  expect(timelineItems[2]).toHaveAttribute('data-tone', 'rejection')
})

test('shows Chinese task metadata with an exact accessible name and described status', () => {
  renderPage()

  const runningColumn = screen.getByRole('region', { name: '执行中' })
  const taskCard = within(runningColumn).getByRole('button', {
    name: '重构身份验证中间件',
  })

  expect(taskCard).toHaveAccessibleName('重构身份验证中间件')
  expect(taskCard).toHaveAccessibleDescription('执行中')
  expect(within(taskCard).queryByText('负责人 实现者')).toBeInTheDocument()
  expect(within(taskCard).queryByText('正在简化身份验证边界。')).toBeInTheDocument()
  expect(within(taskCard).queryByText('更新于 7月23日 00:00')).toBeInTheDocument()
})

test('accepting the selected review task updates its card and activity record', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '审查速率限制改动' }))
  await user.click(screen.getByRole('button', { name: '接受改动' }))

  const completedColumn = screen.getByRole('region', { name: '已完成' })
  const acceptedTask = within(completedColumn).getByRole('button', { name: '审查速率限制改动' })
  expect(within(acceptedTask).getByText('已接受')).toBeInTheDocument()

  const recentActivity = screen.getByRole('region', { name: '近期活动' })
  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  expect(within(recentActivity).getByText('人工决定：已接受此改动')).toBeInTheDocument()
  expect(within(timeline).getByText('人工决定：已接受此改动')).toBeInTheDocument()
})

test('disables review decisions for a running task', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '重构身份验证中间件' }))

  expect(screen.getByRole('button', { name: '接受改动' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '驳回改动' })).toBeDisabled()
})

test('keeps an accepted task visible in the completed column with its terminal status', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '接受改动' }))

  const completedColumn = screen.getByRole('region', { name: '已完成' })
  const acceptedTask = within(completedColumn).getByRole('button', { name: '审查速率限制改动' })
  expect(within(acceptedTask).getByText('已接受')).toBeInTheDocument()
})

test('keeps a rejected task visible in the completed column with its terminal status', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '驳回改动' }))

  const completedColumn = screen.getByRole('region', { name: '已完成' })
  const rejectedTask = within(completedColumn).getByRole('button', { name: '审查速率限制改动' })
  expect(within(rejectedTask).getByText('已驳回')).toBeInTheDocument()
})

test('requesting a summary adds evidence to the selected task timeline', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '重构身份验证中间件' }))
  await user.click(screen.getByRole('button', { name: '请求总结' }))

  const timeline = screen.getByRole('list', { name: '任务活动' })
  expect(within(timeline).getByText('Agent 正在整理本次工作总结')).toBeInTheDocument()
  const recentActivity = screen.getByRole('region', { name: '近期活动' })
  expect(within(recentActivity).getByText('Agent 正在整理本次工作总结')).toBeInTheDocument()
})

test('requesting a decision moves the running task to waiting for input', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '重构身份验证中间件' }))
  await user.click(screen.getByRole('button', { name: '需要决策' }))

  const needsInputColumn = screen.getByRole('region', { name: '等待输入' })
  expect(within(needsInputColumn).getByRole('button', { name: '重构身份验证中间件' })).toBeInTheDocument()
  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  const recentActivity = screen.getByRole('region', { name: '近期活动' })
  expect(within(timeline).getByText('请求人工决策：请确认是否继续覆盖旧版分支')).toBeInTheDocument()
  expect(within(recentActivity).getByText('请求人工决策：请确认是否继续覆盖旧版分支')).toBeInTheDocument()
})

test('submitting requested input returns the task to running', async () => {
  const user = renderPage()

  await user.click(screen.getByRole('button', { name: '重构身份验证中间件' }))
  await user.click(screen.getByRole('button', { name: '需要决策' }))
  await user.type(
    screen.getByRole('textbox', { name: '发送给 Agent 的反馈' }),
    '继续覆盖旧版分支',
  )
  await user.click(screen.getByRole('button', { name: '发送反馈' }))

  const runningColumn = screen.getByRole('region', { name: '执行中' })
  expect(within(runningColumn).getByRole('button', { name: '重构身份验证中间件' })).toBeInTheDocument()
  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  expect(within(timeline).getByText('人工反馈：继续覆盖旧版分支')).toBeInTheDocument()
})

test('sending non-empty feedback adds it to the timeline and clears the textarea', async () => {
  const user = renderPage()
  const feedback = screen.getByRole('textbox', { name: '发送给 Agent 的反馈' })

  await user.type(feedback, '请补充边界条件测试')
  await user.click(screen.getByRole('button', { name: '发送反馈' }))

  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  const recentActivity = screen.getByRole('region', { name: '近期活动' })
  expect(within(timeline).getByText('人工反馈：请补充边界条件测试')).toBeInTheDocument()
  expect(within(recentActivity).getByText('人工反馈：请补充边界条件测试')).toBeInTheDocument()
  expect(feedback).toHaveValue('')
})

test('keeps feedback sending disabled for whitespace-only input', async () => {
  const user = renderPage()

  await user.type(screen.getByRole('textbox', { name: '发送给 Agent 的反馈' }), '   ')

  expect(screen.getByRole('button', { name: '发送反馈' })).toBeDisabled()
})

test('shows Agent seat states in Chinese', () => {
  renderPage()

  const sidebar = screen.getByRole('complementary', { name: '项目与 Agent 席位' })
  expect(within(sidebar).getByText('进行中')).toBeInTheDocument()
  expect(within(sidebar).getByText('等待中')).toBeInTheDocument()
  expect(within(sidebar).getByText('审查中')).toBeInTheDocument()
  expect(within(sidebar).queryByText(/^(active|waiting|reviewing)$/)).not.toBeInTheDocument()
})

test('clears the feedback draft when switching between eligible tasks', async () => {
  const user = renderPage()
  const staleDraft = '只适用于速率限制任务'

  await user.type(screen.getByRole('textbox', { name: '发送给 Agent 的反馈' }), staleDraft)
  await user.click(screen.getByRole('button', { name: '验证旧版登录分支' }))

  const feedback = screen.getByRole('textbox', { name: '发送给 Agent 的反馈' })
  const sendFeedback = screen.getByRole('button', { name: '发送反馈' })
  expect(feedback).toHaveValue('')
  expect(sendFeedback).toBeDisabled()

  await user.click(sendFeedback)
  const timeline = screen.getByRole('region', { name: '活动时间轨' })
  expect(within(timeline).queryByText(`人工反馈：${staleDraft}`)).not.toBeInTheDocument()
})

test('selected task card keeps a distinct keyboard focus outline', () => {
  renderPage()

  const selectedTask = screen.getByRole('button', { name: '审查速率限制改动' })
  selectedTask.focus()

  expect(selectedTask).toHaveFocus()
  expect(selectedTask).toHaveAttribute('aria-pressed', 'true')
})

test('renders the control room and an inspector empty state when there are no tasks', () => {
  const initial = createInMemoryControlRoomStore().getSnapshot()
  const store = createInMemoryControlRoomStore({
    ...initial,
    tasks: [],
  })
  const service = createControlRoomService(store)

  render(<ControlRoomPage service={service} />)

  expect(screen.getByRole('heading', { name: '控制室' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '任务看板' })).toBeInTheDocument()
  const inspector = screen.getByRole('complementary', { name: '任务详情与审查' })
  expect(within(inspector).getByText('选择一个任务查看会话与审查记录')).toBeInTheDocument()
  expect(within(inspector).queryByRole('button', { name: '接受改动' })).not.toBeInTheDocument()
})
