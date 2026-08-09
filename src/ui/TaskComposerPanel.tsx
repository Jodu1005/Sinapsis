import { Bot, FilePenLine, FolderOpen, Tags, X } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CreateTaskRequest } from '../api/client'
import { distinctAgentsByIdentity, type AgentView, type ChannelView, type TaskView, type WorkspaceView } from '../domain/workspace-view'
import { useModalDialog } from './useModalDialog'

export interface TaskComposerInput extends Omit<CreateTaskRequest, 'workspaceId'> {
  workspaceId?: string
  directory?: string
}

export function TaskComposerPanel({ workspaces, channels, agents, initialChannelId, initialWorkspaceId, initialTitle = '', initialDirectAgentId = '', onBrowseDirectory, onCreate, onClose }: {
  workspaces: WorkspaceView[]
  channels: ChannelView[]
  agents: AgentView[]
  initialChannelId?: string
  initialWorkspaceId?: string
  initialTitle?: string
  initialDirectAgentId?: string
  onBrowseDirectory(): Promise<string | null>
  onCreate(input: TaskComposerInput, channelId: string): Promise<TaskView>
  onClose(): void
}) {
  const availableChannels = useMemo(() => channels.filter((channel) => !channel.archivedAt), [channels])
  const [channelId, setChannelId] = useState(() => initialChannelId && availableChannels.some((channel) => channel.id === initialChannelId)
    ? initialChannelId
    : availableChannels[0]?.id ?? '')
  const [workspaceId, setWorkspaceId] = useState(() => {
    if (initialWorkspaceId && workspaces.some((workspace) => workspace.id === initialWorkspaceId)) return initialWorkspaceId
    return ''
  })
  const [directory, setDirectory] = useState('')
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('')
  const [labels, setLabels] = useState('')
  const [directAgentId, setDirectAgentId] = useState(initialDirectAgentId)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [browsingDirectory, setBrowsingDirectory] = useState(false)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useModalDialog(onClose, descriptionRef)
  const channel = useMemo(() => availableChannels.find((candidate) => candidate.id === channelId), [availableChannels, channelId])
  const workspace = useMemo(() => workspaces.find((candidate) => candidate.id === workspaceId), [workspaces, workspaceId])
  const repository = workspace?.repositories[0]
  const workingDirectory = directory || repository?.path || ''
  const channelAgents = useMemo(() => channel ? agents.filter((agent) => channel.memberAgentIds.includes(agent.id)) : [], [agents, channel])
  const directAgent = useMemo(() => channelAgents.find((agent) => agent.id === directAgentId), [channelAgents, directAgentId])

  useEffect(() => {
    if (!channel || workspaceId || directory) return
    const defaultWorkspace = workspaces.find((candidate) => channel.boundWorkspaceIds.includes(candidate.id))
    if (defaultWorkspace) setWorkspaceId(defaultWorkspace.id)
  }, [channel, directory, workspaceId, workspaces])
  useEffect(() => {
    if (directAgentId && !channelAgents.some((agent) => agent.id === directAgentId)) setDirectAgentId('')
  }, [channelAgents, directAgentId])

  const browseDirectory = async () => {
    setBrowsingDirectory(true)
    setError(null)
    try {
      const pickedDirectory = await onBrowseDirectory()
      if (!pickedDirectory) return
      const existingWorkspace = workspaces.find((candidate) => candidate.repositories.some((candidateRepository) => candidateRepository.path === pickedDirectory))
      setWorkspaceId(existingWorkspace?.id ?? '')
      setDirectory(existingWorkspace ? '' : pickedDirectory)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开电脑目录。')
    } finally {
      setBrowsingDirectory(false)
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!channel || !workingDirectory) return
    setSaving(true); setError(null)
    try {
      await onCreate({ workspaceId: workspace?.id, directory: workspace ? undefined : workingDirectory, ...(title.trim() ? { title: title.trim() } : {}), description: description.trim(), ...(acceptanceCriteria.trim() ? { acceptanceCriteria: acceptanceCriteria.trim() } : {}), labels: labels.split(',').map((label) => label.trim()).filter(Boolean), ...(directAgentId ? { directAgentId } : {}) }, channel.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建任务。') } finally { setSaving(false) }
  }
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="task-composer-panel" role="dialog" aria-modal="true" aria-labelledby="task-composer-title"><header><div><p>新任务</p><h2 id="task-composer-title"><span className="sr-only">把工作交给队列</span><span aria-hidden="true">写下要推进的工作</span></h2></div><button className="icon-button" type="button" aria-label="关闭新任务面板" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <form className="task-composer-form" onSubmit={submit}>
      <section className="task-composer-document" aria-label="任务内容">
        <div className="task-optional-title"><label htmlFor="task-title">标题（选填）</label><input className="task-composer-title" id="task-title" aria-label="任务标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="留空时从正文提取" /></div>
        <div className="task-document-section">
          <label htmlFor="task-description">任务内容</label><textarea ref={descriptionRef} id="task-description" aria-label="详细描述" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="从这里开始写下背景、目标和想法。" rows={9} required />
        </div>
        <div className="task-document-section task-acceptance-section">
          <label htmlFor="task-acceptance">完成定义（选填）</label><textarea id="task-acceptance" aria-label="验收标准" value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="完成时应该具备什么结果？如何确认？" rows={4} />
        </div>
      </section>
      <aside className="task-composer-meta" aria-label="任务设置">
        <div className="task-composer-meta-heading"><FilePenLine size={16} /><span>任务设置</span></div>
        <div className="task-composer-meta-field"><label htmlFor="task-channel">频道</label><select id="task-channel" aria-label="频道" value={channelId} onChange={(event) => setChannelId(event.target.value)} required><option value="" disabled>选择频道</option>{availableChannels.map((candidate) => <option value={candidate.id} key={candidate.id}>#{candidate.name}</option>)}</select></div>
        <div className="task-composer-meta-field"><label htmlFor="task-repository">工作目录</label><div className="path-input task-directory-picker"><FolderOpen size={16} /><input id="task-repository" aria-label="工作目录" value={workingDirectory} disabled /><button type="button" className="icon-button task-browse-directory" aria-label="浏览电脑目录" data-tooltip="浏览电脑目录" onClick={() => void browseDirectory()} disabled={browsingDirectory}><FolderOpen size={16} /></button></div>{workspace && <p className="assignment-note">使用已有工作空间：{workspace.name}</p>}{directory && <p className="assignment-note">将以此目录创建工作空间：{workspaceNameFromDirectory(directory)}</p>}</div>
        <div className="task-composer-meta-field"><label htmlFor="task-agent"><Bot size={14} /> 指定 Agent</label><select id="task-agent" aria-label="指定 Agent" value={directAgentId} onChange={(event) => setDirectAgentId(event.target.value)}><option value="">让空闲的匹配 Agent 领取</option>{distinctAgentsByIdentity(channelAgents).map((agent) => <option value={agent.id} key={agent.id}>@{agent.identity} · {agent.runtime}</option>)}</select>{directAgent && <p className="assignment-note">@{directAgent.identity} 将直接领取此任务</p>}</div>
        <div className="task-composer-meta-field"><label htmlFor="task-labels"><Tags size={14} /> 标签</label><input id="task-labels" aria-label="标签" value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="frontend, test" /></div>
      </aside>
      <footer>{error && <p className="form-error" role="alert">{error}</p>}<div><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={saving || !channel || !workingDirectory || !description.trim()}>{saving ? '正在创建...' : '创建任务'}</button></div></footer>
    </form>
  </section></div>
}

function workspaceNameFromDirectory(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1) ?? '本地工作空间'
}
