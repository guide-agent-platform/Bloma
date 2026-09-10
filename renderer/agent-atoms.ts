/**
 * Agent Atoms — Jotai 状态管理
 *
 * 管理 Agent 会话 + 平台项目 + UI 交互的完整状态。
 * 这是 IPC 四层架构的 Layer 4。
 *
 * === 关键设计 ===
 *
 * 1. atomFamily 按 sessionId 隔离
 *    每个 Agent 会话有独立的 streamState atom。
 *    会话 A 的流式输出不会覆盖会话 B 的状态。
 *
 * 2. setupGlobalAgentListeners() 在 main.tsx 中调用一次，永不卸载
 *    使用 window.__jotai_store__ 直接操作 atoms，
 *    不依赖 React 组件生命周期。
 *
 * 3. 权限请求按 sessionId 入队
 *    支持多个 Agent 会话并行运行时各自的权限请求互不干扰。
 *
 * === 对齐说明 ===
 *
 * 核心结构对齐 A 的 Bloma project (E:\Psr\develop\sprint0\Bloma\renderer\agent-atoms.ts)
 * 新增平台扩展区（项目状态、UI 状态、点选纠错等）以满足 Sprint 1-3 需求。
 */

import { atom, type Atom, type WritableAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  AgentSessionRecord,
  ElectronAPI,
  PermissionRequest,
  Project,
  ProjectMode,
  ResearchIdea,
  Snapshot,
  SteerImpact,
  SteerStatus,
  WorkflowStage,
} from '../shared/types'

// =========================================================================
// 0. 全局类型声明
// =========================================================================

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    __jotai_store__?: {
      get: <Value>(atom: Atom<Value>) => Value
      set: <Value, Args extends unknown[], Result>(
        atom: WritableAtom<Value, Args, Result>,
        ...args: Args
      ) => Result
    }
  }
}

// =========================================================================
// 1. Agent 会话（对齐 A）
// =========================================================================

export const agentSessionsAtom = atom<AgentSessionMeta[]>([])

export const activeAgentSessionIdAtom = atom<string | null>(null)

// =========================================================================
// 2. 流式状态（atomFamily 按 sessionId 隔离）— 对齐 A
// =========================================================================

export interface AgentStreamState {
  running: boolean
  /** 完整事件历史 */
  events: AgentEvent[]
  /** 累积文本 */
  content: string
  /** 最近错误 */
  last_error?: string
}

export const agentStreamStateFamily = atomFamily((sessionId: string) =>
  atom<AgentStreamState>({
    running: false,
    events: [],
    content: '',
  }),
)

// =========================================================================
// 2b. 委派协作视图状态（M4-C，按 sessionId 隔离）
// =========================================================================

export type DelegationViewStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** 委派子会话的渲染端视图（id/role/status 实时；pending_question 提示待回答）。 */
export interface DelegationView {
  delegation_id: string
  child_session_id: string
  role: string
  goal: string
  status: DelegationViewStatus
  /** 子 agent 挂起提问的问题（父 loop 待 answer；显示 pending 提示） */
  pending_question?: string
}

/** 委派生命周期聚合（仿 agentStreamStateFamily reducer）：从事件流归约出活跃/历史子会话列表。 */
export const delegationsFamily = atomFamily((_sessionId: string) => atom<DelegationView[]>([]))

/** 无 active session 时的稳定 fallback（避免 atomFamily 创建不可回收的 key，陷阱 10）。 */
export const emptyDelegationsFallback = atom<DelegationView[]>([])

/**
 * 决策卡片消费标记（per session）——修复「选了选项卡片还赖着不走」。
 *
 * 卡片是否显示由 `useUserDecisionCards` 从 events 反推（扫到 user_decision_required
 * 就显示，扫到 sketch_ready 才隐藏）。但草图走 LLM 后，从「用户点选」到「sketch_ready
 * 事件到达」有数秒到数十秒空窗，events 里最新仍是旧的 user_decision_required，卡片不消失，
 * 用户误以为没生效、再点一次就撞 AGENT_SESSION_BUSY。这个标记让点选动作立即消费卡片，
 * 不依赖后端事件时序；新一轮 user_decision_required 到达时重置，让新问题能重新弹出。
 */
export const decisionConsumedFamily = atomFamily((_sessionId: string) => atom(false))

/**
 * 需求确认弹窗数据（confirm_requirements 流，2026-08-26）：最新一条
 * kind='requirement_confirm' 的 user_decision_required 载荷，由专用弹窗
 * RequirementConfirmDialog 渲染。不走内联决策卡：该 kind 无 questions，
 * extractDecisionCards 的向后扫描天然返回空卡（不弹内联卡）。
 */
export interface RequirementConfirmState {
  sessionId: string
  projectId: string
  title: string
  requirements: Array<{ id: string; description: string; origin?: 'user' | 'guide' }>
  research: { available: boolean; summary: string }
  /** 市调提炼想法（2026-08-29 灵感参考）：可勾选采纳并入需求清单 */
  ideas: ResearchIdea[]
}

export const requirementConfirmFamily = atomFamily((_sessionId: string) => atom<RequirementConfirmState | null>(null))

/** 无 active session 时的稳定 fallback（陷阱 10：兜底 atom 一律模块级常量）。 */
export const nullRequirementConfirmFallback = atom<RequirementConfirmState | null>(null)

/**
 * PRD 确认弹窗数据（prd_confirm 流，2026-08-26 改造 3）：最新一条
 * kind='prd_confirm' 的 user_decision_required 载荷，由专用弹窗 PrdConfirmDialog
 * 渲染。四段式背板投影：P0 断言展开、P1/P2 折叠；完整视图 longterm 默认展开。
 * 不走内联决策卡：该 kind 无 questions，extractDecisionCards 天然不弹（同上）。
 */
export interface PrdConfirmRequirement {
  id: string
  priority: 'P0' | 'P1' | 'P2'
  story: string
  assertions: string[]
  /** 来源（Phase 7 U4 J4）：user=用户原话/点选，guide=向导补充；缺省不标 */
  origin?: 'user' | 'guide'
}

