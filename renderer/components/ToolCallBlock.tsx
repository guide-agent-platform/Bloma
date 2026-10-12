import React from 'react'
import type { AgentEvent, MessageContentBlock } from '../../shared/types'
import { readToolFeedback, safeToolFeedback, toolFeedbackLabel, type ToolFeedback } from '../../shared/tool-feedback'

/**
 * ToolCallBlock — Agent Loop 工具调用的渲染端呈现（PR4，方案 §4.5）。
 *
 * 三个视图：
 * - ToolCallFeed：实时流（消费 tool_call_started/completed 事件），折叠行显示
 *   「工具名 + 输入摘要 + 状态 + 耗时」，点击展开截断输出。
 * - ToolCallRow：单行（上两者共用）。
 * - ToolBlocksReplay：历史回放（JSONL 落盘的 tool_use / tool_result block 转工具行
 *   胶囊，归入陷阱 26 前缀家族的「不污染纯文本流」设计）。
 * 2026-08-29 用户反馈：轮次号对零基础用户是噪音，行内与阶段指示一律隐藏「第 N 轮 ·」。
 */

/** 工具名 → 用户可读名（与主进程 TOOL_DISPLAY_NAMES 对齐，渲染端独立维护避免跨层依赖）。 */
export const TOOL_UI_LABELS: Record<string, string> = {
  read_file: '读取文件',
  inspect_project_resources: '检查运行资源',
  run_project_script: '执行项目脚本',
  install_packages: '准备依赖',
  run_project_driver: '执行业务检查',
  drive_project_app: '检查程序交互',
  list_files: '查看文件列表',
  grep: '搜索代码',
  write_file: '写入文件',
  edit_file: '修改文件',
  run_preview: '启动预览',
  run_gwt_tests: '运行功能测试',
  run_security_scan: '运行安全扫描',
  /** 联网与委派工具（agent-tools.ts 工具面，2026-09-08 补全供进度卡/过程块 P0 可读） */
  web_fetch: '读取网页资料',
  web_research: '联网调研资料',
  delegate_agent: '派出子助手处理',
  wait_for_delegations: '等待子助手完成',
  get_delegation_results: '获取子助手结果',
  stop_delegation: '停止子助手',
  stop_delegations: '停止子助手',
  ask_delegation_question: '向子助手提问',
  answer_delegation_question: '回复子助手提问',
  continue_delegation: '让子助手继续',
  /** 历史回放里无法经 tool_use_id 关联到工具名时的兜底标签 */
  tool_result: '工具结果',
}

export function toolLabel(name: string): string {
  return TOOL_UI_LABELS[name] ?? name
}

export type ToolCallStatus = 'running' | 'ok' | 'error' | 'budget'

const STATUS_DOT_COLOR: Record<ToolCallStatus, string> = {
  running: 'var(--color-warning)',
  ok: 'var(--color-quick)',
  error: 'var(--color-danger)',
  budget: 'var(--gray-400)',
}

