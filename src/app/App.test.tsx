import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the workspace loading state', () => {
  render(<App />)
  expect(screen.getByText('正在连接本机工作空间...')).toBeInTheDocument()
})
