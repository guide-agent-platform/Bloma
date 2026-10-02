/**
 * 需求追加/断言更新/PRD 渲染；对外契约经 document-engine re-export 保持不变。
 * 纯机械搬移；对外契约经 document-engine re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DocumentReadResult,
  DocumentRef,
  DocumentSyncInput,
  DocumentSyncResult,
  Project,
  TemplateType,
} from '../../shared/types'
import { getDocumentsDir } from '../../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import { nextRequirementId } from '../coding/programming-orchestrator'
import type { PrdBackplane, RequirementStatus, SketchRequirement } from '../coding/sketch-engine'
import { buildPrdDocumentFallback, deriveInterfaceSpec, requirementAssertions, requirementPriority, requirementStatusLabel, requirementStory, backplaneTemplateMeta } from '../coding/sketch-engine'
import { parseEarsAssertion } from '../guide/ears-vocabulary'
import { gwtRequiredCategories } from '../agent/prompting/template-injection'
import { describeEffect, describeTrigger, parseBehaviorAssertion } from '../verification/behavior-assertions'
import { readRequirements, assertInsideDocumentsDir } from './document-sync'

/**
 * DocumentEngine — 文档同步（对齐 api-spec §10.1 / architecture §7.3）。
 *
 * 替换 `syncDocuments` 桩，按 checkpoint 产出真实文档，写入 `documents/{project_id}/`：
 * - `sketch_confirmed`      → PRD 草案（含核心功能项）
 * - `mvp_before_generation` → PRD 完整功能项 + GWT 骨架（`features/*.feature`）
 * - `mvp_tested`            → 测试报告挂载（报告本体由 A2-07 GWT 执行后唯一写盘）
 * - `iteration_completed`   → 变更记录
 * - `mode_upgraded`         → 长期模式规划 + PlantUML + Sprint 文档
 * - 模式分支：`longterm` 额外产出 PlantUML + Sprint 文档；`quick` 跳过，避免过度产出。
 *
 * ⚠️ 协作 D3：GWT 骨架写盘由 A 负责（A2-07 在此扩展结果解析），本模块只约定文档结构
 * 与 feature 文件路径，确保 JudgeEngine（A2-10）能读取。
 */

interface ManifestEntry {
  document_id: string
  path: string
  type: DocumentRef['type']
  checkpoint: string
  status: DocumentRef['status']
}


/**
 * 组装 PRD 背板（快消型的唯一需求事实源，密背板版 §3.2）。
 *
 * - positioning 取 F-001（主题锚点，改造 A 已保证 F-001 是用户最初想做什么）；
 * - requirements 构建侧归一化为厚形态（story/断言/优先级物化进 prd.json，§10 兼容：
 *   旧数据无需迁移，读取侧经 requirement* helper 回退默认）；
 * - acceptance 保持兼容（行为断言迁入 requirements 后逐步废弃）；
 * - out_of_scope 并入 normalizer 判定的范围声明（project.scope_exclusions）；
 * - mvp_before_generation 时冻结（落盘 frozen_at），此后编程管线只读冻结版。
 */
