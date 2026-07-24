import { FolderPlus, Sparkles } from 'lucide-react'
import { FormEvent, useState } from 'react'
import type { WorkspaceApi } from '../api/client'

export function WorkspaceSetup({ api, onComplete }: { api: WorkspaceApi; onComplete(): Promise<void> }) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true); setError(null)
    try {
      const workspace = await api.createWorkspace({ name: name.trim() })
      if (directory.trim()) await api.addRepository(workspace.id, { directory: directory.trim() })
      await onComplete()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败，请重试。') } finally { setSaving(false) }
  }
  return <main className="workspace-setup"><section className="setup-content"><span className="setup-symbol"><Sparkles size={23} /></span><h1>创建工作空间</h1><p>先绑定一个代码仓，再让 Agent 在清晰的频道里协作。</p><form onSubmit={submit} className="setup-form">
    <label htmlFor="workspace-name">工作空间名称</label><input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Sinapsis" required />
    <label htmlFor="repository-directory">代码仓路径</label><div className="path-input"><FolderPlus size={18} /><input id="repository-directory" aria-label="代码仓路径" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/Users/you/Projects/app（可稍后添加）" /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="submit" className="primary-action" disabled={!name.trim() || saving}>{saving ? '正在创建...' : '创建工作空间'}</button>
  </form></section></main>
}
