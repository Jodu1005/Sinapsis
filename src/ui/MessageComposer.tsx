import { SendHorizontal } from 'lucide-react'
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { distinctAgentsByIdentity, type AgentView } from '../domain/workspace-view'

interface MentionMatch {
  query: string
  start: number
  end: number
}

type MentionSuggestion =
  | { kind: 'all'; id: 'all'; identity: 'all' }
  | { kind: 'agent'; id: string; agent: AgentView; identity: string }

export function MessageComposer({ channelName, agents, onSend }: { channelName: string; agents: AgentView[]; onSend(body: string): Promise<{ notice?: string } | void> }) {
  const [body, setBody] = useState('')
  const [caret, setCaret] = useState(0)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [closedMentionKey, setClosedMentionKey] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const mention = mentionAtCaret(body, caret)
  const suggestions = useMemo(() => {
    if (!mention) return []
    if (closedMentionKey === mentionKey(mention)) return []
    const query = normalizeMentionText(mention.query)
    const agentSuggestions: MentionSuggestion[] = distinctAgentsByIdentity(agents)
      .filter((agent) => agent.identity.toLocaleLowerCase() !== 'all' && agent.mentionName.toLocaleLowerCase() !== 'all')
      .filter((agent) => normalizeMentionText(agent.identity).includes(query) || normalizeMentionText(agent.mentionName).includes(query))
      .map((agent) => ({ kind: 'agent', id: agent.id, agent, identity: agent.identity }))
    const allSuggestions: MentionSuggestion[] = 'all'.includes(query) ? [{ kind: 'all', id: 'all', identity: 'all' }] : []
    return [...allSuggestions, ...agentSuggestions]
  }, [agents, closedMentionKey, mention])
  useEffect(() => { setActiveSuggestionIndex(0) }, [mention?.query, mention?.start, closedMentionKey])

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

  const selectSuggestion = (suggestion: MentionSuggestion, selection = mention) => {
    if (!selection) return
    const replacement = `@${suggestion.identity} `
    setBody(`${body.slice(0, selection.start)}${replacement}${body.slice(selection.end)}`)
    setCaret(selection.start + replacement.length)
    setClosedMentionKey(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.shiftKey) return
    if (suggestions.length > 0 && event.key === 'Escape') {
      event.preventDefault()
      const currentMention = mentionAtCaret(body, event.currentTarget.selectionStart)
      setClosedMentionKey(currentMention ? mentionKey(currentMention) : null)
      return
    }
    if (suggestions.length > 0 && event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index + 1) % suggestions.length)
      return
    }
    if (suggestions.length > 0 && event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const selected = suggestions[activeSuggestionIndex]
    if (selected) {
      selectSuggestion(selected, mentionAtCaret(body, event.currentTarget.selectionStart))
      return
    }
    formRef.current?.requestSubmit()
  }

  return <form ref={formRef} className="message-composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="message-body">发送消息</label>
    <textarea id="message-body" aria-label="发送消息" rows={1} value={body} onChange={(event) => { setBody(event.target.value); setCaret(event.target.selectionStart); setClosedMentionKey(null) }} onClick={(event) => setCaret(event.currentTarget.selectionStart)} onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder={`发送消息到 # ${channelName}`} />
    {mention && suggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="可提及 Agent">{suggestions.map((suggestion, index) => <button key={suggestion.id} type="button" role="option" aria-selected={index === activeSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}><strong>@{suggestion.identity}</strong>{suggestion.kind === 'all' ? <small>当前频道全部成员</small> : <small>{suggestion.agent.runtime} · {statusLabel(suggestion.agent.status)}</small>}</button>)}</div>}
    <button type="submit" className="send-button" aria-label="发送消息" disabled={!body.trim() || sending}><SendHorizontal size={18} /></button>
    {error && <p className="form-error composer-error" role="alert">{error}</p>}
    {notice && <p className="composer-notice" role="status">{notice}</p>}
  </form>
}

function mentionKey(mention: MentionMatch): string {
  return `${mention.start}:${mention.end}:${mention.query}`
}

function mentionAtCaret(body: string, caret: number): MentionMatch | undefined {
  const beforeCaret = body.slice(0, caret)
  const start = beforeCaret.lastIndexOf('@')
  if (start < 0) return undefined
  const query = beforeCaret.slice(start + 1)
  if (query.includes('@')) return undefined
  return { query, start, end: caret }
}

function normalizeMentionText(value: string): string {
  return value.trimStart().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function statusLabel(status: AgentView['status']): string {
  return { idle: '空闲', busy: '忙碌', offline: '离线', error: '异常' }[status]
}