export function buildPrdBackplane(
  project: Project,
  requirements: SketchRequirement[],
  checkpoint: DocumentSyncInput['checkpoint'],
): PrdBackplane {
  const items = readRequirements(requirements).map(normalizeRequirement)
  const acceptance: Record<string, string> = {}
  for (const item of items) {
    // acceptance 是废弃中的兼容字段（行为断言已迁入 requirements）：保持旧格式，
    // 供 GWT 骨架「验收要点」等存量消费方读取，新数据流一律走 requirements
    acceptance[item.id] = `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  // 完整程序阶段 2.5：模板路径同样做数据留存信号兜底——确定性派生最小契约
  // （迭代重跑经此重建 prd.json 时契约自愈，不因重建丢失）；C1b：game 豁免开启时
  // 轻留存不派生（localStorage 即可满足，拍板 2026-09-11）
  const derivedInterfaceSpec = deriveInterfaceSpec(items, project.template_type)
  return {
    project_id: project.project_id,
    name: project.name,
    positioning: items[0]?.description ?? project.name,
    requirements: items,
    acceptance,
    out_of_scope: [...new Set(project.scope_exclusions ?? [])],
    // 2026-09-03 长文本 PRD dual-form：确定性模板同样产出 prd_document（机械拼装，不编内容），
    // 保证确认卡/loop 锚的消费假设恒成立（LLM 路径由工程腿产出全文，两者同源异质）
    prd_document: buildPrdDocumentFallback({
      positioning: items[0]?.description ?? project.name,
      requirements: items,
      acceptance,
      out_of_scope: [...new Set(project.scope_exclusions ?? [])],
      assumptions: [],
      constraints: project.constraints,
    }),
    // 用户约束常驻注入（T4-L1）：project.constraints 是唯一写入源（澄清门/修改门
    // 确定性提取），背板只做组装——不在这里引入第二个事实源
    ...(project.constraints?.length ? { constraints: [...new Set(project.constraints)] } : {}),
    assumptions: [],
    ...(derivedInterfaceSpec ? { interface_spec: derivedInterfaceSpec } : {}),
    // 注入点①（周计划 §6）：模板元信息随背板落盘，下游注入点按此路由；
    // 缺省按项目 template_type 兜底构造（与读取侧 backplaneTemplateMeta 同源）
    template_meta: backplaneTemplateMeta({}, project.template_type),
    ...(checkpoint === 'mvp_before_generation' ? { frozen_at: new Date().toISOString() } : {}),
  }
}

/** 构建侧归一化（§10 兼容）：薄形态物化为厚形态，缺省值与读取侧 helper 一致。
 * priority 不物化缺省（P1-11，2026-10-02）：物化会挡住 enricher 升档（merge「缺才补」）
 * ——渠道抖动首写全员 P2 后 P0/P1 永补不进；与断言 stripDefaultAssertions 通道对称。 */
function normalizeRequirement(item: SketchRequirement): SketchRequirement {
  return {
    ...item,
    story: requirementStory(item),
    behavior_assertions: requirementAssertions(item),
    ...(item.priority ? { priority: item.priority } : {}),
  }
}

/**
 * 读取 PRD 背板（prd.json），作为裁判/意图识别的唯一需求事实源。
 *
 * - 已冻结（sketch_confirmed 写过 prd.json）时直接读盘；
 * - 无 prd.json（旧数据 / 仅走到 mvp_before_generation）时按最后草图需求忠实重建，
 *   且**不填默认项**——让「PRD 核心功能项为空」能被如实判退回。
 */
export function readPrdBackplane(projectId: string): PrdBackplane {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const path = join(dir, 'prd.json')
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
      if (parsed && Array.isArray(parsed.requirements)) return parsed
    } catch {
      // 损坏则回退到按当前需求重建
    }
  }
  const items = readLastSketchRequirements(projectId)
  return {
    project_id: project.project_id,
    name: project.name,
    positioning: items[0]?.description ?? project.name,
    requirements: items,
    acceptance: {},
    out_of_scope: [...new Set(project.scope_exclusions ?? [])],
    ...(project.constraints?.length ? { constraints: [...new Set(project.constraints)] } : {}),
    assumptions: [],
  }
}

/** 语义审查判定回写的入参（与 judge-semantic.SemanticFinding 结构兼容，避免模块循环依赖）。 */
export interface RequirementStatusUpdate {
  requirement_id: string
  status: RequirementStatus
  evidence?: string
}

/**
 * 活背板（2026-08-26）：把裁判语义审查的逐功能项判定回写进 prd.json（ralph 式 passes）。
 *
 * - 只改 requirements[].status / status_note，其余字段（含 frozen_at）原样保留；
 * - 需求内容仍以冻结清单为准——回写是执行侧状态，不触碰需求语义；
 * - prd.json 缺失 / 损坏 / 写失败：静默返回 null（增强腿，绝不阻断裁决流）；
 * - 迭代全量重生成时 syncPrdCheckpoints 重写 prd.json，status 自然清除（新产物未判定）。
 */
export function updateRequirementStatus(
  projectId: string,
  updates: RequirementStatusUpdate[],
): PrdBackplane | null {
  if (updates.length === 0) return null
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const path = join(dir, 'prd.json')
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    if (!parsed || !Array.isArray(parsed.requirements)) return null
    const byId = new Map(updates.map((update) => [update.requirement_id, update]))
    parsed.requirements = parsed.requirements.map((item) => {
      const update = byId.get(item.id)
      if (!update) return item
      const note = update.evidence?.trim().slice(0, 160)
      return { ...item, status: update.status, ...(note ? { status_note: note } : {}) }
    })
    writeFileSync(path, renderPrdJson(parsed), 'utf8')
    return parsed
  } catch {
    return null
  }
}

/**
 * PRD 用户确认落盘（2026-08-26，改造 3）：确认卡「确认无误」时写入 user_confirmed_at。
 * 只加/更新时间戳字段，其余内容原样保留；prd.json 缺失/损坏 → null 不抛错（增强腿）。
 */
export function markPrdUserConfirmed(projectId: string): PrdBackplane | null {
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const path = join(dir, 'prd.json')
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    if (!parsed || !Array.isArray(parsed.requirements)) return null
    const confirmed: PrdBackplane = { ...parsed, user_confirmed_at: new Date().toISOString() }
    writeFileSync(path, renderPrdJson(confirmed), 'utf8')
    return confirmed
  } catch {
    return null
  }
}

/** PRD 是否已被用户确认过（确认卡「确认无误」落盘 user_confirmed_at）。
 * 读取失败/无 prd.json（回退重建对象无该字段）均视为未确认——fail-closed，
 * 供点选纠错等直达开工路径的「不过目不开工」防御检查使用（2026-08-27）。 */
export function isPrdUserConfirmed(projectId: string): boolean {
  try {
    return Boolean(readPrdBackplane(projectId).user_confirmed_at)
  } catch {
    return false
  }
}

/** 项目命名回填 prd.json 的 name（A10，2026-09-03）：命名腿此前只写 projects.json，
 * PRD name 停在「未命名项目」——loop 任务文本与 PRD 过目卡都跟着错。
 * 读-改-写只动 name，保留全部既有字段（含 user_confirmed_at）；失败静默不阻断。 */
export function renamePrdProject(projectId: string, name: string): boolean {
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const path = join(dir, 'prd.json')
    if (!existsSync(path)) return false
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    if (!parsed || !Array.isArray(parsed.requirements)) return false
    if (typeof name !== 'string' || !name.trim()) return false
    writeFileSync(path, renderPrdJson({ ...parsed, name: name.trim() }), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 向盘上 prd.json 追加功能项（2026-08-29 灵感参考：PRD 确认卡勾选采纳市调想法）。
 * 读-改-写保留全部既有字段（含 user_confirmed_at/status 等）；**id 由本函数内部按
 * 盘上现状编号**（nextRequirementId 语义 max+1，审查修复：调用方猜号在盘上条目多于
 * 待决清单时会碰撞被去重过滤，勾选的想法静默丢失）；失败返回 null 不抛错。 */
export function appendPrdRequirements(
  projectId: string,
  items: Array<{ description: string; origin?: 'user' | 'guide' }>,
): PrdBackplane | null {
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const path = join(dir, 'prd.json')
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    if (!parsed || !Array.isArray(parsed.requirements)) return null
    const existingDescriptions = new Set(
      parsed.requirements.map((item) => item.description.replace(/\s+/g, ' ').trim()),
    )
    const merged = [...parsed.requirements]
    let changed = false
    for (const item of items) {
      const description = item.description.replace(/\s+/g, ' ').trim()
      if (!description || existingDescriptions.has(description)) continue
      const id = nextRequirementId(merged)
      const addition: SketchRequirement = {
        id,
        description,
        ...(item.origin ? { origin: item.origin } : {}),
      }
      merged.push(addition)
      existingDescriptions.add(description)
      changed = true
    }
    if (!changed) return parsed
    const updated: PrdBackplane = { ...parsed, requirements: merged }
    writeFileSync(path, renderPrdJson(updated), 'utf8')
    return updated
  } catch {
    return null
  }
}

export function renderPrdJson(backplane: PrdBackplane): string {
  return `${JSON.stringify(backplane, null, 2)}\n`
}

/** 向盘上 prd.json 按 id 更新功能项行为断言（2026-09-02 周计划 §5 P3：EARS 化回写）。
 * 读-改-写保留全部既有字段（含 user_confirmed_at/status/template_meta 等）；
 * 只接受盘上已有 id 的断言替换（不新增/删除功能项，F-001 锚点不变式）；
 * 空断言数组拒绝写入（防把断言清空）；失败返回 null 不抛错（fail-closed）。
 * 写盘链路陷阱 42 口径：id 内部化（只查不增）、用户确认事实保留、调用方负责 abort 检查。 */
export function updatePrdAssertions(
  projectId: string,
  assertionsByItem: Record<string, string[]>,
): PrdBackplane | null {
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const path = join(dir, 'prd.json')
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    if (!parsed || !Array.isArray(parsed.requirements)) return null
    let changed = false
    const requirements = parsed.requirements.map((item): SketchRequirement => {
      const next = assertionsByItem[item.id]
      if (!next || next.length === 0) return item
      changed = true
      return { ...item, behavior_assertions: next }
    })
    if (!changed) return parsed
    const updated: PrdBackplane = { ...parsed, requirements }
    writeFileSync(path, renderPrdJson(updated), 'utf8')
    return updated
  } catch {
    return null
  }
}

/** 读盘上 prd.json 的用户确认时间（损坏/缺失 → undefined），供重建时继承确认事实。 */
export function readPersistedUserConfirmedAt(dir: string): string | undefined {
  const path = join(dir, 'prd.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PrdBackplane
    return typeof parsed?.user_confirmed_at === 'string' ? parsed.user_confirmed_at : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取 UX 契约草图全文（§4.2）：契约存在且文件在盘时返回全文，否则 undefined（PRD-only）。
 * MVP 生成 / 修复共用——草图全文作为输入上下文不降采样。路径必须落在 documents 目录内
 * （防 prd.json 被篡改后越权读任意文件）。
 */
export function readUxContractSketch(projectId: string, backplane?: Pick<PrdBackplane, 'ux_contract'>): string | undefined {
  const contract = (backplane ?? readPrdBackplane(projectId)).ux_contract
  if (!contract) return undefined
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const path = join(dir, contract.sketch_rel_path)
  assertInsideDocumentsDir(dir, path)
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function renderPrdDraft(backplane: PrdBackplane, checkpoint: 'requirement_confirmed' | 'sketch_confirmed'): string {
  const items = backplane.requirements
  const list = items.map(renderRequirementLine).join('\n')
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((scope) => `- ${scope}`).join('\n')
    : '- 暂无'
  // 状态行如实：需求确认检查点时草图还没画，不得谎报「草图已确认」（线上 abb1a19f）
  const statusLine =
    checkpoint === 'requirement_confirmed'
      ? '> 状态：需求已确认，PRD 草案形成，等待裁判审查与用户过目。（checkpoint: requirement_confirmed）'
      : '> 状态：草图已确认，进入 MVP 生成前。（checkpoint: sketch_confirmed）'
  return `# ${backplane.name} · PRD 草案

${statusLine}

## 1. 产品定位

${backplane.positioning}

## 2. 用户故事与行为断言

${list}

## 3. 范围外（非目标）

${outOfScope}
${renderGuardrailsSection(backplane)}${renderUxContractSection(backplane)}
## 说明
- 本草案由确认后的草图需求生成（密背板：故事化功能项 + 行为断言 + 优先级）。
- 后续需求细化见对话历史。
`
}

export function renderPrdFull(backplane: PrdBackplane): string {
  const items = backplane.requirements
  const list = items.map(renderRequirementLine).join('\n')
  const featureRefs = items.map((item) => `- \`features/${item.id}.feature\``).join('\n')
  return `# ${backplane.name} · PRD（MVP 生成前）

> 状态：功能项已锁定，GWT 骨架已生成。（checkpoint: mvp_before_generation）
> 冻结时间：${backplane.frozen_at ?? '—'}

## 1. 产品定位

${backplane.positioning}

## 2. 用户故事与行为断言

${list}

## 3. 范围外（非目标）

${backplane.out_of_scope.length ? backplane.out_of_scope.map((scope) => `- ${scope}`).join('\n') : '- 无'}
${renderGuardrailsSection(backplane)}${renderUxContractSection(backplane)}
## 4. 验收（GWT）
每个 P0 功能项至少包含 1 个 GWT 场景（从行为断言派生），feature 文件位于 \`documents/{project_id}/features/\`：

${featureRefs}
`
}