export interface PrdConfirmState {
  sessionId: string
  projectId: string
  title: string
  positioning: string
  /** 完整长文本 PRD 全文（2026-09-03 形态切换）：确认卡全文展示段；可选——旧背板/测试夹具缺省时卡片自动隐藏 */
  document?: string
  requirements: PrdConfirmRequirement[]
  outOfScope: string[]
  assumptions: string[]
  constraints: string[]
  /** 核心能力契约（Phase 2 M1，2026-09-09）：可选——缺失/空数组时卡片自动隐藏（开关 off/无 CAP/旧夹具） */
  aiCapabilities?: PrdConfirmCapability[]
  /** 关键任务（Phase 7 U1 H2，2026-09-10）：可选——缺失/空数组时卡片自动隐藏（开关 off/无任务/旧夹具） */
  keyTasks?: PrdConfirmKeyTask[]
  /** 完整 PRD 视图默认展开（longterm） */
  expanded: boolean
  /** 市调提炼想法（2026-08-29 灵感参考）：确认时可勾选采纳并入 PRD */
  ideas: ResearchIdea[]
}

export const prdConfirmFamily = atomFamily((_sessionId: string) => atom<PrdConfirmState | null>(null))

/** 核心能力契约展示型（Phase 2 M1）：主进程 AiCapability 的投影（仅展示所需字段）。 */
export interface PrdConfirmCapability {
  capabilityId: string
  task: string
  keyProcessing: string
  ioDependency: string
  forbiddenSubstitutions: string[]
  evidence: string[]
  source: string
}

/** 关键任务展示型（Phase 7 U1 H2）：主进程 KeyTask 的投影（仅展示所需字段）。 */
export interface PrdConfirmKeyTask {
  taskId: string
  label: string
  featureIds: string[]
  mustDeliver: boolean
}

/** 无 active session 时的稳定 fallback（陷阱 10）。 */
export const nullPrdConfirmFallback = atom<PrdConfirmState | null>(null)

/**
 * 加厚追问卡数据（enrichment_clarification 流，② 2026-09-03）：PRD 定稿前
 * 加厚腿声明的信息缺口，由 ClarificationCard 渲染。回答为开放文本（可多问合并作答），
 * 经 card_option 元数据回传（selected_option_id='enrichment_clarification_answer'，
 * 零新 IPC 通道）；答案由 orchestrator 统一落会话成为新接地证据。
 */
export interface EnrichmentClarificationOption {
  id: string
  label: string
}

export interface EnrichmentClarificationQuestion {
  for: string
  question: string
  options?: EnrichmentClarificationOption[]
}

export interface EnrichmentClarificationState {
  sessionId: string
  projectId: string
  title: string
  requests: EnrichmentClarificationQuestion[]
}

export const enrichmentClarificationFamily = atomFamily((_sessionId: string) => atom<EnrichmentClarificationState | null>(null))

/** 无 active session 时的稳定 fallback（陷阱 10）。 */
export const nullEnrichmentClarificationFallback = atom<EnrichmentClarificationState | null>(null)

/**
 * 裁判审查逐题选择题数据（prd_review 流，2026-08-30 选择题化）：最新一条
 * kind='prd_review' 的 user_decision_required 载荷，由专用弹窗 ReviewChoicesDialog
 * 渲染。逐题结构：每题 question + 一组可点选项；另有全局「全部交给向导决定」出口。
 * 不走内联决策卡（该 kind 无 questions 字段，extractDecisionCards 天然不弹内联卡）。
 */
export interface ReviewChoiceOption {
  id: string
  label: string
  description?: string
}

export interface ReviewChoiceQuestion {
  id: string
  question: string
  options: ReviewChoiceOption[]
}

export interface ReviewChoicesState {
  sessionId: string
  projectId: string
  title: string
  summary: string
  questions: ReviewChoiceQuestion[]
  /** 全局出口（全部交给向导决定） */
  globalOptions: ReviewChoiceOption[]
}

export const reviewChoicesFamily = atomFamily((_sessionId: string) => atom<ReviewChoicesState | null>(null))

/** 无 active session 时的稳定 fallback（陷阱 10）。 */
export const nullReviewChoicesFallback = atom<ReviewChoicesState | null>(null)

// =========================================================================
// 3. 消息列表（atomFamily）— 对齐 A
// =========================================================================

export const agentMessagesFamily = atomFamily((_sessionId: string) =>
  atom<AgentMessage[]>([]),
)

/** I3 转向生效确认链（P7-7）：会话级 steer 状态条数据（steer_status 事件 upsert；
 *  主进程账本镜像——「这轮会做吗」的权威答案源在主进程 getSteerStatuses）。 */
export interface SteerStatusChip {
  steerId: string
  content: string
  impact: SteerImpact
  status: SteerStatus
  updatedAt: number
}

export const steerStatusFamily = atomFamily((_sessionId: string) => atom<SteerStatusChip[]>([]))

// =========================================================================
// 4. 权限请求队列（对齐 A）
// =========================================================================

export const pendingPermissionRequestsAtom = atom<Map<string, PermissionRequest[]>>(new Map())

/**
 * 当前权限模式（F8 上移至此）：safe=自动拒绝危险 / ask=弹窗确认 /
 * allow-all=除 dangerous 外自动放行（dangerous 与模式无关须人工确认，@S3-JUDGE-009）。
 * 主进程 setMode 成功后广播 permission_mode_changed，全局监听器据此同步——
 * 设置页本地写仍保留（同一 atom，双入口一致）。
 */
export const permissionModeAtom = atom<'safe' | 'ask' | 'allow-all'>('ask')

export const currentSessionPermissionCountAtom = atom((get) => {
  const activeId = get(activeAgentSessionIdAtom)
  if (!activeId) return 0
  return get(pendingPermissionRequestsAtom).get(activeId)?.length ?? 0
})

