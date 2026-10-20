import { sessionMaterials, renderMaterialContext, providedPages } from '../platform/attachments/material-context'
/**
 * guide/pipeline — 向导群·PRD 收敛管线（2026-09-03 模块化 R3）。
 *
 * `resolvePrdBackplane` 自 programming-orchestrator 迁入：PRD 背板来源分流
 * （LLM 双腿并行 vs 确定性模板回退）是需求工程链的一环（2026-09-03 架构调整后
 * 归向导群职责），编程编排器只消费背板不生产背板。programming-orchestrator
 * 保留 re-export 过渡（既有调用方/测试 import 路径零改动，R4 群目录归位后统一收口）。
 *
 * 依赖方向（D-6：群间只依赖 model 契约与 kernel 机制，叶子引擎单向）：
 * 本模块只依赖 model/prd-backplane 契约 + 叶子引擎（prd-engine-llm /
 * requirement-enricher / document-engine / runtime-fallback / decision-log /
 * project-service），**不反向 import programming-orchestrator**——输入类型
 * `PrdPipelineInput` 是 MvpTaskInput 的结构子集（project_id/session_id/
 * channel_id/query/signal），TS 结构类型兼容，两处调用点（runPrdPipeline 主路 /
 * syncPrdCheckpoints 辅路）零改动。
 */

import { buildPrdBackplane, readPrdBackplane } from '../project/document-engine'
import { applyGeneratedProjectName, findProject } from '../project/project-service'
import { resolveChannelEnv } from '../platform/llm/runtime-fallback'
import { backplaneTemplateMeta, type PrdBackplane, type SketchRequirement } from "../model/prd-backplane";
import { generatePrdLlm, readConversation } from './prd-engine-llm'
import { enrichRequirementsLlm, extractUserTexts, mergeEnrichment } from './requirement-enricher'
import { recordDecision } from '../project/decision-log'
import type { SDKQuery } from '../orchestration/orchestrator'
import type { EnrichmentClarificationRequest } from './clarification'
import { PrdStructureError, prdStructureIssues, projectRequirementsModel } from '../model/requirements-model'
import { sanitizeConstraints } from './constraint-extractor'

/**
 * PRD 收敛管线输入（MvpTaskInput 的结构子集）：resolvePrdBackplane 实际消费的
 * 字段。保持结构兼容（不复制 MvpTaskInput 全量——mode/request_id 等编排器字段
 * 与背板来源分流无关，收窄入参即锁定依赖边界）。
 */
export interface PrdPipelineInput {
  /** false is reserved for compatibility callers that explicitly preserve an existing frozen list. */
  organize_requirements?: boolean
  project_id: string
  session_id: string
  channel_id?: string
  query?: SDKQuery
  signal?: AbortSignal
}

/**
 * PRD 背板来源分流：渠道可用走 LLM 从对话提取，否则回退确定性模板。
 *
 * 2026-08-18 功能项加厚（设计 §3.3）：在 sketch_confirmed 与 `generatePrdLlm` **并行**
 * 跑一道「功能项加厚」LLM 提取（`enrichRequirementsLlm`），把薄功能项补成 story +
 * 行为断言 + 优先级。两路互不依赖、共用同一渠道/env/对话；任一失败一律降级，绝不
 * 阻断主链路——`enrichRequirementsLlm` 契约返回 null，但 abort/网络极端情形仍可能
 * throw，一并 `.catch(()=>null)` 兜底。
 *
 * 合并底 = 冻结清单（权威 id 集） + `readPrdBackplane` 上轮 prd.json 对应项既有字段
 * （重跑时上轮 auto priority/已厚断言成为「已有」被「只填缺省」保留）；`mergeEnrichment`
 * 返回 `{ requirements, stats }`，断言丢弃率/优先级抑制数由本调用侧落决策日志
 * （enrichment_stats）供线上标定接地守卫误杀——日志失败仅静默丢弃，不阻断主链路。
 * 追问通路透传（② 2026-09-03，K-1）：可选 onClarification 回调——主路
 * （runPrdPipeline）传入收集加厚腿声明的信息缺口并挂起；辅路（MVP 生成中途的
 * syncPrdCheckpoints）不传 → 信号自然丢弃，静默降级 = 现状（生成链路中途不追问用户）。
 */
