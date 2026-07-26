import { SendHorizontal } from 'lucide-react'
import { FormEvent, KeyboardEvent, useMemo, useRef, useState } from 'react'
import { distinctAgentsByIdentity, type AgentView } from '../domain/workspace-view'

interface MentionMatch {
  query: string
  start: number
  end: number
}

export function MessageComposer({ channelName, agents, onSend }: { channelName: string; agents: AgentView[]; onSend(body: string): Promise<{ notice?: string } | void> }) {
  const [body, setBody] = useState('')
  const [caret, setCaret] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const mention = mentionAtCaret(body, caret)
  const suggestions = useMemo(() => {
    if (!mention) return []
    const query = mention.query.toLocaleLowerCase()
    return distinctAgentsByIdentity(agents).filter((agent) => agent.identity.toLocaleLowerCase().includes(query))
  }, [agents, mention])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!body.trim() || sending) return
    setSending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await onSend(body.trim())
      setBody('')
      setCaret(0)
      setNotice(result?.notice ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '消息发送失败，请重试。')
    } finally { setSending(false) }
  }

  const selectAgent = (agent: AgentView) => {
    if (!mention) return
    const replacement = `@${agent.identity} `
    setBody(`${body.slice(0, mention.start)}${replacement}${body.slice(mention.end)}`)
    setCaret(mention.start + replacement.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    formRef.current?.requestSubmit()
  }

  return <form ref={formRef} className="message-composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="message-body">发送消息</label>
    <textarea id="message-body" aria-label="发送消息" rows={1} value={body} onChange={(event) => { setBody(event.target.value); setCaret(event.target.selectionStart) }} onClick={(event) => setCaret(event.currentTarget.selectionStart)} onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder={`发送消息到 # ${channelName}`} />
    {mention && suggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="可提及 Agent">{suggestions.map((agent) => <button key={agent.id} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => selectAgent(agent)}><strong>@{agent.identity}</strong><small>{agent.runtime} · {statusLabel(agent.status)}</small></button>)}</div>}
    <button type="submit" className="send-button" aria-label="发送消息" disabled={!body.trim() || sending}><SendHorizontal size={18} /></button>
    {error && <p className="form-error composer-error" role="alert">{error}</p>}
    {notice && <p className="composer-notice" role="status">{notice}</p>}
  </form>
}

function mentionAtCaret(body: string, caret: number): MentionMatch | undefined {
  const beforeCaret = body.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return undefined
  return { query: match[2] ?? '', start: caret - (match[2]?.length ?? 0) - 1, end: caret }
}

function statusLabel(status: AgentView['status']): string {
  return { idle: '空闲', busy: '忙碌', offline: '离线', error: '异常' }[status]
}