/** 单条功能项的用户可读渲染（§3.4）：故事 + 行为断言 + 优先级 + 范围排除 + 执行状态。 */
function renderRequirementLine(item: SketchRequirement): string {
  // 活背板勾选态：implemented 勾选；其余判定以中文标签标注（GFM 只有 [ ]/[x] 两种）
  const checked = item.status === 'implemented' ? 'x' : ' '
  const statusSuffix = item.status && item.status !== 'implemented' ? `（${requirementStatusLabel(item.status)}）` : ''
  // 优先级只在显式存在时渲染：enrichment 守卫抑制后的条目 prd.json 本就无 priority 字段，
  // 渲染再补缺省 P2 会让「不确定不标」的守卫语义失效（线上 abb1a19f F-002/F-005）；
  // 逻辑侧（GWT/judge）仍用 requirementPriority() 缺省，不受影响
  const priorityLabel = item.priority ? `（${item.priority}）` : ''
  const lines = [`- [${checked}] **${item.id}**${priorityLabel}${requirementStory(item)}${statusSuffix}`]
  for (const assertion of requirementAssertions(item)) {
    lines.push(`  - 行为断言：${assertion}`)
  }
  if (item.scope_notes) lines.push(`  - 范围排除：${item.scope_notes}`)
  return lines.join('\n')
}