const STATUS_TEXT: Record<ToolCallStatus, string> = {
  running: '进行中',
  ok: '完成',
  error: '出错',
  budget: '预算已满',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export interface ToolCallRowProps {
  tool: string
  inputSummary?: string
  outputSummary?: string
  status: ToolCallStatus
  durationMs?: number
  /** 历史回放行不展示耗时动画等实时细节 */
  replay?: boolean
  feedback?: ToolFeedback
}

export const ToolCallRow: React.FC<ToolCallRowProps> = ({ tool, inputSummary, outputSummary, status, durationMs, replay = false, feedback }) => {
  const [expanded, setExpanded] = React.useState(false)
  const summary = outputSummary ?? inputSummary ?? ''
  const hasDetail = summary.length > 0 && status !== 'running'

  return (
    <div
      data-ai-id="tool-call-row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: expanded ? 'var(--space-2)' : 0,
        padding: 'var(--space-2) var(--space-3)',
        background: 'var(--glass-bg-soft)',
        border: `1px solid ${status === 'error' ? 'var(--color-danger)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-muted)',
      }}
    >
      <div
        role={hasDetail ? 'button' : undefined}
        onClick={hasDetail ? () => setExpanded((previous) => !previous) : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          cursor: hasDetail ? 'pointer' : 'default',
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: STATUS_DOT_COLOR[status],
            display: 'inline-block',
            animation: !replay && status === 'running' ? 'pulse-stage 1.6s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ color: 'var(--color-text)', fontWeight: 500, flexShrink: 0 }}>
          {toolLabel(tool)}
        </span>
        {inputSummary && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {truncateText(inputSummary, 60)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', flexShrink: 0, color: status === 'error' ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
          {feedback ? toolFeedbackLabel(feedback) : STATUS_TEXT[status]}
          {durationMs !== undefined ? ` · ${formatDuration(durationMs)}` : ''}
        </span>
      </div>
      {expanded && hasDetail && (
        <pre
          data-ai-id="tool-call-output"
          style={{
            margin: 0,
            padding: 'var(--space-2)',
            background: 'var(--white)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-xs)',
            fontFamily: 'inherit',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 180,
            overflowY: 'auto',
            color: 'var(--color-text)',
          }}
        >
          {truncateText(summary, 500)}
        </pre>
      )}
    </div>
  )
}

interface ToolCallRecord {
  key: string
  tool: string
  turn: number
  inputSummary: string
  status: ToolCallStatus
  durationMs?: number
  outputSummary?: string
  feedback?: ToolFeedback
}

/** 从事件流推导工具调用记录：started 建行（running），completed 按 key 回填状态/耗时/输出。 */
export function deriveToolCallRecords(events: AgentEvent[]): ToolCallRecord[] {
  const records = new Map<string, ToolCallRecord>()
  for (const event of events) {
    if (event.type === 'tool_call_started') {
      const tool = String(event.payload.tool ?? '')
      const turn = Number(event.payload.turn ?? 0)
      const key = typeof event.payload.tool_call_id === 'string' ? `${turn}:${event.payload.tool_call_id}` : `${turn}:${tool}`
      // 同轮同名工具多次调用：后者覆盖前行（渲染端只保留最新；审计以 JSONL 为准）
      records.set(key, {
        key,
        tool,
        turn,
        inputSummary: String(event.payload.input_summary ?? ''),
        status: 'running',
      })
    }
    if (event.type === 'tool_call_completed') {
      const tool = String(event.payload.tool ?? '')
      const turn = Number(event.payload.turn ?? 0)
      const key = typeof event.payload.tool_call_id === 'string' ? `${turn}:${event.payload.tool_call_id}` : `${turn}:${tool}`
      const record = records.get(key)
      if (record) {
        record.status = event.payload.status === 'error' ? 'error' : event.payload.status === 'budget' ? 'budget' : 'ok'
        record.durationMs = typeof event.payload.duration_ms === 'number' ? event.payload.duration_ms : undefined
        record.outputSummary = typeof event.payload.output_summary === 'string' ? event.payload.output_summary : undefined
        record.feedback = safeToolFeedback(event.payload.feedback)
      }
    }
  }
  return [...records.values()]
}

export const ToolCallFeed: React.FC<{ events: AgentEvent[] }> = ({ events }) => {
  const records = React.useMemo(() => deriveToolCallRecords(events), [events])
  if (records.length === 0) return null
  return (
    <div data-ai-id="tool-call-feed" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: '84%' }}>
      {records.map((record) => (
        <ToolCallRow
          key={record.key}
          tool={record.tool}
          inputSummary={record.inputSummary}
          outputSummary={record.outputSummary}
          status={record.status}
          durationMs={record.durationMs}
          feedback={record.feedback}
        />
      ))}
    </div>
  )
}

/**
 * 历史回放：消息 content 里的 tool_use / tool_result block 渲染为工具行
 * （assistant 轮带 tool_use、user 轮带 tool_result——loop 落盘的轮次形态）。
 * tool_result 行的工具名经 toolNamesById（由 ChatPanel 从消息序列预构建的
 * tool_use_id → 工具名映射）回填；关联缺失时显示「工具结果」兜底。
 */
export const ToolBlocksReplay: React.FC<{ blocks: MessageContentBlock[]; toolNamesById?: Record<string, string> }> = ({ blocks, toolNamesById }) => {
  const rows = blocks.flatMap((block, index) => {
    if (block.type === 'tool_use') {
      return [{
        key: block.id ?? `${index}`,
        tool: block.name ?? '',
        summary: safeJsonPreview(block.input),
        status: 'ok' as ToolCallStatus,
        feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', scope: 'call_declared' } as ToolFeedback,
      }]
    }
    if (block.type === 'tool_result') {
      return [{
        key: block.tool_use_id ?? `${index}`,
        tool: toolNamesById?.[block.tool_use_id ?? ''] ?? 'tool_result',
        summary: typeof block.content === 'string' ? block.content : '',
        status: (block.is_error ? 'error' : 'ok') as ToolCallStatus,
        feedback: typeof block.content === 'string' ? readToolFeedback(block.content) : undefined,
      }]
    }
    return []
  })
  if (rows.length === 0) return null
  return (
    <div data-ai-id="tool-call-replay" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {rows.map((row) => (
        <ToolCallRow key={row.key} tool={row.tool} inputSummary={row.summary} status={row.status} feedback={'feedback' in row ? safeToolFeedback(row.feedback) : undefined} replay />
      ))}
    </div>
  )
}

export function safeJsonPreview(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
