import React from 'react'
import { DocumentContent } from './DocumentContent'
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

/** W6（用户拍板 2026-09-18）：产物文件只读查看融入文档面板（右侧 dock 已撤）。
 *  快捷入口覆盖常见关键件；手输路径兑底任意产物文件；基础设施目录由主进程拒绝。
 *  审计 B-04（2026-10-04）：按品类切换——web 四件套对桌面项目全部打不开（项目里没有这些
 *  文件），桌面项目改列真实关键件（交付说明/启动声明/架构结论/工程契约）。 */
const WEB_QUICK_PRODUCT_FILES = ['index.html', 'server.js', 'package.json', 'src/app.js']
const DESKTOP_QUICK_PRODUCT_FILES = ['DELIVERY.md', 'LAUNCH.json', '00_ARCH/architecture.md', '00_SCAFFOLD/contract.json']

type SelectedView =
  | { kind: 'document'; document: DocumentRef; content: string }
  | { kind: 'file'; path: string; content: string; truncated?: boolean }
  | null

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
  const [selected, setSelected] = React.useState<SelectedView>(null)
  const [reading, setReading] = React.useState(false)
  const [filePath, setFilePath] = React.useState('')
  const [fileError, setFileError] = React.useState('')

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
        if (result.ok) setSelected({ kind: 'document', document: doc, content: result.data.content })
      })
      .finally(() => setReading(false))
  }

  /** 产物文件打开（W6）：主进程校验项目根内+拒基础设施目录/二进制，256KB 截断如实标注 */
  const handleOpenFile = (rawPath: string) => {
    const trimmed = rawPath.trim()
    if (!project || !trimmed) return
    const api = window.electronAPI
    if (!api?.project?.fileRead) {
      setFileError('当前环境不支持文件查看（preload 桥未就绪）。')
      return
    }
    setReading(true)
    setFileError('')
    void api.project
      .fileRead({ request_id: crypto.randomUUID(), project_id: project.project_id, path: trimmed })
      .then((result) => {
        if (result.ok) {
          setSelected({ kind: 'file', path: result.data.path, content: result.data.content, truncated: result.data.truncated })
        } else {
          setSelected(null)
          setFileError(result.error.user_visible_message || result.error.message)
        }
      })
      .catch((error: unknown) => {
        setFileError(error instanceof Error ? error.message : String(error))
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
            还没有文档。需求确认后这里会沉淀 PRD；随制作推进会补充交付与验收文档。
          </p>
        ) : (
          documents.map((doc) => {
            const active = selected?.kind === 'document' && selected.document.document_id === doc.document_id
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

      {/* 产物文件（W6：文件渲染融入文档面板——右侧 dock 已按用户拍板撤除） */}
      <div
        data-ai-id="document-panel-files"
        style={{
          flexShrink: 0, padding: 'var(--space-3)', borderBottom: '1px solid var(--color-border)',
          display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginRight: 'var(--space-1)' }}>产物文件：</span>
        {(project?.template_type === 'desktop_tool' ? DESKTOP_QUICK_PRODUCT_FILES : WEB_QUICK_PRODUCT_FILES).map((path) => (
          <button
            key={path}
            type="button"
            data-ai-id="document-panel-file-quick"
            onClick={() => handleOpenFile(path)}
            style={{
              fontSize: 'var(--font-size-xs)', padding: '2px var(--space-2)', cursor: 'pointer',
              color: selected?.kind === 'file' && selected.path === path ? 'var(--color-text)' : 'var(--color-text-muted)',
              background: selected?.kind === 'file' && selected.path === path ? 'var(--glass-bg-strong)' : 'transparent',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-full)', fontFamily: 'inherit',
            }}
          >
            {path}
          </button>
        ))}
        <span style={{ display: 'inline-flex', gap: 'var(--space-1)', marginLeft: 'auto' }}>
          <input
            value={filePath}
            placeholder="其他文件路径…"
            data-ai-id="document-panel-file-input"
            onChange={(event) => setFilePath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleOpenFile(filePath)
            }}
            style={{
              fontSize: 'var(--font-size-xs)', padding: '2px var(--space-2)', width: 120,
              color: 'var(--color-text)', background: 'transparent',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            data-ai-id="document-panel-file-open"
            onClick={() => handleOpenFile(filePath)}
            style={{
              fontSize: 'var(--font-size-xs)', padding: '2px var(--space-2)', cursor: 'pointer',
              color: 'var(--color-text)', background: 'transparent',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', fontFamily: 'inherit',
            }}
          >
            打开
          </button>
        </span>
        {fileError ? (
          <span data-ai-id="document-panel-file-error" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger, #e5484d)', width: '100%' }}>
            {fileError}
          </span>
        ) : null}
      </div>

      {/* 文档内容 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-4) var(--space-5)' }}>
        {reading ? (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>读取中…</p>
        ) : selected?.kind === 'file' ? (
          <div>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '0 0 var(--space-2)' }}>
              {selected.path}
              {selected.truncated ? '（超过 256KB，已截断）' : ''} · 只读
            </p>
            <div data-ai-id="document-file-content">
              <DocumentContent source={selected.path} content={selected.content} variant="docs" />
            </div>
          </div>
        ) : selected?.kind === 'document' ? (
          <div data-ai-id="document-content">
            <DocumentContent source={selected.document.path || selected.document.type} content={selected.content} variant="docs" />
          </div>
        ) : (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            从上方选择文档或产物文件查看内容。
          </p>
        )}
      </div>
    </div>
  )
}

export default DocumentPanel
