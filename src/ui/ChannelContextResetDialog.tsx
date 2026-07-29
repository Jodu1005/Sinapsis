import { Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useModalDialog } from './useModalDialog'

export function ChannelContextResetDialog({ channelName, onConfirm, onClose }: {
  channelName: string
  onConfirm(): Promise<void>
  onClose(): void
}) {
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(onClose, cancelRef)

  const confirm = async () => {
    if (resetting) return
    setResetting(true)
    setError(null)
    try {
      await onConfirm()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法清空频道上下文。')
    } finally {
      setResetting(false)
    }
  }

  return <div className="panel-scrim" role="presentation"><section ref={dialogRef} className="channel-context-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-context-reset-title"><header><div><p>频道 #{channelName}</p><h2 id="channel-context-reset-title">清空 {channelName} 上下文</h2></div><button className="icon-button" type="button" aria-label="关闭清空上下文" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></header>
    <div className="channel-context-reset-copy"><p>这会停止该频道正在运行的对话与未完成任务，并从当前频道隐藏此前的消息、Thread 和任务。</p><p>本机的 Git worktree、证据文件和产物会继续保留。</p></div>
    {error && <p className="form-error channel-context-reset-error" role="alert">{error}</p>}
    <footer><button ref={cancelRef} type="button" className="secondary-action" disabled={resetting} onClick={onClose}>取消</button><button type="button" className="danger-action" disabled={resetting} onClick={confirm}><Trash2 size={16} />{resetting ? '正在清空...' : '清空上下文'}</button></footer>
  </section></div>
}
