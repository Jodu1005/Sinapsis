import { RefreshCw, X } from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import type { AgentView } from '../domain/workspace-view'
import { useModalDialog } from './useModalDialog'

export function AgentConfigDialog({ agent, refreshingRuntime, onRefreshRuntime, onUpdateIdentity, onUpdateResponsibilities, onClose }: { agent: AgentView; refreshingRuntime: boolean; onRefreshRuntime(): Promise<void>; onUpdateIdentity(identity: string): Promise<void>; onUpdateResponsibilities(responsibilities: string[]): Promise<void>; onClose(): void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [identity, setIdentity] = useState(agent.identity)
  const [savingIdentity, setSavingIdentity] = useState(false)
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [responsibilities, setResponsibilities] = useState((agent.responsibilities ?? []).join('\n'))
  const [savingResponsibilities, setSavingResponsibilities] = useState(false)
  const [responsibilityError, setResponsibilityError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose, closeButtonRef)
  useEffect(() => {
    setIdentity(agent.identity)
    setResponsibilities((agent.responsibilities ?? []).join('\n'))
  }, [agent.id, agent.identity, agent.responsibilities])
  const refreshRuntime = async () => {
    setRefreshError(null)
    try {
      await onRefreshRuntime()
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : '无法重新检测 Agent Runtime。')
    }
  }
  const saveResponsibilities = async (event: FormEvent) => {
    event.preventDefault()
    setSavingResponsibilities(true)
    setResponsibilityError(null)
    try {
      await onUpdateResponsibilities(splitResponsibilities(responsibilities))
    } catch (cause) {
      setResponsibilityError(cause instanceof Error ? cause.message : '无法保存 Agent 职责。')
    } finally {
      setSavingResponsibilities(false)
    }
  }
  const saveIdentity = async (event: FormEvent) => {
    event.preventDefault()
    const nextIdentity = identity.trim()
    if (!nextIdentity || nextIdentity === agent.identity) return
    setSavingIdentity(true)
    setIdentityError(null)
    try {
      await onUpdateIdentity(nextIdentity)
    } catch (cause) {
      setIdentityError(cause instanceof Error ? cause.message : '无法保存 Agent 名称。')
    } finally {
      setSavingIdentity(false)
    }
  }
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-config-title"><header><div><p>Agent 配置</p><h2 id="agent-config-title">{agent.identity}</h2></div><div><button className="icon-button" type="button" aria-label="重新检测 Agent Runtime" data-tooltip="重新检测 Agent Runtime" onClick={() => void refreshRuntime()} disabled={refreshingRuntime}><RefreshCw size={18} /></button><button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭 Agent 配置" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></div></header>
    <dl><div><dt>Runtime</dt><dd>{runtimeLabel(agent.runtime)}</dd></div><div><dt>Runtime 可用性</dt><dd>{runtimeAvailability(agent.status)}</dd></div><div><dt>预设</dt><dd>{runtimePreset(agent.runtime)}</dd></div><div><dt>Command</dt><dd><code>{agent.command}</code></dd></div><div><dt>Model</dt><dd>{modelCopy(agent.runtime, agent.model)}</dd></div><div><dt>Args</dt><dd><code>{agent.args.join(' ') || '无'}</code></dd></div><div><dt>能力标签</dt><dd>{agent.capabilityTags.join(', ') || '未设置'}</dd></div><div><dt>环境变量</dt><dd>{agent.env.length ? agent.env.map((key) => `${key}（已配置）`).join(', ') : '未设置'}</dd></div></dl>
    <form className="agent-responsibility-form" onSubmit={saveIdentity}><label htmlFor="agent-identity">名称</label><input id="agent-identity" value={identity} onChange={(event) => setIdentity(event.target.value)} autoComplete="off" /><p>名称用于频道显示和 @ 提及；原有 @{agent.mentionName} 仍然可用。</p><button type="submit" className="primary-action" disabled={savingIdentity || !identity.trim() || identity.trim() === agent.identity}>{savingIdentity ? '正在保存...' : '保存名称'}</button></form>
    <form className="agent-responsibility-form" onSubmit={saveResponsibilities}><label htmlFor="agent-responsibilities">职责</label><textarea id="agent-responsibilities" value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} placeholder="前端界面与交互\n每行一项，也可用逗号分隔" /><p>未 @ 时，系统只会把消息交给职责匹配的空闲 Agent。</p><button type="submit" className="primary-action" disabled={savingResponsibilities}>{savingResponsibilities ? '正在保存...' : '保存职责'}</button></form>
    {(refreshError || identityError || responsibilityError) && <p className="form-error" role="alert">{refreshError ?? identityError ?? responsibilityError}</p>}
    {agent.status === 'busy' && <p className="assignment-note">任务运行中，Runtime 命令不可修改。</p>}
  </section></div>
}

function splitResponsibilities(value: string): string[] {
  return value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean)
}

function runtimeAvailability(status: AgentView['status']): string {
  return { offline: '未验证', idle: '可用', busy: '执行中', error: '异常' }[status]
}

function runtimePreset(runtime: AgentView['runtime']): string {
  return {
    opencode: 'OpenCode CLI 受管运行',
    'opencode-acp': 'OpenCode ACP 协议运行',
    pi: 'Pi RPC 受管运行',
    'claude-code': 'Claude Code CLI 受管运行',
  }[runtime]
}

function runtimeLabel(runtime: AgentView['runtime']): string {
  return {
    opencode: 'OpenCode CLI',
    'opencode-acp': 'OpenCode ACP',
    pi: 'Pi',
    'claude-code': 'Claude Code',
  }[runtime]
}

function modelCopy(runtime: AgentView['runtime'], model: string): string {
  if (model) return model
  return runtime === 'claude-code' ? '使用 Claude Code 默认值' : '使用 Runtime 默认值'
}
