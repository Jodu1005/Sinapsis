import { Check, CircleAlert, Clock3, LoaderCircle, Terminal, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskArtifactView } from '../domain/workspace-view'

type ProcessEntry = {
  id: string
  createdAt: string
  kind: 'message' | 'tool_start' | 'tool_end' | 'tool_error' | 'stderr'
  text: string
}

export function TaskProcessConsole({ artifacts, onReadArtifact }: {
  artifacts: TaskArtifactView[]
  onReadArtifact(artifactId: string): Promise<string>
}) {
  const [entries, setEntries] = useState<ProcessEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const processArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.kind === 'runtime-jsonl' || artifact.kind === 'runtime-stderr'),
    [artifacts],
  )
  const processArtifactKey = processArtifacts.map((artifact) => `${artifact.id}:${artifact.createdAt}`).join('|')

  useEffect(() => {
    let active = true
    if (!processArtifacts.length) {
      setEntries([])
      setError(null)
      return () => { active = false }
    }
    setError(null)
    void Promise.all(processArtifacts.map(async (artifact) => ({ artifact, content: await onReadArtifact(artifact.id) }))).then(
      (records) => {
        const toolNames = new Map<string, string>()
        if (active) setEntries(compactMessages(records.flatMap(({ artifact, content }) => entriesFromArtifact(artifact, content, toolNames))))
      },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '无法读取执行过程。') },
    )
    return () => { active = false }
  // The stable key avoids needless rereads when the task detail object receives unrelated updates.
  }, [onReadArtifact, processArtifactKey])

  useEffect(() => {
    const output = outputRef.current
    if (typeof output?.scrollTo === 'function') output.scrollTo({ top: output.scrollHeight, behavior: 'smooth' })
  }, [entries.length])

  if (!processArtifacts.length) return <section className="task-process-console-empty"><Terminal size={18} /><p>还没有可读取的 OpenCode 过程记录。</p></section>
  if (error) return <section className="task-process-console-empty" role="alert"><CircleAlert size={18} /><p>{error}</p></section>
  if (!entries.length) return <section className="task-process-console-empty"><LoaderCircle size={18} className="spin" /><p>正在读取 OpenCode 过程...</p></section>

  const toolCount = entries.filter((entry) => entry.kind === 'tool_start' || entry.kind === 'tool_end').length
  const messageCount = entries.filter((entry) => entry.kind === 'message').length
  const hasError = entries.some((entry) => entry.kind === 'tool_error' || entry.kind === 'stderr')

  return <section className="task-process-console" aria-label="OpenCode 执行过程">
    <header className="task-process-header">
      <div className="task-process-heading"><span className="task-process-heading-icon"><Terminal size={15} /></span><div><strong>OpenCode 执行过程</strong><small>按时间保留 Agent 的运行记录</small></div></div>
      <div className="task-process-summary"><span className={`task-process-state${hasError ? ' is-error' : ''}`}><Clock3 size={13} />{hasError ? '有错误' : '已记录'}</span><span>{toolCount} 个工具 · {messageCount} 条回复</span></div>
    </header>
    <div ref={outputRef} className="task-process-output" aria-live="polite"><div className="task-process-track" aria-hidden="true" />{entries.map((entry) => <article key={entry.id} className={`task-process-entry task-process-${entry.kind}`}>
      <div className="task-process-marker" aria-hidden="true">{entry.kind === 'message' ? <span className="task-process-prompt">›</span> : entry.kind === 'tool_error' || entry.kind === 'stderr' ? <CircleAlert size={13} /> : entry.kind === 'tool_end' ? <Check size={13} /> : <Wrench size={13} />}</div>
      <div className="task-process-entry-surface"><div className="task-process-entry-head"><span>{entryLabel(entry.kind)}</span><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time></div><pre>{entry.text}</pre></div>
    </article>)}</div>
  </section>
}

function entriesFromArtifact(artifact: TaskArtifactView, content: string, toolNames: Map<string, string>): ProcessEntry[] {
  if (artifact.kind === 'runtime-stderr') return content.trim() ? [{ id: `${artifact.id}:stderr`, createdAt: artifact.createdAt, kind: 'stderr', text: content }] : []
  return content.split('\n').flatMap((line, index) => entryFromAcpLine(artifact, line, index, toolNames))
}

