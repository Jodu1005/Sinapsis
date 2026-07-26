import { Bot, CornerDownRight, X } from 'lucide-react'
import type { AgentView, ChannelMessage } from '../domain/workspace-view'
import { MessageComposer } from './MessageComposer'

export function ThreadPanel({ root, replies, agents, onSend, onClose }: {
  root: ChannelMessage
  replies: ChannelMessage[]
  agents: AgentView[]
  onSend(body: string): Promise<{ notice?: string } | void>
  onClose(): void
}) {
  return <section className="thread-panel" aria-label="Thread">
    <header><strong>Thread</strong><button type="button" className="icon-button" aria-label="关闭 Thread" data-tooltip="关闭 Thread" onClick={onClose}><X size={16} /></button></header>
    <div className="thread-messages">
      <ThreadMessage message={root} />
      {replies.map((message) => <ThreadMessage key={message.id} message={message} />)}
    </div>
    <MessageComposer channelName="Thread" agents={agents} onSend={onSend} />
  </section>
}

function ThreadMessage({ message }: { message: ChannelMessage }) {
  const author = message.senderType === 'human' && message.authorName === 'You' ? '你' : message.senderType === 'system' ? '系统' : message.authorName
  return <article className={`thread-message thread-message-${message.senderType}`}>
    <span className="thread-avatar" aria-hidden="true">{message.senderType === 'agent' ? <Bot size={14} /> : message.senderType === 'system' ? <CornerDownRight size={14} /> : author.slice(0, 1)}</span>
    <div><strong>{author}</strong><p>{message.body}</p></div>
  </article>
}
