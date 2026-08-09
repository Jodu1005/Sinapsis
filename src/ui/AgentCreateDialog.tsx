import { X } from 'lucide-react'
import { FormEvent, useState } from 'react'
import type { CreateAgentRequest } from '../api/client'

export function AgentCreateDialog({ onCreate, onClose }: { onCreate(input: CreateAgentRequest): Promise<void>; onClose(): void }) {
  const [identity, setIdentity] = useState('')
  const [runtime, setRuntime] = useState<CreateAgentRequest['runtime']>('opencode')
  const [capabilityTags, setCapabilityTags] = useState('')
  const [responsibilities, setResponsibilities] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        identity: identity.trim(),
        mention: mentionFromIdentity(identity),
        runtime,
        capabilityTags: capabilityTags.split(',').map((tag) => tag.trim()).filter(Boolean),
        responsibilities: splitResponsibilities(responsibilities),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法添加 Agent。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="panel-scrim" role="presentation"><section className="agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-create-title"><header><div><p>新 Agent</p><h2 id="agent-create-title">添加 Agent</h2></div><button className="icon-button" type="button" aria-label="关闭添加 Agent" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <form className="agent-create-form" onSubmit={submit}>
      <label htmlFor="agent-identity">Agent 名称</label><input id="agent-identity" value={identity} onChange={(event) => setIdentity(event.target.value)} required />
      <label htmlFor="agent-runtime">Runtime</label><select id="agent-runtime" value={runtime} onChange={(event) => setRuntime(event.target.value as CreateAgentRequest['runtime'])}><option value="opencode">OpenCode CLI</option><option value="opencode-acp">OpenCode ACP</option><option value="pi">Pi</option><option value="claude-code">Claude Code</option></select>
      <label htmlFor="agent-capabilities">能力标签</label><input id="agent-capabilities" value={capabilityTags} onChange={(event) => setCapabilityTags(event.target.value)} placeholder="typescript, test" required />
      <label htmlFor="agent-responsibilities">职责</label><textarea id="agent-responsibilities" value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} placeholder="例如：前端界面与交互&#10;每行一项，也可用逗号分隔" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={saving || !mentionFromIdentity(identity) || !capabilityTags.trim()}>{saving ? '正在添加...' : '添加 Agent'}</button></footer>
    </form>
  </section></div>
}

function splitResponsibilities(value: string): string[] {
  return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean)
}

function mentionFromIdentity(identity: string): string {
  return identity.trim().toLocaleLowerCase().replace(/\s+/g, '-')
}
