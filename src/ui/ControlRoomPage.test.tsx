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
