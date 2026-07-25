import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeEvidence } from './RuntimeEvidence'

describe('RuntimeEvidence', () => {
  it('keeps a long-running task detail compact by showing recent output and artifacts', () => {
    const artifacts = Array.from({ length: 16 }, (_, index) => ({
      id: `artifact-${index}`, taskId: 'task-1', kind: 'runtime-jsonl', createdAt: `2026-07-25T08:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const events = Array.from({ length: 60 }, (_, index) => ({
      id: `event-${index}`, taskId: 'task-1', type: 'runtime.text', payload: { text: `E${String(index).padStart(3, '0')}|` }, createdAt: `2026-07-25T08:${String(index).padStart(2, '0')}:00.000Z`,
    }))

    render(<RuntimeEvidence artifacts={artifacts} events={events} onReadArtifact={vi.fn()} />)

    expect(screen.getByLabelText('Agent 实时输出')).toHaveTextContent('E010|')
    expect(screen.getByLabelText('Agent 实时输出')).not.toHaveTextContent('E000|')
    expect(screen.getAllByRole('button', { name: 'runtime-jsonl' })).toHaveLength(12)
    expect(screen.getByText('显示最近 12 项，共 16 项。')).toBeInTheDocument()
  })
})
