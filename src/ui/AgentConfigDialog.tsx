import { RefreshCw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AgentView } from '../domain/workspace-view'
import { useModalDialog } from './useModalDialog'

export function AgentConfigDialog({ agent, refreshingRuntime, onRefreshRuntime, onClose }: { agent: AgentView; refreshingRuntime: boolean; onRefreshRuntime(): Promise<void>; onClose(): void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose, closeButtonRef)
  const refreshRuntime = async () => {
    setRefreshError(null)
    try {
      await onRefreshRuntime()
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : '无法重新检测 Agent Runtime。')
    }
  }
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-config-title"><header><div><p>Agent 配置</p><h2 id="agent-config-title">{agent.identity}</h2></div><div><button className="icon-button" type="button" aria-label="重新检测 Agent Runtime" data-tooltip="重新检测 Agent Runtime" onClick={() => void refreshRuntime()} disabled={refreshingRuntime}><RefreshCw size={18} /></button><button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭 Agent 配置" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></div></header>
    <dl><div><dt>Runtime</dt><dd>{runtimeLabel(agent.runtime)}</dd></div><div><dt>Runtime 可用性</dt><dd>{runtimeAvailability(agent.status)}</dd></div><div><dt>预设</dt><dd>{runtimePreset(agent.runtime)}</dd></div><div><dt>Command</dt><dd><code>{agent.command}</code></dd></div><div><dt>Model</dt><dd>{modelCopy(agent.runtime, agent.model)}</dd></div><div><dt>Args</dt><dd><code>{agent.args.join(' ') || '无'}</code></dd></div><div><dt>能力标签</dt><dd>{agent.capabilityTags.join(', ') || '未设置'}</dd></div><div><dt>环境变量</dt><dd>{agent.env.length ? agent.env.map((key) => `${key}（已配置）`).join(', ') : '未设置'}</dd></div></dl>
    {refreshError && <p className="form-error" role="alert">{refreshError}</p>}
    {agent.status === 'busy' && <p className="assignment-note">任务运行中，Runtime 命令不可修改。</p>}
  </section></div>
}

function runtimeAvailability(status: AgentView['status']): string {
  return { offline: '未验证', idle: '可用', busy: '执行中', error: '异常' }[status]
}

function runtimePreset(runtime: AgentView['runtime']): string {
  return {
    opencode: 'OpenCode 受管运行',
    pi: 'Pi RPC 受管运行',
    'claude-code': 'Claude Code CLI 受管运行',
  }[runtime]
}

function runtimeLabel(runtime: AgentView['runtime']): string {
  return {
    opencode: 'OpenCode',
    pi: 'Pi',
    'claude-code': 'Claude Code',
  }[runtime]
}

function modelCopy(runtime: AgentView['runtime'], model: string): string {
  if (model) return model
  return runtime === 'claude-code' ? '使用 Claude Code 默认值' : '使用 Runtime 默认值'
}
