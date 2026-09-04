import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { currentProjectAtom, documentPanelExpandedAtom } from './atoms'
import type { DocumentRef } from '../../shared/types'

const TYPE_LABEL_MAP: Record<DocumentRef['type'], string> = {
  prd: 'PRD',
  user_story: '用户故事',
  plantuml: 'PlantUML',
  gwt_feature: 'GWT 场景',
  test_report: '测试报告',
  changelog: '变更记录',
  decisions: '决策日志',
  plan: '技术合同',
  loop_log: 'Loop 过程记录',
}

/** 从绝对路径取文件名（跨平台） */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * 文档面板（U2）——长期模式顶部「文档」按钮展开的抽屉。
 * 列出项目已产出的 PRD / GWT / 测试报告等文档，点击读取内容展示。
 * 展开态由 `documentPanelExpandedAtom` 控制（WorkspaceHeader 切换），
 * 未展开时渲染 null，可直接挂在 WorkspaceShell 中自门控。
 */
export const DocumentPanel: React.FC = () => {
  const [expanded, setExpanded] = useAtom(documentPanelExpandedAtom)
  const project = useAtomValue(currentProjectAtom)
  const [documents, setDocuments] = React.useState<DocumentRef[]>([])
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<{ document: DocumentRef; content: string } | null>(null)
  const [reading, setReading] = React.useState(false)

  React.useEffect(() => {
    if (!expanded || !project) return
    const api = window.electronAPI
    if (!api?.documents?.list) return
    setLoading(true)
    setSelected(null)
    void api.documents
      .list({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) setDocuments(result.data.documents)
      })
      .finally(() => setLoading(false))
  }, [expanded, project?.project_id])

  if (!expanded) return null

  const handleSelect = (doc: DocumentRef) => {
    if (!project) return
    const api = window.electronAPI
    if (!api?.documents?.read) return
    setReading(true)
    void api.documents
      .read({ request_id: crypto.randomUUID(), project_id: project.project_id, document_id: doc.document_id })
      .then((result) => {
        if (result.ok) setSelected(result.data)
      })
      .finally(() => setReading(false))
  }

  return (
    <div
      data-ai-id="document-panel"
      role="complementary"
      aria-label="项目文档"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 900,
        width: 'min(420px, 92vw)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--color-surface)',
        borderLeft: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-lg)',
        animation: 'tile-enter 0.2s ease both',
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
            项目文档
          </h2>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project?.name ?? '未命名项目'}
          </p>
        </div>
        <button
          onClick={() => setExpanded(false)}
          aria-label="关闭文档面板"
          data-ai-id="document-panel-close"
          style={{
            fontSize: 'var(--font-size-lg)', lineHeight: 1, color: 'var(--color-text-muted)',
            padding: 'var(--space-2)', cursor: 'pointer', background: 'transparent',
            border: 'none', fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      </div>

      {/* 文档列表 */}
      <div style={{ flexShrink: 0, padding: 'var(--space-3)', borderBottom: '1px solid var(--color-border)', overflowY: 'auto', maxHeight: '40%' }}>
        {loading ? (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', padding: 'var(--space-4) var(--space-2)' }}>
            加载中…
          </p>
        ) : documents.length === 0 ? (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', padding: 'var(--space-4) var(--space-2)', lineHeight: 1.6 }}>
            还没有文档。确认草图、生成 MVP 或进入测试后，这里会自动沉淀 PRD、GWT 场景与测试报告。
          </p>
        ) : (
          documents.map((doc) => {
            const active = selected?.document.document_id === doc.document_id
            return (
              <button
                key={doc.document_id}
                data-ai-id="document-list-item"
                onClick={() => handleSelect(doc)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  width: '100%', textAlign: 'left', padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  background: active ? 'var(--glass-bg-strong)' : 'transparent',
                  border: 'none', fontFamily: 'inherit', marginBottom: 2,
                }}
              >
                <span
                  style={{
                    flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--color-quick)',
                    padding: '2px var(--space-2)', borderRadius: 'var(--radius-full)',
                    background: 'var(--color-quick-soft)', whiteSpace: 'nowrap',
                  }}
                >
                  {TYPE_LABEL_MAP[doc.type] ?? doc.type}
                </span>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {basename(doc.path)}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* 文档内容 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-4) var(--space-5)' }}>
        {reading ? (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>读取中…</p>
        ) : selected ? (
          <pre
            data-ai-id="document-content"
            style={{
              margin: 0, fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 'var(--font-size-xs)', lineHeight: 1.7, color: 'var(--color-text)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {selected.content}
          </pre>
        ) : (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            从左侧选择一份文档查看内容。
          </p>
        )}
      </div>
    </div>
  )
}

export default DocumentPanel
