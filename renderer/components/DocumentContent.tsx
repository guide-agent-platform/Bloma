import React from 'react'
import { Markdown } from './Markdown'

/**
 * DocumentContent — 全局内容渲染器（2026-10-04「能不能全局部署」拍板）。
 *
 * 背景：DocumentPanel/产物条此前把 PRD、md、json 一律塞 <pre> 裸文本——Markdown
 * 组件早就有（聊天气泡在用），但从未铺到查看面。本组件是唯一的分流入口：
 * - markdown（.md/.markdown 或 # 开头的文档）→ Markdown 渲染（docs 阅读态样式）
 * - json → 尝试美化（2 空格缩进）；解析失败原样展示
 * - code/text → 等宽 pre（沿用旧观感，仅统一容器）
 * variant：docs（文档面板/交付面板，阅读尺寸）｜compact（产物条内嵌，紧凑）。
 */
export type ContentKind = 'markdown' | 'json' | 'code'

const MD_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const JSON_EXTENSIONS = new Set(['json', 'jsonl', 'geojson'])
const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'cs', 'sh', 'bat', 'ps1', 'html', 'css', 'scss', 'yml', 'yaml', 'toml', 'ini', 'sql', 'xml', 'svg',
])

/** 按来源（文件路径/文档标识）与内容启发式分流。纯函数（可单测）。 */
export function classifyContent(source: string, content: string): ContentKind {
  const dot = source.lastIndexOf('.')
  const ext = dot >= 0 ? source.slice(dot + 1).toLowerCase() : ''
  if (MD_EXTENSIONS.has(ext)) return 'markdown'
  if (JSON_EXTENSIONS.has(ext)) return 'json'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  // 无扩展名（文档键如 prd / 无后缀文件）：markdown 启发式——标题行或列表/表格密度
  const head = content.slice(0, 2000)
  if (/^#{1,6}\s/m.test(head)) return 'markdown'
  if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) return 'json'
  return 'code'
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

export interface DocumentContentProps {
  /** 来源标识：文件相对路径或文档键（分流依据 + 展示） */
  source: string
  content: string
  variant?: 'docs' | 'compact'
}

export const DocumentContent: React.FC<DocumentContentProps> = ({ source, content, variant = 'docs' }) => {
  const kind = classifyContent(source, content)
  const mono = { margin: 0, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 'var(--font-size-xs)', lineHeight: 1.7, color: 'var(--color-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as const

  if (kind === 'markdown') {
    return (
      <div data-ai-id="document-markdown" className={variant === 'docs' ? 'bloma-md bloma-md-docs' : 'bloma-md'}>
        <Markdown text={content} />
      </div>
    )
  }
  if (kind === 'json') {
    return (
      <pre data-ai-id="document-json" style={{ ...mono, background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        {prettyJson(content)}
      </pre>
    )
  }
  return (
    <pre data-ai-id="document-plain" style={mono}>
      {content}
    </pre>
  )
}
