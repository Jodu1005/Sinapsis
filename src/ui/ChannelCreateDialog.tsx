import { X } from 'lucide-react'
import { FormEvent, useRef, useState } from 'react'
import { useModalDialog } from './useModalDialog'

export function ChannelCreateDialog({ onCreate, onClose }: { onCreate(input: { name: string }): Promise<void>; onClose(): void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useModalDialog(onClose, nameRef)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      await onCreate({ name: name.trim() })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建频道。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="channel-create-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-create-title"><header><div><p>当前工作空间</p><h2 id="channel-create-title">添加频道</h2></div><button className="icon-button" type="button" aria-label="关闭添加频道" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <form onSubmit={submit}>
      <label htmlFor="channel-create-name">频道名称</label><input ref={nameRef} id="channel-create-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="release" required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-action" onClick={onClose}>取消</button><button type="submit" className="primary-action" disabled={saving || !name.trim()}>{saving ? '正在创建...' : '创建频道'}</button></footer>
    </form>
  </section></div>
}