function entryFromAcpLine(artifact: TaskArtifactView, line: string, index: number, toolNames: Map<string, string>): ProcessEntry[] {
  if (!line.trim()) return []
  let value: unknown
  try { value = JSON.parse(line) } catch { return [] }
  if (!isRecord(value)) return []
  const cliEntry = entryFromCliEvent(artifact, value, index)
  if (cliEntry) return [cliEntry]
  if (value.method !== 'session/update' || !isRecord(value.params) || !isRecord(value.params.update)) return []
  const update = value.params.update
  const updateType = stringValue(update.sessionUpdate)
  const base = { id: `${artifact.id}:${index}`, createdAt: artifact.createdAt }
  if (updateType === 'agent_message_chunk') {
    const text = textFromContent(update.content)
    return text ? [{ ...base, kind: 'message', text }] : []
  }
  if (updateType === 'tool_call') {
    const label = stringValue(update.title) ?? stringValue(update.kind) ?? '调用工具'
    const toolCallId = stringValue(update.toolCallId)
    if (toolCallId) toolNames.set(toolCallId, label)
    return [{ ...base, kind: 'tool_start', text: label }]
  }
  if (updateType === 'tool_call_update' && isFinalToolStatus(stringValue(update.status))) {
    const toolCallId = stringValue(update.toolCallId)
    const label = stringValue(update.title) ?? stringValue(update.kind) ?? (toolCallId ? toolNames.get(toolCallId) : undefined) ?? '工具调用'
    return [{ ...base, kind: stringValue(update.status) === 'completed' ? 'tool_end' : 'tool_error', text: label }]
  }
  return []
}

function entryFromCliEvent(artifact: TaskArtifactView, value: Record<string, unknown>, index: number): ProcessEntry | undefined {
  const type = stringValue(value.type)
  if (!type) return undefined
  const part = isRecord(value.part) ? value.part : undefined
  const base = { id: `${artifact.id}:${index}`, createdAt: artifact.createdAt }

  if (type === 'step_start') return { ...base, kind: 'tool_start', text: '开始处理' }
  if (type === 'text' || type === 'message') {
    const text = stringValue(value.text) ?? stringValue(value.content) ?? stringValue(part?.text) ?? stringValue(part?.content)
    return text ? { ...base, kind: 'message', text } : undefined
  }
  if (type === 'error') {
    const text = stringValue(value.message) ?? stringValue(value.error) ?? stringValue(part?.error) ?? 'OpenCode 报告了错误。'
    return { ...base, kind: 'tool_error', text }
  }
  if (type !== 'tool_use') return undefined

  const state = isRecord(part?.state) ? part.state : undefined
  const toolName = stringValue(value.tool) ?? stringValue(part?.tool) ?? '调用工具'
  const input = isRecord(state?.input) ? state.input : undefined
  const command = stringValue(input?.command)
  const output = stringValue(state?.output)
  const label = command ? `${toolName} · ${command}` : toolName
  const status = stringValue(state?.status)
  if (status === 'completed') return { ...base, kind: 'tool_end', text: output ? `${label}\n${output}` : label }
  if (status === 'failed' || status === 'error') return { ...base, kind: 'tool_error', text: output ? `${label}\n${output}` : label }
  return { ...base, kind: 'tool_start', text: label }
}

function compactMessages(entries: ProcessEntry[]): ProcessEntry[] {
  return entries.reduce<ProcessEntry[]>((result, entry) => {
    const previous = result.at(-1)
    if (entry.kind === 'message' && previous?.kind === 'message') {
      previous.text += entry.text
      return result
    }
    result.push(entry)
    return result
  }, [])
}

function entryLabel(kind: ProcessEntry['kind']): string {
  if (kind === 'message') return 'Agent 回复'
  if (kind === 'tool_start') return '开始调用工具'
  if (kind === 'tool_end') return '工具完成'
  if (kind === 'tool_error') return '工具异常'
  return '运行输出'
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function textFromContent(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined
  if (content.type === 'text') return stringValue(content.text)
  if (content.type === 'content') return textFromContent(content.content)
  return undefined
}
function isFinalToolStatus(status: string | undefined): boolean { return status === 'completed' || status === 'failed' || status === 'cancelled' }
function formatTime(value: string): string { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) }
