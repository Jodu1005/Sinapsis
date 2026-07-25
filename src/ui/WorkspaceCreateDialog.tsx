import { FolderPlus, X } from 'lucide-react'
import { FormEvent, useRef, useState } from 'react'
import { useModalDialog } from './useModalDialog'

export function WorkspaceCreateDialog({ onCreate, onClose }: { onCreate(input: { name: string; directory: string }): Promise<void>; onClose(): void }) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useModalDialog(onClose, nameRef)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onCreate({ name: name.trim(), directory: directory.trim() })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法添加工作空间。')
    } finally {
      setSaving(false)
    }
  }
  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title"><header><div><p>工作空间</p><h2 id="workspace-create-title">添加本地工作目录</h2></div><button className="icon-button" type="button" aria-label="关闭工作空间面板" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header><form onSubmit={submit}>
    <label htmlFor="workspace-create-name">工作空间名称</label><input ref={nameRef} id="workspace-create-name" value={name} onChange={(event) => setName(event.target.value)} required />
    <label htmlFor="workspace-create-directory">工作目录</label><div className="path-input"><FolderPlus size={18} /><input id="workspace-create-directory" aria-label="工作目录" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/Users/you/Projects/app" required /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={saving || !name.trim() || !directory.trim()}>{saving ? '正在添加...' : '添加工作空间'}</button></footer>
  </form></section></div>
}
