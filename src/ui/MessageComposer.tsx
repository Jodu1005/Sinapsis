import { SendHorizontal, Square } from 'lucide-react'
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

export function MessageComposer({
  channelName,
  agents,
  onSend,
  onStop,
}: {
  channelName: string
  agents: AgentView[]
  onSend(body: string): Promise<{ notice?: string } | void>
  onStop?: () => Promise<void>
}) {
  const [body, setBody] = useState('')
  const [caret, setCaret] = useState(0)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [closedMentionKey, setClosedMentionKey] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const mention = mentionAtCaret(body, caret, agents)
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

  const stop = async () => {
    if (!onStop || stopping) return
    setStopping(true)
    setError(null)
    setNotice(null)
    try {
      await onStop()
      setNotice('已停止当前频道进行中的对话。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '停止对话失败，请重试。')
    } finally { setStopping(false) }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.shiftKey) return
    if (suggestions.length > 0 && event.key === 'Escape') {
      event.preventDefault()
      const currentMention = mentionAtCaret(body, event.currentTarget.selectionStart, agents)
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
      selectSuggestion(selected, mentionAtCaret(body, event.currentTarget.selectionStart, agents))
      return
    }
    formRef.current?.requestSubmit()
  }

  return <form ref={formRef} className="message-composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="message-body">发送消息</label>
    <textarea id="message-body" aria-label="发送消息" rows={1} value={body} onChange={(event) => { setBody(event.target.value); setCaret(event.target.selectionStart); setClosedMentionKey(null) }} onClick={(event) => setCaret(event.currentTarget.selectionStart)} onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder={`发送消息到 # ${channelName}`} />
    {mention && suggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="可提及 Agent">{suggestions.map((suggestion, index) => <button key={suggestion.id} type="button" role="option" aria-selected={index === activeSuggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}><strong>@{suggestion.identity}</strong>{suggestion.kind === 'all' ? <small>当前频道全部成员</small> : <small>{suggestion.agent.runtime} · {statusLabel(suggestion.agent.status)}</small>}</button>)}</div>}
    {onStop && <button type="button" className="stop-conversation-button" aria-label="停止当前频道对话" disabled={stopping} onClick={() => void stop()}><Square size={14} fill="currentColor" />{stopping ? '停止中' : '停止'}</button>}
    <button type="submit" className="send-button" aria-label="发送消息" disabled={!body.trim() || sending}><SendHorizontal size={18} /></button>
    {error && <p className="form-error composer-error" role="alert">{error}</p>}
    {notice && <p className="composer-notice" role="status">{notice}</p>}
  </form>
}

function mentionKey(mention: MentionMatch): string {
  return `${mention.start}:${mention.end}:${mention.query}`
}

function mentionAtCaret(body: string, caret: number, agents: AgentView[]): MentionMatch | undefined {
  const beforeCaret = body.slice(0, caret)
  const start = beforeCaret.lastIndexOf('@')
  if (start < 0) return undefined
  const lineStart = beforeCaret.lastIndexOf('\n', start - 1) + 1
  if (!isLeadingMentionPosition(body.slice(lineStart, start), agents)) return undefined
  const query = beforeCaret.slice(start + 1)
  if (query.includes('@') || query.includes('\n')) return undefined
  return { query, start, end: caret }
}

function isLeadingMentionPosition(value: string, agents: AgentView[]): boolean {
  const prefix = value.match(/^[\t ]*(?:(?:>|[-*+])\s+|\d+[.)]\s+)?/)?.[0] ?? ''
  let remaining = value.slice(prefix.length)
  const aliases = [...new Set(agents.flatMap((agent) => [agent.identity, agent.mentionName]))]
    .map((alias) => alias.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  while (remaining) {
    const alias = aliases.find((candidate) => mentionStartsWith(remaining, candidate))
    const tokenLength = alias
      ? alias.length + 1
      : remaining.match(/^@[\p{L}\p{N}_/-]+(?=[\t ]|$)/u)?.[0].length
    if (!tokenLength) return false
    remaining = remaining.slice(tokenLength)
    const whitespace = remaining.match(/^[\t ]+/)?.[0] ?? ''
    if (!whitespace) return false
    remaining = remaining.slice(whitespace.length)
  }
  return true
}

function mentionStartsWith(value: string, alias: string): boolean {
  if (!value.toLocaleLowerCase().startsWith(`@${alias}`.toLocaleLowerCase())) return false
  const next = value[alias.length + 1]
  return next === undefined || !/[A-Za-z0-9_/-]/u.test(next)
}

function normalizeMentionText(value: string): string {
  return value.trimStart().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function statusLabel(status: AgentView['status']): string {
  return { idle: '空闲', busy: '忙碌', offline: '离线', error: '异常' }[status]
}