// =========================================================================
// 5. setupGlobalAgentListeners（对齐 A：纯函数，非 React 组件）
// =========================================================================

/**
 * 在 main.tsx 中调用一次，永不卸载。
 * 使用 window.__jotai_store__ 直接操作 atoms，
 * 不依赖 React 组件生命周期。
 *
 * 用法：
 * ```ts
 * // main.tsx
 * import { Provider, createStore } from 'jotai'
 * import { setupGlobalAgentListeners } from './renderer/agent-atoms'
 *
 * const store = createStore()
 * window.__jotai_store__ = store
 * setupGlobalAgentListeners()
 * ```
 *
 * @returns cleanup 函数（仅在应用退出时调用）
 */
/** 会话用量（usage-guard 渲染层 2026-08-28）：usage_summary 事件的归约形态 */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  estContextTokens: number
  turnsWithUsage: number
}

export const sessionUsageFamily = atomFamily((sessionId: string) => atom<SessionUsage | undefined>(undefined))

/** 新一轮生成的开始信号：上一轮已终结后，这些事件到达即视为新一轮（清空历史 events，折叠组只显示最近一轮）。 */
const NEW_RUN_SIGNALS = new Set([
  'message_delta',
  'stage_changed',
  'tool_call_started',
  'user_decision_required',
  'sketch_ready',
  'mvp_ready',
  'repairing',
  'judge_result',
  'retrying',
  'loop_compaction',
  'delegation_started',
])

/** I3（P7-7）：steer 状态条 upsert（steer_status/steer_injected 事件同口径）。
 *  事件到达顺序无保证：同 steer_id 以 updatedAt 新者胜，保序插入（新 steer 追加尾部）。 */
function upsertSteerChip(
  store: NonNullable<Window['__jotai_store__']>,
  sessionId: string,
  chip: SteerStatusChip,
): void {
  store.set(steerStatusFamily(sessionId), (previous) => {
    const index = previous.findIndex((item) => item.steerId === chip.steerId)
    if (index === -1) return [...previous, chip]
    const existing = previous[index]
    if (existing.updatedAt > chip.updatedAt) return previous // 乱序田事件不回退状态
    const next = [...previous]
    next[index] = chip
    return next
  })
}

