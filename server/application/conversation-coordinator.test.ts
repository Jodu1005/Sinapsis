import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn } from '../domain/conversation'
import type { Message } from '../domain/message'
import { ConversationCoordinator } from './conversation-coordinator'
import type { ChannelTurnCoordinator, TurnActivity } from './channel-turn-coordinator'

describe('ConversationCoordinator compatibility facade', () => {
  it('validates the legacy channel argument before delegating with only the persisted message', async () => {
    const dispatch = vi.fn(async () => turn())
    const coordinator = createCoordinator({ dispatch })
    const message = humanMessage()

    await coordinator.dispatch(message.channelId, message)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(message)
    await expect(coordinator.dispatch('another-channel', message)).rejects.toThrow('Message does not belong to this channel.')
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('derives legacy typing Agent IDs from active turn states without duplicates', () => {
    const coordinator = createCoordinator({
      getActiveStates: () => [
        activity('a1', 'judging'),
        activity('a1', 'queued'),
        activity('a2', 'preparing'),
        activity(null, 'screening'),
      ],
    })

    expect(coordinator.getTypingAgentIds('channel-1')).toEqual(['a1', 'a2'])
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
    dispatch: async () => turn(),
    cancel: async () => turn({ status: 'cancelled' }),
    getActiveStates: () => [],
    cancelChannel: async () => undefined,
    cancelAgentInChannel: async () => undefined,
    ...overrides,
  } as ChannelTurnCoordinator
  return new ConversationCoordinator({ turnCoordinator })
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

function activity(agentId: string | null, phase: TurnActivity['phase']): TurnActivity {
  return { turnId: 'turn-1', agentId, phase, queuePosition: null }
}
