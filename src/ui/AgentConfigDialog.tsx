import { X } from 'lucide-react'
import { useRef } from 'react'
import type { AgentView } from '../domain/workspace-view'
import { useModalDialog } from './useModalDialog'

export function AgentConfigDialog({ agent, onClose }: { agent: AgentView; onClose(): void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(onClose, closeButtonRef)
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-config-title"><header><div><p>Agent 配置</p><h2 id="agent-config-title">{agent.identity}</h2></div><button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭 Agent 配置" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <dl><div><dt>Runtime</dt><dd>{agent.runtime}</dd></div><div><dt>Runtime 可用性</dt><dd>{runtimeAvailability(agent.status)}</dd></div><div><dt>预设</dt><dd>{runtimePreset(agent.runtime)}</dd></div><div><dt>Command</dt><dd><code>{agent.command}</code></dd></div><div><dt>Model</dt><dd>{agent.model || '使用 Runtime 默认值'}</dd></div><div><dt>Args</dt><dd><code>{agent.args.join(' ') || '无'}</code></dd></div><div><dt>能力标签</dt><dd>{agent.capabilityTags.join(', ') || '未设置'}</dd></div><div><dt>环境变量</dt><dd>{agent.env.length ? agent.env.map((key) => `${key}（已配置）`).join(', ') : '未设置'}</dd></div></dl>
    {agent.status === 'busy' && <p className="assignment-note">任务运行中，Runtime 命令不可修改。</p>}
  </section></div>
}

function runtimeAvailability(status: AgentView['status']): string {
  return { offline: '未验证', idle: '可用', busy: '执行中', error: '异常' }[status]
}

function runtimePreset(runtime: AgentView['runtime']): string {
  return runtime === 'opencode' ? 'OpenCode 受管运行' : 'Pi RPC 受管运行'
}