export function setupGlobalAgentListeners(): () => void {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api || !store) return () => undefined

  return api.onStreamEvent((event) => {
    // queued_started（message-queue 2026-08-27）：排队消息开始派发——追加「正在处理」
    // 提示，视觉上翻转「⏳ 已排队」（旧提示保留为历史记录）
    // usage_summary（usage-guard 渲染层 2026-08-28）：同会话累加渠道/估算用量
    if (event.type === 'usage_summary') {
      const p = event.payload as { input_tokens?: number; output_tokens?: number; est_context_tokens?: number; turns_with_usage?: number }
      const usagesAtom = sessionUsageFamily(event.session_id)
      const prev = store.get(usagesAtom)
      store.set(usagesAtom, {
        inputTokens: (prev?.inputTokens ?? 0) + (p.input_tokens ?? 0),
        outputTokens: (prev?.outputTokens ?? 0) + (p.output_tokens ?? 0),
        estContextTokens: p.est_context_tokens ?? prev?.estContextTokens ?? 0,
        turnsWithUsage: (prev?.turnsWithUsage ?? 0) + (p.turns_with_usage ?? 0),
      })
    }

    if (event.type === 'queued_started') {
      store.set(agentMessagesFamily(event.session_id), (previous) => [
        ...previous,
        {
          role: 'system',
          content: [{ type: 'text', text: '正在处理你排队的消息…' }],
          timestamp: Date.now(),
        },
      ])
    }

    // queue_dropped（onDropped 气泡，r79）：安全网放弃派发 → 红泡告知「发送失败」而非静默消失
    if (event.type === 'queue_dropped') {
      const p = event.payload as { reason?: string }
      store.set(agentMessagesFamily(event.session_id), (previous) => [
        ...previous,
        {
          role: 'system',
          content: [{ type: 'text', text: `[queue-dropped] 排队消息发送失败（${p.reason ?? 'unknown'}）——请重新发送` }],
          timestamp: Date.now(),
        },
      ])
    }

    // steer_injected（P0-1 运行中转向，2026-09-08）：用户中途补充已在工具批间注入——
    // 回执气泡（对齐 queue_dropped 红泡模式：事件驱动、会话消息流内）。事件也会落入
    // streamState.events（default 归约安全，过程视图按类型过滤未知事件零渲染）。
    // I3（P7-7）：on 时 payload 带 steer_id/status=merged_this_run——同步 upsert 状态条
    //（与 steer_status 双保险，两事件同点发出）；off 时 payload 无新键零行为变化。
    if (event.type === 'steer_injected') {
      const steerId = typeof event.payload.steer_id === 'string' ? event.payload.steer_id : undefined
      if (steerId) {
        upsertSteerChip(store, event.session_id, {
          steerId,
          content: typeof event.payload.content === 'string' ? event.payload.content : '',
          impact: 'low',
          status: 'merged_this_run',
          updatedAt: Date.now(),
        })
      }
      store.set(agentMessagesFamily(event.session_id), (previous) => [
        ...previous,
        {
          role: 'system',
          content: [{ type: 'text', text: '已注入，将于下一轮生效' }],
          timestamp: Date.now(),
        },
      ])
    }

    // steer_status（I3 转向生效确认链，P7-7，仅 on 时主进程发）：状态条 upsert——
    // 已收到→待确认→已纳入本轮/留待下一轮/未采用，随主进程账本推进如实翻转。
    if (event.type === 'steer_status') {
      const p = event.payload as { steer_id?: string; content?: string; impact?: SteerImpact; status?: SteerStatus; at?: number }
      if (p.steer_id && p.status) {
        upsertSteerChip(store, event.session_id, {
          steerId: p.steer_id,
          content: p.content ?? '',
          impact: p.impact ?? 'low',
          status: p.status,
          updatedAt: typeof p.at === 'number' ? p.at : Date.now(),
        })
      }
    }

    // I3：mvp_ready（本轮交付）时若存在留待下一轮的 steer——聊天流内追加待办提醒
    //（交付后再确认：用户看到后可直接发消息开始下一轮修改，无需翻状态条）。
    if (event.type === 'mvp_ready') {
      const deferred = (store.get(steerStatusFamily(event.session_id)) ?? []).filter(
        (chip) => chip.status === 'deferred_next_run',
      )
      if (deferred.length > 0) {
        store.set(agentMessagesFamily(event.session_id), (previous) => [
          ...previous,
          {
            role: 'system',
            content: [{
              type: 'text',
              text: [
                '本轮制作已交付。你之前留待下一轮的修改：',
                ...deferred.map((chip) => `· ${chip.content}`),
                '需要现在处理时，直接把这条修改再发一遍即可开始下一轮。',
              ].join('\n'),
            }],
            timestamp: Date.now(),
          },
        ])
      }
    }

    // 会话追踪：新出现的 session_id 追加到 agentSessionsAtom（已有索引的会话保持不变）
    store.set(agentSessionsAtom, (previous) => {
      if (previous.some((item) => item.session_id === event.session_id)) return previous
      return [
        ...previous,
        {
          session_id: event.session_id,
          project_id: event.project_id ?? '',
          title: '当前对话',
          created_at: event.created_at,
        },
      ]
    })

    // 项目隔离：全局阶段/快照等单例原子只接受当前项目的事件，后台项目的迟到事件
    // 不得挤占当前项目 UI（「运行状态相互挤占」的渲染端根因）。
    const isEventForCurrentProject = (): boolean => {
      const current = store.get(currentProjectAtom)
      if (!current || !event.project_id) return true
      return current.project_id === event.project_id
    }

    // 预览地址：sketch_ready / mvp_ready / rollback_done 带回沙箱 preview_url，按项目隔离存储（多项目各自独立预览）
    if (event.type === 'sketch_ready' || event.type === 'mvp_ready' || event.type === 'rollback_done') {
      const url = typeof event.payload.preview_url === 'string' ? event.payload.preview_url : null
      if (event.project_id && url) {
        store.set(previewUrlsAtom, (prev) => ({ ...prev, [event.project_id!]: { url, updatedAt: Date.now() } }))
      }
      const snapshotId = typeof event.payload.snapshot_id === 'string' ? event.payload.snapshot_id : null
      // 快照指针按当前项目隔离：后台项目迟到的 sketch_ready 不得改写当前项目 UI
      if (snapshotId && isEventForCurrentProject()) store.set(currentSnapshotIdAtom, snapshotId)
      // 时间轴数据源：后端每次落新快照即重新拉取快照列表，避免胶片条永远空
      if (event.project_id && isEventForCurrentProject()) void loadSnapshots(event.project_id)
    }

    // 自动命名：MVP 就绪时后端可能已按需求给项目改名（autoNameProject 落盘），
    // 重新拉项目列表回填 currentProjectAtom，让工作区头部立即显示新名字
    if (event.type === 'mvp_ready') {
      const projectApi = window.electronAPI?.project
      if (projectApi?.list) {
        void projectApi.list({ request_id: crypto.randomUUID() }).then((result) => {
          if (!result?.ok) return
          const current = store.get(currentProjectAtom)
          const updated = result.data.find((item) => item.project_id === current?.project_id)
          if (current && updated && updated.name !== current.name) {
            store.set(currentProjectAtom, updated)
          }
        })
      }
    }

    // 终态事件：将本次运行累积的流式回复沉淀为一条助手消息，
    // 修复「completed 后 running=false，流式文本消失且从未进消息列表」。
    // 读取尚未被重置的 content（同步），随后 reducer 再清空。
    if (event.type === 'completed' || event.type === 'error') {
      const terminalStreamAtom = agentStreamStateFamily(event.session_id)
      const accumulated = store.get(terminalStreamAtom)?.content ?? ''
      if (accumulated.trim()) {
        store.set(agentMessagesFamily(event.session_id), (previous) => [
          ...previous,
          {
            role: 'assistant',
            content: [{ type: 'text', text: accumulated }],
            timestamp: Date.now(),
          },
        ])
      }
    }

    // 新一轮决策需求到达 → 重置消费标记，让新卡片能重新弹出
    if (event.type === 'user_decision_required') {
      store.set(decisionConsumedFamily(event.session_id), false)
      // 需求确认弹窗（专用 kind，2026-08-26）：写入专用 atom，由 RequirementConfirmDialog 渲染
      const payload = event.payload as { kind?: unknown; title?: unknown; requirements?: unknown; research?: { available?: unknown; summary?: unknown }; ideas?: unknown }
      if (payload?.kind === 'requirement_confirm') {
        const requirements = Array.isArray(payload.requirements)
          ? (payload.requirements as Array<{ id: string; description: string; origin?: 'user' | 'guide' }>).filter(
              (item) => typeof item?.id === 'string' && typeof item?.description === 'string',
            ).map((item) => ({
              id: item.id,
              description: item.description,
              origin: item.origin === 'guide' ? ('guide' as const) : undefined,
            }))
          : []
        const ideas = Array.isArray(payload.ideas)
          ? (payload.ideas as Array<{ label?: unknown; note?: unknown; source?: unknown }>).filter(
              (item) => typeof item?.label === 'string' && item.label.trim().length > 0,
            ).map((item) => ({
              label: item.label as string,
              note: typeof item.note === 'string' ? item.note : '',
              source: typeof item.source === 'string' ? item.source : '',
            }))
          : []
        store.set(requirementConfirmFamily(event.session_id), {
          sessionId: event.session_id,
          projectId: String(event.project_id ?? ''),
          title: typeof payload.title === 'string' && payload.title ? payload.title : '确认你的需求',
          requirements,
          ideas,
          research: {
            available: payload.research?.available === true,
            summary: typeof payload.research?.summary === 'string' ? payload.research.summary : '',
          },
        })
      }
      // PRD 确认弹窗（专用 kind，2026-08-26 改造 3）：四段式背板投影写入专用 atom
      if (payload?.kind === 'prd_confirm') {
        const prdPayload = payload as {
          positioning?: unknown
          document?: unknown
          requirements?: unknown
          out_of_scope?: unknown
          assumptions?: unknown
          constraints?: unknown
          ai_capabilities?: unknown
          key_tasks?: unknown
          expanded?: unknown
          ideas?: unknown
        }
        const stringList = (value: unknown): string[] =>
          Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
        const prdRequirements = Array.isArray(prdPayload.requirements)
          ? (prdPayload.requirements as Array<Record<string, unknown>>).filter(
              (item) => typeof item?.id === 'string' && typeof item?.story === 'string',
            )
          : []
        store.set(prdConfirmFamily(event.session_id), {
          sessionId: event.session_id,
          projectId: String(event.project_id ?? ''),
          title: typeof payload.title === 'string' && payload.title ? payload.title : '请确认这份 PRD',
          positioning: typeof prdPayload.positioning === 'string' ? prdPayload.positioning : '',
          document: typeof prdPayload.document === 'string' ? prdPayload.document : '',
          requirements: prdRequirements.map((item): PrdConfirmRequirement => ({
            id: String(item.id),
            priority: item.priority === 'P0' ? 'P0' : item.priority === 'P1' ? 'P1' : 'P2',
            story: String(item.story),
            assertions: Array.isArray(item.assertions)
              ? item.assertions.filter((entry): entry is string => typeof entry === 'string')
              : [],
            ...(item.origin === 'user' || item.origin === 'guide' ? { origin: item.origin } : {}),
          })),
          outOfScope: stringList(prdPayload.out_of_scope),
          assumptions: stringList(prdPayload.assumptions),
          constraints: stringList(prdPayload.constraints),
          aiCapabilities: Array.isArray(prdPayload.ai_capabilities)
            ? (prdPayload.ai_capabilities as Array<Record<string, unknown>>)
                .filter((item) => typeof item?.task === 'string' && item.task.trim().length > 0)
                .map((item, index): PrdConfirmCapability => ({
                  capabilityId: typeof item.capability_id === 'string' && item.capability_id ? item.capability_id : `CAP-${String(index + 1).padStart(2, '0')}`,
                  task: String(item.task),
                  keyProcessing: typeof item.keyProcessing === 'string' ? item.keyProcessing : '',
                  ioDependency: typeof item.ioDependency === 'string' ? item.ioDependency : '',
                  forbiddenSubstitutions: Array.isArray(item.forbiddenSubstitutions)
                    ? item.forbiddenSubstitutions.filter((entry): entry is string => typeof entry === 'string')
                    : [],
                  evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string') : [],
                  source: typeof item.source === 'string' ? item.source : '',
                }))
            : [],
          keyTasks: Array.isArray(prdPayload.key_tasks)
            ? (prdPayload.key_tasks as Array<Record<string, unknown>>)
                .filter((item) => typeof item?.label === 'string' && item.label.trim().length > 0)
                .map((item, index): PrdConfirmKeyTask => ({
                  taskId: typeof item.task_id === 'string' && item.task_id ? item.task_id : `KT-${String(index + 1).padStart(2, '0')}`,
                  label: String(item.label),
                  featureIds: Array.isArray(item.feature_ids)
                    ? item.feature_ids.filter((entry): entry is string => typeof entry === 'string')
                    : [],
                  mustDeliver: item.must_deliver !== false,
                }))
            : [],
          expanded: prdPayload.expanded === true,
          ideas: Array.isArray(prdPayload.ideas)
            ? (prdPayload.ideas as Array<{ label?: unknown; note?: unknown; source?: unknown }>).filter(
                (item) => typeof item?.label === 'string' && item.label.trim().length > 0,
              ).map((item) => ({
                label: item.label as string,
                note: typeof item.note === 'string' ? item.note : '',
                source: typeof item.source === 'string' ? item.source : '',
              }))
            : [],
        })
      }
      // 加厚追问卡（enrichment_clarification 流，② 2026-09-03）：PRD 定稿前的信息
      // 缺口开放问题，写入专用 atom 由 ClarificationCard 渲染（不走内联决策卡：无选项）
      if (payload?.kind === 'enrichment_clarification') {
        const clarificationPayload = payload as { title?: unknown; requests?: unknown }
        const requests = Array.isArray(clarificationPayload.requests)
          ? (clarificationPayload.requests as Array<Record<string, unknown>>)
              .filter((item) => typeof item?.for === 'string' && typeof item?.question === 'string')
              .map((item) => ({
                for: String(item.for),
                question: String(item.question),
                options: Array.isArray(item.options)
                  ? (item.options as Array<Record<string, unknown>>)
                      .filter((opt) => typeof opt?.id === 'string' && typeof opt?.label === 'string')
                      .map((opt) => ({ id: String(opt.id), label: String(opt.label) }))
                  : [],
              }))
          : []
        if (requests.length > 0) {
          store.set(enrichmentClarificationFamily(event.session_id), {
            sessionId: event.session_id,
            projectId: String(event.project_id ?? ''),
            title: typeof clarificationPayload.title === 'string' && clarificationPayload.title
              ? clarificationPayload.title
              : '整理 PRD 前，先确认几个关键点',
            requests,
          })
        }
      }
      // 裁判审查逐题选择题（2026-08-30 选择题化）：review_questions 逐题结构 + 全局出口
      if (payload?.kind === 'prd_review') {
        const reviewPayload = payload as {
          summary?: unknown
          review_questions?: unknown
          global_options?: unknown
        }
        const reviewOptions = (value: unknown): ReviewChoiceOption[] =>
          Array.isArray(value)
            ? (value as Array<Record<string, unknown>>)
                .filter((item) => typeof item?.id === 'string' && typeof item?.label === 'string')
                .map((item) => ({
                  id: String(item.id),
                  label: String(item.label),
                  description: typeof item.description === 'string' ? item.description : undefined,
                }))
            : []
        const reviewQuestions = Array.isArray(reviewPayload.review_questions)
          ? (reviewPayload.review_questions as Array<Record<string, unknown>>)
              .filter((item) => typeof item?.id === 'string' && typeof item?.question === 'string')
              .map((item) => ({
                id: String(item.id),
                question: String(item.question),
                options: reviewOptions(item.options),
              }))
              .filter((item) => item.options.length > 0)
          : []
        if (reviewQuestions.length > 0) {
          store.set(reviewChoicesFamily(event.session_id), {
            sessionId: event.session_id,
            projectId: String(event.project_id ?? ''),
            title: typeof payload.title === 'string' && payload.title ? payload.title : '裁判发现几个地方需要你确认',
            summary: typeof reviewPayload.summary === 'string' ? reviewPayload.summary : '',
            questions: reviewQuestions,
            globalOptions: reviewOptions(reviewPayload.global_options),
          })
        }
      }
    }

    // 权限模式切换广播（F8）：主进程 setMode 成功后同步渲染端 atom——
    // 弹窗契约（dangerous 人工确认与模式无关）不再依赖「atom 恰好未同步」的缺口。
    if (event.type === 'permission_mode_changed' && typeof event.payload.mode === 'string') {
      const mode = event.payload.mode as 'safe' | 'ask' | 'allow-all'
      if (mode === 'safe' || mode === 'ask' || mode === 'allow-all') {
        store.set(permissionModeAtom, mode)
      }
    }

    // M4-C 委派协作视图：生命周期事件（delegation_started/completed/failed/cancelled）+
    // delegate_agent 工具调用的 detail 派生，归约进 delegationsFamily（仿 stream reducer）。
    store.set(delegationsFamily(event.session_id), (previous) => reduceDelegationEvent(previous, event))

    const streamAtom = agentStreamStateFamily(event.session_id)
    store.set(streamAtom, (previous: AgentStreamState) => {
      // 权限请求：从 payload 提取并写入队列
      const permissionRequest =
        event.type === 'permission_requested'
          ? (event.payload.request as PermissionRequest | undefined)
          : undefined

      if (permissionRequest) {
        store.set(pendingPermissionRequestsAtom, (current) => {
          const next = new Map(current)
          const existing = next.get(permissionRequest.session_id) ?? []
          next.set(permissionRequest.session_id, [...existing, permissionRequest])
          return next
        })
      }

      // 阶段变更：同步全局工作流阶段（只接受当前项目的事件，防止后台项目挤占 UI）
      if (event.type === 'stage_changed' && event.payload.stage && isEventForCurrentProject()) {
        store.set(workflowStageAtom, event.payload.stage as WorkflowStage)
        store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP[event.payload.stage as WorkflowStage] ?? '处理中')
      }

      // M-14：error 事件接通 globalUserErrorAtom（此前全仓无写入点——死代码，
      // PreviewPanel 的 error 兑底与 ChatPanel 的 alert 条永不触发）；
      // 新一轮任何输出（message_delta）到来时清空，避免陈旧错误常驻。
      if (isEventForCurrentProject()) {
        if (event.type === 'error') {
          const errorText =
            typeof event.payload.message === 'string' && event.payload.message
              ? event.payload.message
              : String(event.payload.code ?? '生成失败')
          store.set(globalUserErrorAtom, errorText)
        } else if (event.type === 'message_delta' && typeof event.payload.text === 'string' && event.payload.text) {
          store.set(globalUserErrorAtom, null)
        }
      }

      // Agent Loop 工具进行中（PR4）：编程阶段把阶段指示细化为「正在 {工具}」。
      // 只在生成/测试/修复/迭代阶段生效——澄清等对话阶段没有轮次语义；
      // 下一次 stage_changed 会重置回标准阶段文案，无需在此清理。
      // 2026-08-29 用户反馈：轮次号对零基础用户是噪音，隐藏「第 N 轮 ·」只留工具动作。
      if (event.type === 'tool_call_started' && isEventForCurrentProject()) {
        const stage = store.get(workflowStageAtom)
        if (stage === 'generating_mvp' || stage === 'testing' || stage === 'repairing' || stage === 'iterating') {
          const tool = String(event.payload.tool ?? '')
          const toolName = TOOL_STAGE_LABELS[tool] ?? tool
          store.set(stageIndicatorLabelAtom, `正在${toolName}`)
        }
      }

      const text = typeof event.payload.text === 'string' ? event.payload.text : ''
      const isTerminal = event.type === 'completed' || event.type === 'error'
      // 新一轮开始（上一轮已终结，且当前是生成类事件）→ 清空历史 events/content，
      // 折叠组只显示最近一轮工具调用，不累积多轮历史
      const isNewRun = !previous.running && !isTerminal && NEW_RUN_SIGNALS.has(event.type)
      // 等待决策事件（user_decision_required）不是「运行中」信号：它是「已完成、等用户
      // 决策」的静态信号。就绪引导卡（ready_next_steps）在 completed 之后到达，若照
      // 旧逻辑 running=!isTerminal 会被重新拉回 true → busy → 决策卡选项被禁用、UI
      // 永久停在「生成中」。此处保持上一轮的 running：前台流中弹卡仍为 true、后台
      // 管线完成后的引导/让渡卡仍为 false。
      const running =
        isTerminal ? false : event.type === 'user_decision_required' ? previous.running : true

      return {
        running,
        events: [...(isNewRun ? [] : previous.events), event],
        content: isTerminal ? '' : (isNewRun ? '' : previous.content) + text,
        last_error:
          event.type === 'error'
            ? String(event.payload.code ?? 'AGENT_SDK_ERROR')
            : previous.last_error,
      }
    })
  })
}

