import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn } from '../domain/conversation'
import type { Message } from '../domain/message'
import { ConversationCoordinator } from './conversation-coordinator'
import type { ChannelTurnCoordinator } from './channel-turn-coordinator'

describe('ConversationCoordinator compatibility facade', () => {
  it('validates the legacy channel argument before delegating with only the persisted message', async () => {
    const start = vi.fn(() => ({ turn: turn({ status: 'screening' }), completion: Promise.resolve(turn()) }))
    const coordinator = createCoordinator({ start })
    const message = humanMessage()

    await coordinator.dispatch(message.channelId, message)

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(message)
    await expect(coordinator.dispatch('another-channel', message)).rejects.toThrow('Message does not belong to this channel.')
    expect(start).toHaveBeenCalledOnce()
  })

  it('returns after start without waiting for the Turn completion boundary', async () => {
    const pending = deferred<ConversationTurn>()
    const start = vi.fn(() => ({ turn: turn({ status: 'screening' }), completion: pending.promise }))
    const coordinator = createCoordinator({ start })

    await coordinator.dispatch('channel-1', humanMessage())

    expect(start).toHaveBeenCalledOnce()
    expect(await promiseState(pending.promise)).toBe('pending')
    pending.resolve(turn())
  })

  it('delegates legacy channel and Agent cancellation methods', async () => {
    const cancelChannel = vi.fn(async () => undefined)
    const cancelAgentInChannel = vi.fn(async () => undefined)
    const coordinator = createCoordinator({ cancelChannel, cancelAgentInChannel })

    await coordinator.cancelChannel('channel-1')
    await coordinator.cancelAgentInChannel('channel-1', 'a1')

    expect(cancelChannel).toHaveBeenCalledWith('channel-1')
    expect(cancelAgentInChannel).toHaveBeenCalledWith('channel-1', 'a1')
  })
})

function createCoordinator(overrides: Partial<ChannelTurnCoordinator>): ConversationCoordinator {
  const turnCoordinator = {
    start: () => ({ turn: turn({ status: 'screening' }), completion: Promise.resolve(turn()) }),
    dispatch: async () => turn(),
    cancel: async () => turn({ status: 'cancelled' }),
    cancelChannel: async () => undefined,
    cancelAgentInChannel: async () => undefined,
    ...overrides,
  } as ChannelTurnCoordinator
  return new ConversationCoordinator({ turnCoordinator })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function promiseState(promise: Promise<unknown>): Promise<'pending' | 'settled'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ])
}

function humanMessage(): Message {
  return {
    id: 'message-1',
    channelId: 'channel-1',
    threadRootMessageId: null,
    taskId: null,
    senderType: 'human',
    senderId: null,
    authorName: 'You',
    body: 'Question',
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    deletedAt: null,
  }
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    channelId: 'channel-1',
    triggerMessageId: 'message-1',
    threadRootMessageId: null,
    mode: 'ordinary',
    status: 'completed',
    currentRound: 0,
    maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    completedAt: '2026-07-31T08:00:01.000Z',
    ...overrides,
  }
}
