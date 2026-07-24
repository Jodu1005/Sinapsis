import { FileCode2, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskArtifactView } from '../domain/workspace-view'

export function RuntimeEvidence({ artifacts, onReadArtifact }: { artifacts: TaskArtifactView[]; onReadArtifact(artifactId: string): Promise<string> }) {
  const [content, setContent] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [summary, setSummary] = useState<Record<string, string>>({})
  const reviewArtifacts = artifacts.filter((artifact) => artifact.kind in reviewEvidenceLabels)
  const rawArtifacts = artifacts.filter((artifact) => !(artifact.kind in reviewEvidenceLabels))
  useEffect(() => {
    let active = true
    void Promise.all(reviewArtifacts.map(async (artifact) => [artifact.id, await onReadArtifact(artifact.id)] as const)).then(
      (entries) => { if (active) setSummary(Object.fromEntries(entries)) },
      () => { if (active) setSummary({}) },
    )
    return () => { active = false }
  }, [artifacts, onReadArtifact])
  const openArtifact = async (artifactId: string) => { setLoadingId(artifactId); try { setContent(await onReadArtifact(artifactId)) } finally { setLoadingId(null) } }
  return <section className="detail-section"><h3>证据</h3><p className="detail-hint">Commit、改动文件、测试结果和 diff 摘要保留在任务内，不刷进频道。</p>
    {artifacts.length === 0 ? <p className="context-empty">运行尚未留下证据</p> : <>
      {reviewArtifacts.length > 0 && <dl className="review-evidence" aria-label="评审摘要">{reviewArtifacts.map((artifact) => <div key={artifact.id}><dt>{reviewEvidenceLabels[artifact.kind]}</dt><dd><pre>{summary[artifact.id] ?? '正在读取...'}</pre></dd></div>)}</dl>}
      {rawArtifacts.length > 0 && <section className="raw-evidence"><h4>原始运行日志</h4><div className="evidence-list">{rawArtifacts.map((artifact) => <button type="button" key={artifact.id} aria-label={artifact.kind} onClick={() => void openArtifact(artifact.id)}><FileCode2 size={15} /><span>{artifact.kind}</span>{loadingId === artifact.id && <LoaderCircle size={14} className="spin" />}</button>)}</div></section>}
    </>}
    {content !== null && <pre className="artifact-content" aria-label="运行证据内容">{content}</pre>}
  </section>
}

const reviewEvidenceLabels: Record<string, string> = {
  'review-commit': 'Commit',
  'review-changed-files': '改动文件',
  'review-test-output': '测试结果',
  'review-diff-summary': 'Diff 摘要',
}
