import { FileCode2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { TaskArtifactView } from '../domain/workspace-view'

export function RuntimeEvidence({ artifacts, onReadArtifact }: { artifacts: TaskArtifactView[]; onReadArtifact(artifactId: string): Promise<string> }) {
  const [content, setContent] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const openArtifact = async (artifactId: string) => { setLoadingId(artifactId); try { setContent(await onReadArtifact(artifactId)) } finally { setLoadingId(null) } }
  return <section className="detail-section"><h3>证据</h3><p className="detail-hint">Commit、改动文件、测试结果和 diff 摘要保留在任务内，不刷进频道。</p>
    {artifacts.length === 0 ? <p className="context-empty">运行尚未留下证据</p> : <div className="evidence-list">{artifacts.map((artifact) => <button type="button" key={artifact.id} onClick={() => void openArtifact(artifact.id)}><FileCode2 size={15} /><span>{artifact.kind}</span>{loadingId === artifact.id && <LoaderCircle size={14} className="spin" />}</button>)}</div>}
    {content !== null && <pre className="artifact-content" aria-label="运行证据内容">{content}</pre>}
  </section>
}
