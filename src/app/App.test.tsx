import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the control room heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: '控制室' })).toBeInTheDocument()
})