// =========================================================================
// 5b. 委派事件归约（M4-C）
// =========================================================================

/**
 * 委派事件 → delegationsFamily 的归约函数。
 *
 * 事件来源两类：
 * - 委派生命周期事件（delegation_started / completed / failed / cancelled /
 *   delegation_question）：主进程 agent-collaboration 在 start/settle/stop 时发布。
 * - tool_call_completed 的 detail（M4-C 透传 delegate_agent 结构化返回）：在 lifecycle
 *   事件缺失时派生初始行（防御时序——工具调用先于子循环收敛，started 通常已先到）。
 *
 * payload 契约：delegation_id / child_session_id / role / goal / status（生命周期事件与
 * delegate 工具 detail 共用同一字段名）。
 */
function reduceDelegationEvent(previous: DelegationView[], event: AgentEvent): DelegationView[] {
  // 生命周期事件（delegation_*）的 delegation_id 在顶层；tool_call_completed 的委派标识
  // 嵌套在 detail 里（agent-loop 白名单透传），这里统一提取，保证两种来源都能归约出委派行。
  const detail = event.payload.detail as Record<string, unknown> | undefined
  const id =
    typeof event.payload.delegation_id === 'string'
      ? event.payload.delegation_id
      : event.type === 'tool_call_completed' && detail && typeof detail.delegation_id === 'string'
        ? detail.delegation_id
        : undefined
  if (!id) return previous
  const index = previous.findIndex((item) => item.delegation_id === id)
  const existing = index >= 0 ? previous[index] : undefined
  const base: DelegationView = {
    delegation_id: id,
    child_session_id:
      existing?.child_session_id ?? (typeof event.payload.child_session_id === 'string' ? event.payload.child_session_id : ''),
    role: existing?.role ?? (typeof event.payload.role === 'string' ? event.payload.role : 'custom'),
    goal: existing?.goal ?? (typeof event.payload.goal === 'string' ? event.payload.goal : ''),
    status: existing?.status ?? 'running',
  }
  const upsert = (next: DelegationView): DelegationView[] => {
    if (index < 0) return [...previous, next]
    const copy = [...previous]
    copy[index] = next
    return copy
  }

  switch (event.type) {
    case 'delegation_started':
      return upsert({ ...base, status: 'running', pending_question: undefined })
    case 'delegation_completed':
      return upsert({ ...base, status: 'completed', pending_question: undefined })
    case 'delegation_failed':
      return upsert({ ...base, status: 'failed', pending_question: undefined })
    case 'delegation_cancelled':
      return upsert({ ...base, status: 'cancelled', pending_question: undefined })
    case 'delegation_question':
      return upsert({
        ...base,
        pending_question: typeof event.payload.question === 'string' ? event.payload.question : undefined,
      })
    case 'tool_call_completed': {
      // delegate_agent 工具调用的 detail（无 lifecycle 事件时的派生来源）；已有记录不覆盖
      // （tool_call 先于子循环收敛，避免把已 completed 的委派降回 running）。
      if (existing) return previous
      const detail = event.payload.detail as Record<string, unknown> | undefined
      if (!detail || typeof detail.delegation_id !== 'string') return previous
      const status = detail.status
      return upsert({
        delegation_id: detail.delegation_id,
        child_session_id: typeof detail.child_session_id === 'string' ? detail.child_session_id : '',
        role: typeof detail.role === 'string' ? detail.role : 'custom',
        goal: typeof detail.goal === 'string' ? detail.goal : '',
        status: status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'running',
      })
    }
    default:
      return previous
  }
}

