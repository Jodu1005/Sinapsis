import { Bot, CornerDownRight } from 'lucide-react'
import type { ChannelMessage } from '../domain/workspace-view'

export function ChannelTimeline({ messages }: { messages: ChannelMessage[] }) {
  return <section className="channel-timeline" aria-label="频道消息" aria-live="polite">
    {messages.length === 0 ? <div className="empty-timeline"><p>这里还没有消息</p><span>发一条消息，或在任务里 @ 指定 Agent。</span></div> : messages.map((message) => <article className={`message message-${message.senderType}`} key={message.id}>
      <div className="message-avatar" aria-hidden="true">{message.senderType === 'agent' ? <Bot size={17} /> : message.senderType === 'system' ? <CornerDownRight size={17} /> : message.authorName.slice(0, 1)}</div>
      <div className="message-copy"><div><strong>{displayAuthorName(message)}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div><p>{message.body}</p></div>
    </article>)}
  </section>
}

function displayAuthorName(message: ChannelMessage): string {
  if (message.senderType === 'human' && message.authorName === 'You') return '你'
  if (message.senderType === 'system') return '系统'
  return message.authorName
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