export async function resolvePrdBackplane(
  input: PrdPipelineInput,
  requirements: SketchRequirement[],
  onClarification?: (requests: EnrichmentClarificationRequest[]) => void,
): Promise<PrdBackplane> {
  const materials = sessionMaterials(input.project_id, input.session_id)
  const materialText = renderMaterialContext(materials, input.session_id, true)
  const organize = input.organize_requirements !== false
  const template = (): PrdBackplane => {
    const backplane = buildPrdBackplane(findProject(input.project_id), requirements, 'sketch_confirmed')
    return { ...backplane, constraints: sanitizeConstraints(backplane.constraints) }
  }

  // m-5：模板回退重建必须留痕（对齐「模板回退必须留痕」纪律）——盘上既有 EARS 断言/
  // story/priority 若与冻结清单不一致将被确定性模板替换，P3 收益在渠道抖动下不可累积，
  // 此前无任何观测点；日志属附加观测，失败不阻断主链路。
  const noteFallback = (reason: 'no_query' | 'no_channel' | 'llm_failed'): void => {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'prd_backplane_fallback',
          title: 'PRD 背板模板回退重建',
          why: 'PRD 渠道不可用/提取失败，背板按确定性模板重建；盘上既有 EARS 断言/story/priority 若与冻结清单不一致将被替换（降级设计，观测留痕）',
          detail: { reason, ...(reason === 'llm_failed' && lastPrdFailure ? { last_failure: `${lastPrdFailure.kind}: ${lastPrdFailure.detail}` } : {}) },
        },
      })
    } catch {
      // 忽略：日志失败不影响主链路
    }
  }

  if (!input.query) {
    noteFallback('no_query')
    if (organize) throw new PrdStructureError(['需求提炼渠道不可用，不能将未整理的候选清单作为完整 PRD'])
    return template()
  }
  // 渠道+类别统一收口（runtime-fallback，T9）；prd 类别解析模型，主渠道不可用已尝试
  // 切备用渠道，仍无可用回退确定性模板（PRD 提取失败不阻断生成）
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'prd',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  if (!resolution.env || !resolution.channel) {
    noteFallback('no_channel')
    if (organize) throw new PrdStructureError(['需求提炼渠道不可用，请恢复渠道后重试'])
    return template()
  }
  const channel = resolution.channel
  const env = resolution.env

  // 尝试失败观测（2026-10-03 e99e6319 事故）：llm_failed 此前不带任何原因（双层
  // catch 吞干净），事故归因只能靠外部探针；现在把最后一次失败的真实原因带进决策日志
  let lastPrdFailure: { kind: string; detail: string } | undefined
  const onAttemptFailure = (failure: { kind: string; detail: string }): void => {
    lastPrdFailure = { kind: failure.kind, detail: failure.detail }
  }

  const project = findProject(input.project_id)
  // 上轮已写盘的 prd.json（如有）：重跑时其对应项既有字段并入合并底（§3.2）；首轮无 prd.json 按最后草图需求忠实重建（不含默认项）
  const existing = readPrdBackplane(input.project_id)
  // 渠道能力上限：enricher 与 generatePrdLlm 共用同一上限，直接用渠道配置值；
  // 2026-09-05 全渠道统一 640000（防思考型渠道零正文；渠道显式配置仍优先）
  const maxTokens = channel.max_tokens ?? 640000
  // 并行：PRD 元数据提取 + 功能项加厚互不依赖，共用同一渠道/env/对话
  const [llm, enriched] = await Promise.all([
    generatePrdLlm({
      organize_requirements: organize,
      existing_model: existing,
      ...(project.auto_named || project.name_source === 'user' || (project.name_source === undefined && project.name !== '未命名项目')
        ? { preferred_name: project.name } : {}),
      material_text: materialText,
      project_id: input.project_id,
      session_id: input.session_id,
      requirements,
      // 注入点③：项目类型透传（few-shot 同类型样例路由）
      template_type: project.template_type,
      query: input.query,
      env,
      maxTokens,
      signal: input.signal,
      onAttemptFailure,
    }).catch(() => null), // 防御性兜底：契约返回 null，但 abort/网络极端情形仍可能 throw，一并降级避免 Promise.all 整体 reject
    organize ? Promise.resolve(null) : enrichRequirementsLlm({
      material_text: materialText,
      session_id: input.session_id,
      requirements,
      query: input.query,
      env,
      maxTokens,
      signal: input.signal,
    }, onClarification).catch(() => null), // 异常一律降级 null，绝不因 reject 阻断主链路
  ])

  if (organize && !llm) throw new PrdStructureError([input.signal?.aborted ? '需求提炼已停止' : `结构化需求提炼失败${lastPrdFailure ? `（${lastPrdFailure.kind}：${lastPrdFailure.detail}）` : ''}，未生成可确认的 PRD`])

  const base = llm ?? template()
  if (llm?.name && !input.signal?.aborted) applyGeneratedProjectName(input.project_id, project.name, llm.name)
  if (!llm) noteFallback('llm_failed')
  // 权威 id 集：冻结清单（llm 失败回退 template() 时其 requirements 可能与冻结清单
  // 不一致——template() 会把默认存在性断言/story 物化，以原始冻结清单为准保证加厚不丢）
  const frozen = llm ? base.requirements : requirements
  // 接地守卫②的用户原话（user 轮次；assistant 轮次不参与子串匹配，防模型自述被引为支撑）
  const userTexts = [...extractUserTexts(readConversation(input.session_id)), ...providedPages(materials).map(page => page.text)]
  // 冻结项为 id 骨架，上轮 prd.json 对应项既有字段并入合并底；stats 为断言丢弃与优先级抑制分类（纯返回值，无日志副作用）
  let enrichedRequirements: SketchRequirement[]
  let stats = { formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 }
  try {
    const merged = organize ? { requirements: frozen, stats } : mergeEnrichment(frozen, enriched, existing.requirements ?? [], userTexts)
    enrichedRequirements = merged.requirements
    stats = merged.stats
  } catch {
    // 防御性兜底：mergeEnrichment 自身契约不抛错（内部回退合并底），此处再包一层——
    // 任何异常回退冻结清单，绝不阻断 MVP 生成主链路（设计 §3.4）
    enrichedRequirements = frozen
  }
  // 丢弃率/抑制率决策日志（T2 recordDecision）：供线上标定接地守卫误杀。日志属附加
  // 观测，绝不得阻断主链路——recordDecision 为同步 void 且内部 appendJsonLine 无异常
  // 包裹，可能 throw，须 try/catch 隔离，失败仅静默丢弃观测
  try {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'enrichment_stats',
        title: '功能项加厚断言丢弃与优先级抑制统计',
        why: '记录格式/接地守卫断言丢弃数与优先级抑制数，供线上标定',
        detail: stats,
      },
    })
  } catch {
    // 忽略：日志失败不影响主链路
  }
  // 项目级字段合并（T4-L1）：LLM 从对话提取的背板不带 project.constraints /
  // scope_exclusions（其提取源是会话文本，项目存储是另一路事实）——冻结前并入，
  // 防止确定性门捕获的约束/范围声明在 prd.json 里丢失。
  // template_meta（注入点①）：LLM 背板不带模板元信息，按项目 template_type 兜底写入；
  // 若 base 已携带（重跑/迭代路径保留旧值）则原样保留。
  const currentName = findProject(input.project_id).name
  const result = projectRequirementsModel({
    ...base,
    name: currentName,
    // 请求期间用户可能手动改名；仅同步正式标题，不改正文需求或历史产物。
    ...(base.prd_document ? { prd_document: base.prd_document.replace(/^#\s+PRD\s*[:：][^\r\n]*/m, () => `# PRD：${currentName}`) } : {}),
    requirements: enrichedRequirements,
    out_of_scope: [...new Set([...(llm?.out_of_scope ?? []), ...(project.scope_exclusions ?? [])])],
    constraints: [...new Set(sanitizeConstraints([...(base.constraints ?? []), ...(project.constraints ?? [])]))],
    template_meta: base.template_meta ?? backplaneTemplateMeta(base, project.template_type),
  })
  if (organize) {
    // Open business questions are handled by the main pipeline's bounded clarification path.
    const structural = prdStructureIssues(result).filter(issue => issue !== '仍有未处理的需求问题')
    if (structural.length) throw new PrdStructureError(structural)
  }
  return result
}