/** 生成护栏段（仅当 generation_guardrails 存在时渲染，§3.4）。 */
function renderGuardrailsSection(backplane: PrdBackplane): string {
  const guardrails = backplane.generation_guardrails
  if (!guardrails || (guardrails.must_do.length === 0 && guardrails.must_not_do.length === 0)) return ''
  const mustDo = guardrails.must_do.length ? guardrails.must_do.map((rule) => `- ${rule}`).join('\n') : '- 无'
  const mustNotDo = guardrails.must_not_do.length ? guardrails.must_not_do.map((rule) => `- ${rule}`).join('\n') : '- 无'
  return `
## 生成护栏

MUST DO：
${mustDo}

MUST NOT DO：
${mustNotDo}
`
}

/** 草图契约段（仅当 ux_contract 存在时渲染，§3.4/§4.2）。 */
function renderUxContractSection(backplane: PrdBackplane): string {
  if (!backplane.ux_contract) return ''
  return `
## 草图契约（UX 契约）

参考 \`${backplane.ux_contract.sketch_rel_path}\`（用户已于 ${backplane.ux_contract.confirmed_at} 确认）。
MVP 的布局/结构/样式以该草图为基准，不得低于草图精致度。
`
}

export function renderTestReportMount(requirements: SketchRequirement[], dir: string): string {
  // P2-11（2026-09-04）：mvp_tested.md 不再恒显「待写入」——writeTestReport 已先行落盘
  // test-report.json，这里读取真实结果渲染；无报告（测试未跑）如实写「待测试」，不冒充已测。
  const reportPath = join(dir, 'test-report.json')
  if (existsSync(reportPath)) {
    try {
      const result = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        total_count?: number
        passed_count?: number
        failed_count?: number
        failure_summary?: Array<{ scenario?: string; reason?: string }>
      }
      const total = result.total_count ?? 0
      const passed = result.passed_count ?? 0
      const failed = result.failed_count ?? 0
      const failures = (result.failure_summary ?? [])
        .map((f) => '- **' + (f.scenario ?? '') + '**：' + (f.reason ?? ''))
        .join('\n')
      const lines = ['# 测试报告', '', '> 状态：GWT 已执行。通过 ' + passed + '/' + total + '，未通过 ' + failed + ' 项。', '']
      if (failed > 0) lines.push('## 未通过项', '', failures || '- 无', '')
      return lines.join('\n')
    } catch {
      // 报告损坏：回退「待测试」文案，不伪造结果
    }
  }
  const items = readRequirements(requirements)
  const refs = items.map((item) => '- ' + item.id + '：待 GWT 执行后写入结果').join('\n')
  return ['# 测试报告', '', '> 状态：测试尚未执行，结果将在 GWT 执行后写入。', '', '## 期望覆盖', '', refs, ''].join('\n')
}