// =========================================================================
// 6. 平台扩展 — 项目状态
// =========================================================================

/** 当前项目 */
export const currentProjectAtom = atom<Project | null>(null)

/** 项目模式（独立于 project，用于模式选择阶段） */
export const projectModeAtom = atom<ProjectMode | null>(null)

/** 工作流当前阶段 */
export const workflowStageAtom = atom<WorkflowStage>('choosing_mode')

/** 模式选择是否已完成 */
export const modeSelectedAtom = atom<boolean>(false)

// =========================================================================
// 7. 平台扩展 — UI 状态
// =========================================================================

/** 时间轴面板是否展开 */
export const timelineExpandedAtom = atom<boolean>(false)

/** 文档面板是否展开（仅长期迭代型可见） */
export const documentPanelExpandedAtom = atom<boolean>(false)

/** 协作面板（委派子会话抽屉）是否展开（M4-C，WorkspaceHeader「协作」按钮切换） */
export const collaborationPanelExpandedAtom = atom<boolean>(false)

/** 当前选中的快照 */
export const selectedSnapshotAtom = atom<Snapshot | null>(null)

/** 网络在线状态 */
export const networkOnlineAtom = atom<boolean>(navigator.onLine)

/** 阶段指示器文案（P0 用户可见） */
export const stageIndicatorLabelAtom = atom<string>('选择模式')

