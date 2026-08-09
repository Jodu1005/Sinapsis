import { FileText, FolderOpen, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TaskOutputFileView } from '../domain/workspace-view'

export function TaskOutputFiles({
  taskId,
  onListFiles,
  onReadFile,
}: {
  taskId: string
  onListFiles(taskId: string): Promise<TaskOutputFileView[]>
  onReadFile(taskId: string, filePath: string): Promise<string>
}) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<TaskOutputFileView[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOpen(false)
    setFiles(null)
    setSelectedPath(null)
    setContent(null)
    setError(null)
  }, [taskId])

  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (files !== null || loadingFiles) return
    setLoadingFiles(true)
    setError(null)
    try {
      setFiles(await onListFiles(taskId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本次任务的输出文件。')
    } finally {
      setLoadingFiles(false)
    }
  }

  const openFile = async (filePath: string) => {
    if (loadingPath === filePath) return
    setSelectedPath(filePath)
    setContent(null)
    setLoadingPath(filePath)
    setError(null)
    try {
      setContent(await onReadFile(taskId, filePath))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取这个输出文件。')
    } finally {
      setLoadingPath(null)
    }
  }

  return <section className="task-output-files" aria-label="本次任务文件">
    <button type="button" className="task-output-files-trigger" aria-expanded={open} onClick={() => void toggle()}><FolderOpen size={16} />文件{files ? <span>{files.length}</span> : null}</button>
    {open && <div className="task-output-files-browser">
      <div className="task-output-files-heading"><div><strong>本次任务文件</strong><span>来自任务工作树中的新增和改动文件</span></div><button type="button" className="icon-button" aria-label="收起任务文件" data-tooltip="收起" onClick={() => setOpen(false)}><X size={15} /></button></div>
      {loadingFiles ? <p className="task-output-files-state"><LoaderCircle size={15} className="spin" />正在读取文件...</p> : error && !selectedPath ? <p className="form-error" role="alert">{error}</p> : files?.length === 0 ? <p className="task-output-files-state">本次任务没有可查看的文件</p> : files && <div className="task-output-files-content">
        <div className="task-output-file-list" role="list" aria-label="输出文件列表">{files.map((file) => <button type="button" key={file.path} aria-label={`查看 ${file.path}`} className={selectedPath === file.path ? 'selected' : ''} onClick={() => void openFile(file.path)}><FileText size={15} /><span>{file.path}</span><small>{fileStatusLabel(file.status)}</small></button>)}</div>
        <div className="task-output-file-preview" aria-live="polite">{selectedPath ? <><div className="task-output-file-preview-heading"><code>{selectedPath}</code>{loadingPath === selectedPath && <LoaderCircle size={15} className="spin" />}</div>{error ? <p className="form-error" role="alert">{error}</p> : content !== null && <FileContent path={selectedPath} content={content} />}</> : <p>选择一个文件查看内容</p>}</div>
      </div>}
    </div>}
  </section>
}

function FileContent({ path, content }: { path: string; content: string }) {
  return isMarkdown(path)
    ? <div className="task-output-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
    : <pre>{content}</pre>
}

function isMarkdown(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath)
}

function fileStatusLabel(status: TaskOutputFileView['status']): string {
  return { added: '新增', modified: '修改', renamed: '重命名' }[status]
}
