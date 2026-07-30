import { UserMinus, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { WorkspaceApi } from '../api/client'
import { agentStatusLabel, type AgentView, type ChannelView } from '../domain/workspace-view'
import { getChannelCapabilities } from '../../shared/channel-policy'
import { EntityPickerDialog } from './EntityPickerDialog'

export function ChannelAgentMembers({ channel, agents, api, onChanged }: {
  channel: ChannelView
  agents: AgentView[]
  api: Pick<WorkspaceApi, 'addChannelAgent' | 'removeChannelAgent'>
  onChanged(): Promise<void>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capabilities = getChannelCapabilities(channel.systemKey)
  const members = useMemo(() => capabilities.automaticAllAgents ? agents : agents.filter((agent) => channel.memberAgentIds.includes(agent.id)), [agents, capabilities.automaticAllAgents, channel.memberAgentIds])
  const availableAgents = useMemo(() => agents.filter((agent) => !channel.memberAgentIds.includes(agent.id)), [agents, channel.memberAgentIds])

  const changeMembership = async (agentId: string, action: 'add' | 'remove') => {
    if (saving) return
    if (action === 'add') setPickerOpen(false)
    setSaving(true)
    setError(null)
    try {
      if (action === 'add') await api.addChannelAgent(channel.id, agentId)
      else await api.removeChannelAgent(channel.id, agentId)
      await onChanged()
      setPickerOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === 'add' ? '无法添加 Agent。' : '无法移除 Agent。')
    } finally {
      setSaving(false)
    }
  }

  return <section className="context-section channel-agent-members"><div className="context-section-heading"><h2>频道 Agent</h2>{capabilities.mutableMembership && <button type="button" className="context-small-action" onClick={() => setPickerOpen(true)} disabled={saving || availableAgents.length === 0}><UserPlus size={15} /> 添加 Agent</button>}</div>
    {capabilities.automaticAllAgents && <p className="channel-management-note">自动同步所有 Agent</p>}
    <ul className="channel-management-list">{members.map((agent) => <li key={agent.id}><div><strong>{agent.identity}</strong><small>{agentStatusLabel(agent.status)} · Runtime: {runtimeLabel(agent.runtime)}</small></div>{capabilities.mutableMembership && <button type="button" className="icon-button management-remove" aria-label={`移除 ${agent.identity}`} data-tooltip={`移除 ${agent.identity}`} disabled={saving} onClick={() => void changeMembership(agent.id, 'remove')}><UserMinus size={16} /></button>}</li>)}</ul>
    {members.length === 0 && <p className="context-empty">尚未添加 Agent。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {pickerOpen && <EntityPickerDialog title="添加 Agent" items={availableAgents.map((agent) => ({ id: agent.id, label: agent.identity, description: `${agentStatusLabel(agent.status)} · ${runtimeLabel(agent.runtime)}` }))} onSelect={(agentId) => void changeMembership(agentId, 'add')} onClose={() => setPickerOpen(false)} />}
  </section>
}

function runtimeLabel(runtime: AgentView['runtime']): string {
  return { opencode: 'OpenCode', pi: 'Pi', 'claude-code': 'Claude Code' }[runtime]
}
