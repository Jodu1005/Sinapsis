import { SendHorizontal } from 'lucide-react'
import { FormEvent, useState } from 'react'

export function MessageComposer({ channelName, onSend }: { channelName: string; onSend(body: string): Promise<void> }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    try { await onSend(body.trim()); setBody('') } finally { setSending(false) }
  }
  return <form className="message-composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="message-body">发送消息</label>
    <textarea id="message-body" aria-label="发送消息" rows={1} value={body} onChange={(event) => setBody(event.target.value)} placeholder={`发送消息到 # ${channelName}`} />
    <button type="submit" className="send-button" aria-label="发送消息" disabled={!body.trim() || sending}><SendHorizontal size={18} /></button>
  </form>
}
