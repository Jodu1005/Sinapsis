export type MessageSenderType = 'human' | 'agent' | 'system'

export interface Message {
  id: string
  channelId: string
  threadRootMessageId?: string | null
  taskId: string | null
  senderType: MessageSenderType
  senderId: string | null
  authorName: string
  body: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface CreateMessageInput {
  channelId: string
  threadRootMessageId?: string | null
  taskId?: string | null
  senderType: MessageSenderType
  senderId?: string | null
  authorName: string
  body: string
}