/**
 * 变更记录（追加式，用户裁决 2026-08-28，GA-03 P1）：每轮迭代完成后 append 一段历史条目
 * （时间戳 + 功能项变化 + 当前清单），累积成时间线；历史条目 append-only 永不改写。
 * 空清单时输出「本轮无功能项变更」，不套用 PRD 草案的 F-001 默认回退（避免伪造变更记录）。
 * 旧覆盖式遗留文件（无轮次编号）原样保留，新条目从「第 1 轮」起算。
 */
export function renderChangelog(requirements: SketchRequirement[], existing = ''): string {
  const entry = renderChangelogEntry(requirements, existing)
  if (existing.trim() === '') return `# 变更记录\n\n${entry}`
  return `${existing.trimEnd()}\n\n${entry}\n`
}

/** 单条历史条目：轮次编号按已有新格式条目数递增（旧格式无法归轮，从 1 起算） */
function renderChangelogEntry(requirements: SketchRequirement[], existing: string): string {
  const round = (existing.match(/^## \d{4}-/gm) ?? []).length + 1
  const timestamp = new Date().toISOString()
  const current = requirements.map((item) => ({ id: item.id, description: item.description }))
  const baseline = parseLastEntryItems(existing)
  const items =
    current.length > 0
      ? current.map((item) => `- ${item.id}：${item.description}`).join('\n')
      : '- 本轮无功能项变更'
  return `## ${timestamp}（第 ${round} 轮迭代）\n\n${renderChangeLine(baseline, current)}\n\n**当前功能项清单**：\n\n${items}`
}

/** 功能项变化行：相对上一条历史条目的 diff（新增/移除/变更）；首轮如实记录「首次记录」 */
function renderChangeLine(
  baseline: Array<{ id: string; description: string }> | null,
  current: Array<{ id: string; description: string }>,
): string {
  if (baseline === null) return `**功能项变化**：首次记录（${current.length} 项）`
  const added = current.filter((c) => !baseline.some((b) => b.id === c.id))
  const removed = baseline.filter((b) => !current.some((c) => c.id === b.id))
  const changed = current.filter((c) => {
    const prev = baseline.find((b) => b.id === c.id)
    return prev !== undefined && prev.description !== c.description
  })
  const parts = [
    ...added.map((i) => `新增 ${i.id}（${i.description}）`),
    ...removed.map((i) => `移除 ${i.id}（${i.description}）`),
    ...changed.map((i) => `变更 ${i.id}（→ ${i.description}）`),
  ]
  return `**功能项变化**：${parts.length > 0 ? parts.join('；') : '无'}`
}

/**
 * 解析现有 changelog 中最后一个连续功能项列表块（`- id：描述` 行）作为 diff 基线。
 * 兼容旧覆盖式格式（全文仅一个列表块）与新追加式格式（每条目一块，最后一块即最新基线）。
 * 全文无任何列表行 → null（首轮）；「本轮无功能项变更」无冒号分隔不匹配（空基线不伪造）。
 */
function parseLastEntryItems(existing: string): Array<{ id: string; description: string }> | null {
  const lines = existing.split('\n')
  let lastBlock: string[] = []
  let currentBlock: string[] = []
  for (const line of lines) {
    if (/^- (.+?)[:：]/.test(line)) {
      currentBlock.push(line)
    } else {
      if (currentBlock.length > 0) lastBlock = currentBlock
      currentBlock = []
    }
  }
  if (currentBlock.length > 0) lastBlock = currentBlock
  if (lastBlock.length === 0) return null
  return lastBlock.map((line) => {
    const match = line.match(/^- (.+?)[:：](.*)$/)
    return { id: (match?.[1] ?? '').trim(), description: (match?.[2] ?? '').trim() }
  })
}

export function renderModeUpgraded(projectName: string): string {
  return `# ${projectName} · 长期迭代模式

> 已升级为长期模式。（checkpoint: mode_upgraded）

- 已创建升级快照，可随时回滚。
- 后续迭代按 Sprint 规划执行，见 \`sprint/sprint-plan.md\`。
`
}

export function renderArchitecturePuml(projectName: string): string {
  return `@startuml
!theme plain
title ${projectName} 架构（长期模式）

[用户] --> (MVP 前端)
(MVP 前端) --> (本地状态 localStorage)
(MVP 前端) --> (静态服务 static-server)
@enduml
`
}

export function renderSprintPlan(projectName: string): string {
  return `# ${projectName} · Sprint 规划

> 长期模式：每轮迭代按「草图 → 确认 → MVP → 测试 → 裁判」闭环推进。

## 当前 Sprint
- 目标：验证核心 P0 功能项可用。
- GWT 覆盖：每个功能项至少 1 个场景。
- 裁判阈值：quick 2 次退回 / longterm 3 次退回（A2-11）。
`
}

/**
 * GWT 骨架：按 PRD 背板生成 Gherkin feature 文件（确定性模板，不依赖 LLM）。
 *
 * M3（§7.4）：场景从 behavior_assertions 派生——每条断言一个 Scenario
 * （When=触发器、Then=效果，来自 behavior-assertions 词表解析），解析不出
 * 触发/效果的断言（含默认断言）落「核心路径可运行」存在性骨架；边界/异常
 * 两条鲁棒性场景保留。运行时的真实行为验证由 gwt-runner 在产物预览上执行。
 */
export function renderGwtSkeleton(
  backplane: PrdBackplane,
  /** 注入点⑦（周计划 §6）：模式与等级（必测类别清单路由）；缺省不标注（现状） */
  mode?: import('../../shared/types').ProjectMode,
): Array<{ fileName: string; content: string }> {
  const templateType = backplane.template_meta?.type
  const requiredCategories =
    mode
      ? gwtRequiredCategories(mode, backplane.template_meta?.level === 'loose' ? 'loose' : 'standard', templateType)
      : []
  return readRequirements(backplane.requirements).map((item) => {
    const id = safeFileName(item.id)
    const acceptance = backplane.acceptance[item.id] ?? `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
    return {
      fileName: `${id}.feature`,
      content: renderFeatureFile(item, acceptance, requiredCategories, templateType),
    }
  })
}

/** EARS 句式 → GWT 场景类别标签（注入⑦：WHEN=主路径 / WHILE=空态 / IF=异常，词表同源）。 */
function categoryTagOf(kind: import('../guide/ears-vocabulary').EarsPatternKind): string {
  if (kind === 'while') return '[空态]'
  if (kind === 'if') return '[异常]'
  return '[主路径]'
}

/** W5（2026-09-18 本月流水账案）：数据留存语义词——功能项含这些词时，存在性兜底升级为
 *  行为场景（重开后数据仍在），否则 F-006 类「数据保存本机」会被「可见且可交互」糊弄过关
 *  （当天 7/9 场景存在性断言假绿的直接成因）。词表与 deriveInterfaceSpec 留存信号司源不同用途：
 *  这里只收「重开/刷新后仍在」的行为可验证语义，收窄防误伤。 */
const DATA_RETENTION_RE = /重新打开|关闭[^。]{0,6}(?:页面|窗口|应用)?[^。]{0,4}(?:仍|还)|刷新[^。]{0,8}(?:仍|还)|(?:仍|还)在|不丢失|留存|保存后|持久/

function renderFeatureFile(item: SketchRequirement, acceptance: string, requiredCategories: string[] = [], type?: TemplateType): string {
  const title = shortTitle(item.description)
  const categoryHeader = requiredCategories.length
    ? `
  # 必测类别（工程模板测试策略）：${requiredCategories.join(' / ')}
`
    : ''
  const scenarios: string[] = []
  for (const assertion of requirementAssertions(item)) {
    const plan = parseBehaviorAssertion(assertion)
    // 注入点⑦：EARS 句式类别标注（WHEN=主路径 / WHILE=空态 / IF=异常——词表同源）
    const ears = parseEarsAssertion(assertion)
    const categoryTag = ears.explicitPrefix ? categoryTagOf(ears.kind) : ''
    if (plan.presenceFallback || !plan.trigger || !plan.effect) {
      // W5：留存语义断言禁用存在性兑底——升级为「重开后数据仍在」行为场景
      if (DATA_RETENTION_RE.test(assertion) || DATA_RETENTION_RE.test(item.description)) {
        scenarios.push([
          `  Scenario: 数据留存行为${categoryTag}（${assertion}）`,
          `    Given 已进入 ${title} 功能页面且已存在用户保存的数据`,
          `    When 重新加载页面（关闭后重新打开）`,
          `    Then 原有数据仍然显示且可用`,
        ].join('\n'))
      } else {
        scenarios.push([
          `  Scenario: 核心路径可运行${categoryTag}（${assertion}）`,
          `    Given 已进入 ${title} 功能页面`,
          `    When 我执行核心操作`,
          `    Then 页面返回预期结果`,
        ].join('\n'))
      }
    } else {
      scenarios.push([
        `  Scenario: ${categoryTag ? `${categoryTag}：` : ''}${assertion}`,
        `    Given 已进入 ${title} 功能页面`,
        `    When ${describeTrigger(plan.trigger)}`,
        `    Then ${describeEffect(plan.effect)}`,
      ].join('\n'))
    }
  }
  scenarios.push(...robustnessScenarios(title, type))
  return `# GWT 骨架（由 DocumentEngine 生成，场景从行为断言派生，GWTTestRunner 执行）
Feature: ${title}${categoryHeader}

  As a 用户
  I want ${requirementStory(item)}
  So that 能完成核心目标

${scenarios.join('\n\n')}

  # 验收要点：${acceptance}
`
}

/**
 * 鲁棒性兜底场景（P1-9，2026-09-04）：game 换成玩法边界（状态机/碰撞/胜负），
 * 非 game 保持边界/异常输入——「边界输入不崩溃/异常输入不崩溃」对游戏是空转场景。
 */
function robustnessScenarios(title: string, type: TemplateType | undefined): string[] {
  if (type === 'game') {
    return [
      [
        `  Scenario: 状态机切换不卡死`,
        `    Given 已进入 ${title} 功能页面`,
        `    When 我在主菜单 / 进行中 / 暂停 / 结束之间切换`,
        `    Then 状态切换正确且不卡死`,
      ].join('\n'),
      [
        `  Scenario: 碰撞反馈正确`,
        `    Given 已进入 ${title} 功能页面`,
        `    When 发生碰撞`,
        `    Then 正确得分或扣血且无异常`,
      ].join('\n'),
      [
        `  Scenario: 胜负边界判定正确`,
        `    Given 已进入 ${title} 功能页面`,
        `    When 生命归零或分数达标`,
        `    Then 进入对应结局并显示结算`,
      ].join('\n'),
    ]
  }
  return [
    [
      `  Scenario: 边界输入不崩溃`,
      `    Given 已进入 ${title} 功能页面`,
      `    When 我输入边界值`,
      `    Then 页面不崩溃并给出可理解的反馈`,
    ].join('\n'),
    [
      `  Scenario: 异常输入不崩溃`,
      `    Given 已进入 ${title} 功能页面`,
      `    When 我输入异常内容`,
      `    Then 页面不崩溃并给出可理解的反馈`,
    ].join('\n'),
  ]
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'feature'
}

function shortTitle(description: string): string {
  const trimmed = description.replace(/\s+/g, ' ').trim()
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed
}

/** 读文档清单（T7 快照回看复用：platform-services 从归档目录读同一份 manifest）。 */
export function readDocumentsManifest(dir: string): ManifestEntry[] {
  return readManifest(dir)
}

export function readManifest(dir: string): ManifestEntry[] {
  const path = join(dir, '.document-manifest.json')
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { documents?: ManifestEntry[] }
    return Array.isArray(raw.documents) ? raw.documents : []
  } catch {
    return []
  }
}

export function writeManifest(dir: string, entries: ManifestEntry[]): void {
  writeFileSync(join(dir, '.document-manifest.json'), `${JSON.stringify({ version: 1, documents: entries }, null, 2)}\n`, 'utf8')
}

// ---- W2 E2+F1（咨询 D3/D4，2026-09-09）：loop-checkpoint 持久化 ----
// documents/loop-checkpoint.json：runtime=loop 运行时投影（E3 事件驱动，每次覆盖），
// repair_attempts=修复尝试账本（repairAndRetest 每轮追加，F1 修复证据包的历史维度）。
// 与 loop-log.md 同一目录与直写模式（不走 checkpoint 产出路径，不进文档清单）。

/** 修复轮尝试记录：改了什么 + 与上轮的结果对比（resolved/persistent/new_failures）。 */
export interface LoopRepairAttemptRecord {
  round: number
  at: string
  task_locations: string[]
  files_touched: string[]
  outcome: { resolved: string[]; persistent: string[]; new_failures: string[]; converged: boolean }
}

/** loop-checkpoint.json 落盘结构（version 1）。 */
export interface LoopCheckpointDocument {
  version: 1
  project_id: string
  updated_at: string
  /** loop 运行时投影（主 loop / 修复轮 onCheckpoint 推送，后到覆盖） */
  runtime?: import('../agent/loop/agent-loop').LoopCheckpointSnapshot
  repair_attempts: LoopRepairAttemptRecord[]
}

export function readLoopCheckpointDocument(projectId: string): LoopCheckpointDocument | null {
  const project = findProject(projectId)
  const path = join(getDocumentsDir(project.workspace_slug, project.project_id), 'loop-checkpoint.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LoopCheckpointDocument
    return raw && raw.version === 1 && Array.isArray(raw.repair_attempts) ? raw : null
  } catch {
    return null
  }
}

export function writeLoopCheckpointDocument(projectId: string, doc: LoopCheckpointDocument): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'loop-checkpoint.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}
