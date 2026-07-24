import { X } from 'lucide-react'
import { FormEvent, useMemo, useState } from 'react'
import type { CreateTaskRequest } from '../api/client'
import type { AgentView, RepositoryView, TaskView } from '../domain/workspace-view'

export function TaskComposerPanel({ repository, agents, onCreate, onClose }: { repository: RepositoryView; agents: AgentView[]; onCreate(input: CreateTaskRequest): Promise<TaskView>; onClose(): void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('')
  const [labels, setLabels] = useState('')
  const [directAgentId, setDirectAgentId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const directAgent = useMemo(() => agents.find((agent) => agent.id === directAgentId), [agents, directAgentId])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null)
    try {
      await onCreate({ title: title.trim(), description: description.trim(), acceptanceCriteria: acceptanceCriteria.trim(), labels: labels.split(',').map((label) => label.trim()).filter(Boolean), ...(directAgentId ? { directAgentId } : {}) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建任务。') } finally { setSaving(false) }
  }
  return <div className="panel-scrim" role="presentation"><section className="task-composer-panel" role="dialog" aria-modal="true" aria-labelledby="task-composer-title"><header><div><p>新任务</p><h2 id="task-composer-title">把工作交给队列</h2></div><button className="icon-button" type="button" aria-label="关闭新任务面板" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <form onSubmit={submit}>
      <label htmlFor="task-repository">当前代码仓</label><input id="task-repository" value={repository.name} disabled />
      <label htmlFor="task-title">任务标题</label><input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      <label htmlFor="task-description">详细描述</label><textarea id="task-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} required />
      <label htmlFor="task-acceptance">验收标准</label><textarea id="task-acceptance" value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} rows={3} required />
      <label htmlFor="task-labels">标签</label><input id="task-labels" aria-label="标签" value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="frontend, test" />
      <label htmlFor="task-agent">指定 Agent</label><select id="task-agent" aria-label="指定 Agent" value={directAgentId} onChange={(event) => setDirectAgentId(event.target.value)}><option value="">让空闲的匹配 Agent 领取</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>@{agent.mentionName} · {agent.identity}</option>)}</select>
      {directAgent && <p className="assignment-note">@{directAgent.mentionName} 将直接领取此任务</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={saving || !title.trim() || !description.trim() || !acceptanceCriteria.trim()}>{saving ? '正在创建...' : '创建任务'}</button></footer>
    </form>
  </section></div>
}