/** 各项目最近一次 sketch_ready / mvp_ready 事件带回的沙箱预览地址（按 project_id 隔离；
 * updatedAt 用于 cache-buster：沙箱同端口重 serve 新产物时 URL 不变，webview 不重载——
 * 2026-08-27 线上案例「迭代后预览内容没变」） */
export const previewUrlsAtom = atom<Record<string, { url: string; updatedAt: number }>>({})

/** 最近一次 sketch_ready / mvp_ready 事件带回的快照 id；null = 尚无快照（供「确认草图」回传） */
export const currentSnapshotIdAtom = atom<string | null>(null)

/** 全局用户可见错误 */
export const globalUserErrorAtom = atom<string | null>(null)

/** 升级确认弹窗可见性 */
export const upgradeConfirmVisibleAtom = atom<boolean>(false)

// =========================================================================
// 8. 平台扩展 — 点选纠错
// =========================================================================

/** 纠错弹窗是否可见 */
export const correctionModalVisibleAtom = atom<boolean>(false)

/** 纠错弹窗中的用户输入 */
export const correctionUserNoteAtom = atom<string>('')

/** 当前被点击元素的上下文 */
export const correctionContextAtom = atom<{
  elementSelector?: string
  textContent?: string
  boundingRect: { x: number; y: number; width: number; height: number }
  screenshotRegionPath?: string
  fallbackMode: boolean
} | null>(null)

