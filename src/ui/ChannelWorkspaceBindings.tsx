import { Link2, Unlink, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { WorkspaceApi } from '../api/client'
import type { ChannelView, WorkspaceView } from '../domain/workspace-view'
import { EntityPickerDialog } from './EntityPickerDialog'
import { useModalDialog } from './useModalDialog'

export function ChannelWorkspaceBindings({ channel, workspaces, limit, api, onChanged }: {
  channel: ChannelView
  workspaces: WorkspaceView[]
  limit: number
  api: Pick<WorkspaceApi, 'bindChannelWorkspace' | 'unbindChannelWorkspace'>
  onChanged(): Promise<void>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [workspaceToUnbind, setWorkspaceToUnbind] = useState<WorkspaceView | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boundWorkspaces = useMemo(() => workspaces.filter((workspace) => channel.boundWorkspaceIds.includes(workspace.id)), [channel.boundWorkspaceIds, workspaces])
  const availableWorkspaces = useMemo(() => workspaces.filter((workspace) => !channel.boundWorkspaceIds.includes(workspace.id)), [channel.boundWorkspaceIds, workspaces])
  const atLimit = channel.boundWorkspaceIds.length >= limit

  const bind = async (workspaceId: string) => {
    if (saving) return
    setPickerOpen(false)
    setSaving(true)
    setError(null)
    try {
      await api.bindChannelWorkspace(channel.id, workspaceId)
      await onChanged()
      setPickerOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法绑定工作空间。')
    } finally {
      setSaving(false)
    }
  }
  const unbind = async () => {
    if (!workspaceToUnbind || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.unbindChannelWorkspace(channel.id, workspaceToUnbind.id)
      await onChanged()
      setWorkspaceToUnbind(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法解绑工作空间。')
    } finally {
      setSaving(false)
    }
  }

  return <section className="context-section channel-workspace-bindings"><div className="context-section-heading"><h2>频道工作空间 <span>{channel.boundWorkspaceIds.length}/{limit}</span></h2><button type="button" className="context-small-action" onClick={() => setPickerOpen(true)} disabled={saving || atLimit || availableWorkspaces.length === 0}><Link2 size={15} /> 添加工作空间</button></div>
    <ul className="channel-management-list">{boundWorkspaces.map((workspace) => <li key={workspace.id}><div><strong>{workspace.name}</strong><small>{workspace.repositories.length ? `${workspace.repositories.length} 个代码仓` : '没有代码仓'}</small></div><button type="button" className="icon-button management-remove" aria-label={`解绑 ${workspace.name}`} data-tooltip={`解绑 ${workspace.name}`} disabled={saving} onClick={() => { setError(null); setWorkspaceToUnbind(workspace) }}><Unlink size={16} /></button></li>)}</ul>
    {boundWorkspaces.length === 0 && <p className="context-empty">尚未绑定工作空间。</p>}
    {error && !workspaceToUnbind && <p className="form-error" role="alert">{error}</p>}
    {pickerOpen && <EntityPickerDialog title="添加工作空间" items={availableWorkspaces.map((workspace) => ({ id: workspace.id, label: workspace.name, description: workspace.repositories.map((repository) => repository.name).join(', ') || '没有代码仓' }))} onSelect={(workspaceId) => void bind(workspaceId)} onClose={() => setPickerOpen(false)} />}
    {workspaceToUnbind && <UnbindWorkspaceDialog workspace={workspaceToUnbind} saving={saving} error={error} onConfirm={unbind} onClose={() => setWorkspaceToUnbind(null)} />}
  </section>
}

function UnbindWorkspaceDialog({ workspace, saving, error, onConfirm, onClose }: { workspace: WorkspaceView; saving: boolean; error: string | null; onConfirm(): Promise<void>; onClose(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(onClose, cancelRef)
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="channel-unbind-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-unbind-title"><header><div><p>频道工作空间</p><h2 id="channel-unbind-title">解绑 {workspace.name}</h2></div><button type="button" className="icon-button" aria-label="关闭解绑工作空间" data-tooltip="关闭" onClick={onClose} disabled={saving}><X size={18} /></button></header>
    <div className="channel-unbind-copy"><p>这会解除频道与 {workspace.name} 的关联。</p><p>不会删除本地文件。</p></div>
    {error && <p className="form-error channel-unbind-error" role="alert">{error}</p>}
    <footer><button ref={cancelRef} type="button" className="secondary-action" disabled={saving} onClick={onClose}>取消</button><button type="button" className="danger-action" disabled={saving} onClick={() => void onConfirm()}><Unlink size={16} />{saving ? '正在解绑...' : '解绑工作空间'}</button></footer>
  </section></div>
}
