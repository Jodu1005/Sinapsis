import { describe, expect, it } from 'vitest'
import { AgentInvocationQueue, AgentInvocationQueueCancelledError } from './agent-invocation-queue'

describe('AgentInvocationQueue', () => {
  it('serializes calls for one Agent while allowing different Agents to overlap', async () => {
    const queue = new AgentInvocationQueue()
    const first = deferred<void>()
    const second = deferred<void>()
    const other = deferred<void>()
    const started: string[] = []

    const firstResult = queue.enqueue(invocation('first', 'agent-a', 'human_ordinary', 1, async () => {
      started.push('first')
      await first.promise
      return 'first-result'
    }))
    const secondResult = queue.enqueue(invocation('second', 'agent-a', 'human_ordinary', 2, async () => {
      started.push('second')
      await second.promise
      return 'second-result'
    }))
    const otherResult = queue.enqueue(invocation('other', 'agent-b', 'human_ordinary', 3, async () => {
      started.push('other')
      await other.promise
      return 'other-result'
    }))

    await nextTurn()
    expect(started).toEqual(['first', 'other'])
    expect(queue.snapshot('agent-a')).toEqual({ running: true, queued: 1 })
    expect(queue.snapshot('agent-b')).toEqual({ running: true, queued: 0 })

    other.resolve()
    await expect(otherResult).resolves.toBe('other-result')
    expect(started).toEqual(['first', 'other'])

    first.resolve()
    await expect(firstResult).resolves.toBe('first-result')
    await nextTurn()
    expect(started).toEqual(['first', 'other', 'second'])

    second.resolve()
    await expect(secondResult).resolves.toBe('second-result')
    expect(queue.snapshot('agent-a')).toEqual({ running: false, queued: 0 })
  })

  it('runs a queued human direct call before an unstarted automatic handoff', async () => {
    const queue = new AgentInvocationQueue()
    const blocker = deferred<void>()
    const order: string[] = []

    const running = queue.enqueue(invocation('running', 'agent-a', 'participation', 1, async () => {
      await blocker.promise
      order.push('running')
    }))
    const handoff = queue.enqueue(invocation('handoff', 'agent-a', 'automatic_handoff', 2, async () => {
      order.push('handoff')
    }))
    const direct = queue.enqueue(invocation('direct', 'agent-a', 'human_direct', 3, async () => {
      order.push('direct')
    }))

    blocker.resolve()
    await Promise.all([running, direct, handoff])

    expect(order).toEqual(['running', 'direct', 'handoff'])
  })

  it('reports live positions by invocation after priority insertion and lane progress', async () => {
    const queue = new AgentInvocationQueue()
    const blocker = deferred<void>()
    const directGate = deferred<void>()
    const handoffGate = deferred<void>()
    const running = queue.enqueue(invocation('running', 'agent-a', 'participation', 1, async () => blocker.promise))
    const handoff = queue.enqueue(invocation('handoff', 'agent-a', 'automatic_handoff', 2, async () => handoffGate.promise))
    const direct = queue.enqueue(invocation('direct', 'agent-a', 'human_direct', 3, async () => directGate.promise))

    expect(queue.snapshotInvocation('running')).toEqual({ state: 'running', position: 1 })
    expect(queue.snapshotInvocation('direct')).toEqual({ state: 'queued', position: 2 })
    expect(queue.snapshotInvocation('handoff')).toEqual({ state: 'queued', position: 3 })

    blocker.resolve()
    await running
    await nextTurn()
    expect(queue.snapshotInvocation('direct')).toEqual({ state: 'running', position: 1 })
    expect(queue.snapshotInvocation('handoff')).toEqual({ state: 'queued', position: 2 })

    directGate.resolve()
    await direct
    await nextTurn()
    expect(queue.snapshotInvocation('handoff')).toEqual({ state: 'running', position: 1 })

    handoffGate.resolve()
    await handoff
    await nextTurn()
    expect(queue.snapshotInvocation('handoff')).toEqual({ state: 'not_found', position: null })
  })

  it('keeps a new human ordinary call ahead of an unstarted automatic handoff', async () => {
    const queue = new AgentInvocationQueue()
    const blocker = deferred<void>()
    const order: string[] = []
    const running = queue.enqueue(invocation('running', 'agent-a', 'participation', 1, async () => {
      await blocker.promise
    }))
    const handoff = queue.enqueue(invocation('handoff', 'agent-a', 'automatic_handoff', 2, async () => {
      order.push('handoff')
    }))
    const ordinary = queue.enqueue(invocation('ordinary', 'agent-a', 'human_ordinary', 3, async () => {
      order.push('ordinary')
    }))

    blocker.resolve()
    await Promise.all([running, ordinary, handoff])

    expect(order).toEqual(['ordinary', 'handoff'])
  })

  it('uses ascending global sequence as FIFO within the same priority', async () => {
    const queue = new AgentInvocationQueue()
    const blocker = deferred<void>()
    const order: number[] = []

    const running = queue.enqueue(invocation('running', 'agent-a', 'human_direct', 1, async () => {
      await blocker.promise
    }))
    const later = queue.enqueue(invocation('later', 'agent-a', 'participation', 30, async () => {
      order.push(30)
    }))
    const earlier = queue.enqueue(invocation('earlier', 'agent-a', 'participation', 20, async () => {
      order.push(20)
    }))

    blocker.resolve()
    await Promise.all([running, later, earlier])

    expect(order).toEqual([20, 30])
  })

  it('cancels one queued invocation with a typed error and never runs it later', async () => {
    const queue = new AgentInvocationQueue()
    const blocker = deferred<void>()
    const running = queue.enqueue(invocation('running', 'agent-a', 'automatic_handoff', 1, async () => {
      await blocker.promise
      return 'completed'
    }))
    const queued = queue.enqueue(invocation('queued', 'agent-a', 'automatic_handoff', 2, async () => 'not-run'))
    const cancelled = expect(queued).rejects.toBeInstanceOf(AgentInvocationQueueCancelledError)

    expect(queue.cancelInvocation('queued')).toEqual({ state: 'queued', invocationId: 'queued' })
    expect(queue.cancelInvocation('running')).toEqual({ state: 'running', invocationId: 'running' })
    expect(queue.cancelInvocation('missing')).toEqual({ state: 'not_found', invocationId: 'missing' })

    expect(queue.snapshot('agent-a')).toEqual({ running: true, queued: 0 })
    blocker.resolve()
    await expect(running).resolves.toBe('completed')
    await cancelled
  })
})

function invocation<T>(
  id: string,
  agentId: string,
  priority: Parameters<AgentInvocationQueue['enqueue']>[0]['priority'],
  sequence: number,
  run: () => Promise<T>,
) {
  return { id, agentId, priority, sequence, run }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