// =========================================================================
// 9. 平台扩展 — 快照列表
// =========================================================================

export const snapshotsListAtom = atom<Snapshot[]>([])

// =========================================================================
// 10. 派生 atoms
// =========================================================================

export const isQuickModeAtom = atom((get) => get(projectModeAtom) === 'quick')

export const isLongtermModeAtom = atom((get) => get(projectModeAtom) === 'longterm')

export const documentPanelVisibleAtom = atom(
  (get) => get(isLongtermModeAtom) && get(currentProjectAtom) !== null,
)

export const hasActiveStreamAtom = atom((get) => {
  const sessionId = get(activeAgentSessionIdAtom)
  if (!sessionId) return false
  return get(agentStreamStateFamily(sessionId)).running
})

export const canUpgradeAtom = atom((get) => {
  const project = get(currentProjectAtom)
  return project?.mode === 'quick' && project?.status === 'completed'
})

// =========================================================================
// 11. Action helpers
// =========================================================================

/** 将消息添加到指定会话 */
export function appendMessageToSession(
  sessionId: string,
  message: AgentMessage,
): void {
  const store = window.__jotai_store__
  if (!store) return
  const messagesAtom = agentMessagesFamily(sessionId)
  store.set(messagesAtom, (prev) => [...prev, message])
}

/** 标记当前会话的决策卡片已被消费（用户已点选），立即隐藏卡片。 */
export function markDecisionConsumed(sessionId: string): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(decisionConsumedFamily(sessionId), true)
}

/** 将后端会话索引记录映射为 renderer 侧会话元数据 */
function toSessionMeta(record: AgentSessionRecord): AgentSessionMeta {
  return {
    session_id: record.session_id,
    project_id: record.project_id,
    title: record.summary || record.session_id,
    created_at: record.created_at,
  }
}

/**
 * 拉取会话索引并灌入 agentSessionsAtom（回访恢复时调用）。
 * 无 electronAPI/agent.listSessions 环境时静默跳过（兼容测试环境）。
 */
export async function loadAgentSessions(projectId?: string): Promise<void> {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api?.listSessions || !store) return
  const result = await api.listSessions({
    request_id: crypto.randomUUID(),
    project_id: projectId,
  })
  if (!result.ok) return
  store.set(agentSessionsAtom, result.data.sessions.map(toSessionMeta))
}

/**
 * 从磁盘加载历史消息并灌入对应会话的 agentMessagesFamily（回访恢复时调用）。
 * 无 electronAPI/agent.loadMessages 环境时静默跳过（兼容测试环境）。
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api?.loadMessages || !store) return
  const result = await api.loadMessages({
    request_id: crypto.randomUUID(),
    session_id: sessionId,
    limit: 200,
  })
  if (!result.ok) return
  store.set(agentMessagesFamily(sessionId), result.data.messages)
}

/**
 * 从磁盘加载项目快照列表并灌入 snapshotsListAtom（时间轴胶片条的数据源）。
 * 无 electronAPI/snapshots.list 环境时静默跳过（兼容测试环境）。
 */
export async function loadSnapshots(projectId: string): Promise<void> {
  const api = window.electronAPI?.snapshots
  const store = window.__jotai_store__
  if (!api?.list || !store) return
  const result = await api.list({
    request_id: crypto.randomUUID(),
    project_id: projectId,
  })
  if (!result.ok) return
  // 防串台：切项目后旧项目的异步回包不得覆盖当前项目时间轴
  if (store.get(currentProjectAtom)?.project_id !== projectId) return
  store.set(snapshotsListAtom, result.data.snapshots)
}

/** 清除指定权限请求 */
export function clearPermissionRequest(sessionId: string, permissionId: string): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(pendingPermissionRequestsAtom, (prev) => {
    const next = new Map(prev)
    const existing = next.get(sessionId) ?? []
    next.set(
      sessionId,
      existing.filter((r) => r.id !== permissionId),
    )
    return next
  })
}

/** 重置项目状态 */
export function resetProjectState(): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(currentProjectAtom, null)
  store.set(projectModeAtom, null)
  store.set(workflowStageAtom, 'choosing_mode')
  store.set(modeSelectedAtom, false)
  store.set(timelineExpandedAtom, false)
  store.set(documentPanelExpandedAtom, false)
  store.set(collaborationPanelExpandedAtom, false)
  store.set(snapshotsListAtom, [])
  store.set(selectedSnapshotAtom, null)
  store.set(stageIndicatorLabelAtom, '选择模式')
}

// =========================================================================
// 12. 阶段指示器文案（P0 用户可见中文）
// =========================================================================

/** Agent Loop 工具 → 阶段指示文案（2026-08-29 起隐藏轮次：「正在写入文件」）。 */
export const TOOL_STAGE_LABELS: Record<string, string> = {
  read_file: '读取文件',
  list_files: '查看文件列表',
  grep: '搜索代码',
  write_file: '写入文件',
  edit_file: '修改文件',
  run_preview: '启动预览',
  run_gwt_tests: '测试功能',
  run_security_scan: '安全扫描',
}

export const STAGE_LABEL_MAP: Record<WorkflowStage, string> = {
  choosing_mode: '选择模式',
  clarifying: '等待你确认几个问题',
  generating_sketch: '正在生成草图',
  sketch_ready: '草图已生成',
  generating_mvp: '正在生成完整功能',
  testing: '正在检查能不能正常使用',
  judge_review: '正在确认功能是否到位',
  repairing: '正在尝试修复',
  ready: '可以试用了',
  iterating: '正在继续调整',
  completed: '已完成',
  upgrading: '正在升级为长期维护模式',
  blocked_for_user_decision: '需要你来决定',
}
