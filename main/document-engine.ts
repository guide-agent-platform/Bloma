import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DocumentReadResult,
  DocumentRef,
  DocumentSyncInput,
  DocumentSyncResult,
  Project,
} from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import type { PrdBackplane, SketchRequirement } from './sketch-engine'
import { requirementAssertions, requirementPriority, requirementStory } from './sketch-engine'
import { describeEffect, describeTrigger, parseBehaviorAssertion } from './behavior-assertions'

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

export function syncDocuments(input: DocumentSyncInput, backplaneOverride?: PrdBackplane): DocumentSyncResult {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const requirements = readLastSketchRequirements(input.project_id)
  const previous = readManifest(dir)

  const documents: DocumentRef[] = []
  const files: Array<{ relativePath: string; content: string; type: DocumentRef['type'] }> = []

  switch (input.checkpoint) {
    case 'requirement_confirmed': {
      // PRD 前移检查点（2026-08-26）：需求确认弹窗通过后立即形成 PRD，早于草图；
      // 草图确认检查点（sketch_confirmed）会基于 readPrdBackplane 合并重写，不冲突
      const backplane = backplaneOverride ?? buildPrdBackplane(project, requirements, input.checkpoint)
      files.push(
        { relativePath: 'requirement_confirmed.md', content: renderPrdDraft(backplane), type: 'prd' },
        { relativePath: 'prd.json', content: renderPrdJson(backplane), type: 'prd' },
      )
      break
    }
    case 'sketch_confirmed': {
      const backplane = backplaneOverride ?? buildPrdBackplane(project, requirements, input.checkpoint)
      files.push(
        { relativePath: 'sketch_confirmed.md', content: renderPrdDraft(backplane), type: 'prd' },
        { relativePath: 'prd.json', content: renderPrdJson(backplane), type: 'prd' },
      )
      break
    }
    case 'mvp_before_generation': {
      const backplane = backplaneOverride ?? buildPrdBackplane(project, requirements, input.checkpoint)
      files.push({
        relativePath: 'mvp_before_generation.md',
        content: renderPrdFull(backplane),
        type: 'prd',
      })
      files.push(...renderGwtSkeleton(backplane).map((feature) => ({
        relativePath: `features/${feature.fileName}`,
        content: feature.content,
        type: 'gwt_feature' as const,
      })))
      break
    }
    case 'mvp_tested':
      files.push({
        relativePath: 'mvp_tested.md',
        content: renderTestReportMount(requirements),
        type: 'test_report',
      })
      break
    case 'iteration_completed':
      files.push({ relativePath: 'iteration_completed.md', content: renderChangelog(), type: 'changelog' })
      break
    case 'mode_upgraded':
      files.push({ relativePath: 'mode_upgraded.md', content: renderModeUpgraded(project.name), type: 'user_story' })
      break
  }

  // 模式分支：长期模式额外产出 PlantUML + Sprint 文档
  if (project.mode === 'longterm') {
    files.push(
      { relativePath: 'plantuml/architecture.puml', content: renderArchitecturePuml(project.name), type: 'plantuml' },
      { relativePath: 'sprint/sprint-plan.md', content: renderSprintPlan(project.name), type: 'user_story' },
    )
  }

  for (const file of files) {
    const absolute = join(dir, file.relativePath)
    // 子目录（features/ plantuml/ sprint/）需显式创建
    if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.content, 'utf8')
    documents.push({
      document_id: randomUUID(),
      type: file.type,
      path: absolute,
      status: 'synced',
    })
  }

  // 清单：被本次同步覆盖（同 path 再次产出）的旧文档标记为 stale
  const newPaths = new Set(files.map((file) => join(dir, file.relativePath)))
  const staleDocuments: DocumentRef[] = previous
    .filter((entry) => entry.status === 'synced' && newPaths.has(entry.path))
    .map((entry) => ({ document_id: entry.document_id, type: entry.type, path: entry.path, status: 'stale' as const }))

  const untouched = previous.filter((entry) => !newPaths.has(entry.path))
  writeManifest(dir, [
    ...untouched,
    ...staleDocuments.map((doc) => ({ ...doc, checkpoint: doc.type, type: doc.type })),
    ...documents.map((doc) => ({
      document_id: doc.document_id,
      path: doc.path,
      type: doc.type,
      checkpoint: input.checkpoint,
      status: doc.status,
    })),
  ])

  return { documents, stale_documents: staleDocuments }
}

/**
 * U2：列出项目已产出的文档（跳过 stale 被覆盖的旧版本）。
 * 数据源是 document-engine 写盘时维护的 `.document-manifest.json`。
 */
export function listDocuments(projectId: string): DocumentRef[] {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  return readManifest(dir)
    .filter((entry) => entry.status !== 'stale')
    .map((entry) => ({
      document_id: entry.document_id,
      type: entry.type,
      path: entry.path,
      status: entry.status,
    }))
}

/**
 * A3 安全扫描报告写盘 + 清单登记（幂等，按 path 去重）。
 * markdown 内容由 security-scan.ts 渲染，这里只负责落盘与清单登记，使文档面板
 * （document:list）能看到并读取 security-scan.md。
 */
export function writeSecurityScanDocument(projectId: string, markdown: string): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'security-scan.md')
  writeFileSync(path, markdown, 'utf8')
  const previous = readManifest(dir)
  if (previous.some((entry) => entry.path === path)) return
  writeManifest(dir, [
    ...previous,
    { document_id: 'security-scan', path, type: 'test_report', checkpoint: 'security_scan', status: 'synced' },
  ])
}

/**
 * 把 decision-log 直写的 decisions.md 登记进文档清单（幂等，按 path 去重），
 * 使文档面板（document:list）能看到并读取它。syncDocuments 重建清单时
 * decisions.md 不与其产出路径重叠，条目会作为 untouched 一直保留。
 */
export function registerDecisionsDocument(projectId: string): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const path = join(dir, 'decisions.md')
  const previous = readManifest(dir)
  if (previous.some((entry) => entry.path === path)) return
  writeManifest(dir, [
    ...previous,
    { document_id: 'decisions-log', path, type: 'decisions', checkpoint: 'decisions', status: 'synced' },
  ])
}

/**
 * U2：读取单个文档内容。路径安全防护——文档路径必须落在项目 documents 目录内，
 * 防止清单被篡改后越权读取磁盘任意文件。
 */
export function readDocument(projectId: string, documentId: string): DocumentReadResult {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const entry = readManifest(dir).find((item) => item.document_id === documentId)
  if (!entry) throw new Error('DOCUMENT_NOT_FOUND')
  assertInsideDocumentsDir(dir, entry.path)
  if (!existsSync(entry.path)) throw new Error('DOCUMENT_NOT_FOUND')
  return {
    document: {
      document_id: entry.document_id,
      type: entry.type,
      path: entry.path,
      status: entry.status,
    },
    content: readFileSync(entry.path, 'utf8'),
  }
}

/** 文档路径必须落在项目 documents 目录内（对齐 project-service 的路径安全校验）。 */
function assertInsideDocumentsDir(dir: string, target: string): void {
  const root = resolve(dir)
  const resolved = resolve(target)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`DOCUMENT_PATH_SAFETY: path outside documents dir: ${target}`)
  }
}

/** 读取需求清单；为空时回退到默认功能项，保证文档始终可读。 */
function readRequirements(requirements: SketchRequirement[]): SketchRequirement[] {
  if (requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个可运行、可操作的功能页面。' }]
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
  return {
    project_id: project.project_id,
    name: project.name,
    positioning: items[0]?.description ?? project.name,
    requirements: items,
    acceptance,
    out_of_scope: [...new Set(project.scope_exclusions ?? [])],
    // 用户约束常驻注入（T4-L1）：project.constraints 是唯一写入源（澄清门/修改门
    // 确定性提取），背板只做组装——不在这里引入第二个事实源
    ...(project.constraints?.length ? { constraints: [...new Set(project.constraints)] } : {}),
    assumptions: [],
    ...(checkpoint === 'mvp_before_generation' ? { frozen_at: new Date().toISOString() } : {}),
  }
}

/**
 * 构建侧归一化（§10 兼容）：把薄形态（仅 id+description）物化为厚形态。
 * 缺省值与读取侧 helper（requirementStory 等）一致，落盘后下游无需再判空。
 */
function normalizeRequirement(item: SketchRequirement): SketchRequirement {
  return {
    ...item,
    story: requirementStory(item),
    behavior_assertions: requirementAssertions(item),
    priority: requirementPriority(item),
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

function renderPrdJson(backplane: PrdBackplane): string {
  return `${JSON.stringify(backplane, null, 2)}\n`
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

function renderPrdDraft(backplane: PrdBackplane): string {
  const items = backplane.requirements
  const list = items.map(renderRequirementLine).join('\n')
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((scope) => `- ${scope}`).join('\n')
    : '- 暂无'
  return `# ${backplane.name} · PRD 草案

> 状态：草图已确认，进入 MVP 生成前。（checkpoint: sketch_confirmed）

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

function renderPrdFull(backplane: PrdBackplane): string {
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

/** 单条功能项的用户可读渲染（§3.4）：故事 + 行为断言 + 优先级 + 范围排除。 */
function renderRequirementLine(item: SketchRequirement): string {
  const lines = [`- [ ] **${item.id}**（${requirementPriority(item)}）${requirementStory(item)}`]
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

function renderTestReportMount(requirements: SketchRequirement[]): string {
  const items = readRequirements(requirements)
  const refs = items.map((item) => `- ${item.id}：待 GWT 执行后写入结果`).join('\n')
  return `# 测试报告（挂载）

> 状态：MVP 已进入测试阶段，报告本体由 GWT 执行（A2-07）唯一写盘。（checkpoint: mvp_tested）

## 期望覆盖

${refs}

## Schema（对齐 api-spec §12.4 run_gwt_tests）
- \`total_count\` / \`passed_count\` / \`failed_count\`
- \`failure_summary\`: [{ scenario, reason }]
`
}

function renderChangelog(): string {
  return `# 变更记录

> 一次迭代已完成。（checkpoint: iteration_completed）

- 快照已回滚/确认，项目进入新一轮迭代。
`
}

function renderModeUpgraded(projectName: string): string {
  return `# ${projectName} · 长期迭代模式

> 已升级为长期模式。（checkpoint: mode_upgraded）

- 已创建升级快照，可随时回滚。
- 后续迭代按 Sprint 规划执行，见 \`sprint/sprint-plan.md\`。
`
}

function renderArchitecturePuml(projectName: string): string {
  return `@startuml
!theme plain
title ${projectName} 架构（长期模式）

[用户] --> (MVP 前端)
(MVP 前端) --> (本地状态 localStorage)
(MVP 前端) --> (静态服务 static-server)
@enduml
`
}

function renderSprintPlan(projectName: string): string {
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
): Array<{ fileName: string; content: string }> {
  return readRequirements(backplane.requirements).map((item) => {
    const id = safeFileName(item.id)
    const acceptance = backplane.acceptance[item.id] ?? `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
    return {
      fileName: `${id}.feature`,
      content: renderFeatureFile(item, acceptance),
    }
  })
}

function renderFeatureFile(item: SketchRequirement, acceptance: string): string {
  const title = shortTitle(item.description)
  const scenarios: string[] = []
  for (const assertion of requirementAssertions(item)) {
    const plan = parseBehaviorAssertion(assertion)
    if (plan.presenceFallback || !plan.trigger || !plan.effect) {
      scenarios.push([
        `  Scenario: 核心路径可运行（${assertion}）`,
        `    Given 已进入 ${title} 功能页面`,
        `    When 我执行核心操作`,
        `    Then 页面返回预期结果`,
      ].join('\n'))
    } else {
      scenarios.push([
        `  Scenario: ${assertion}`,
        `    Given 已进入 ${title} 功能页面`,
        `    When ${describeTrigger(plan.trigger)}`,
        `    Then ${describeEffect(plan.effect)}`,
      ].join('\n'))
    }
  }
  scenarios.push(
    [
      `  Scenario: 边界输入不崩溃`,
      `    Given 已进入 ${title} 功能页面`,
      `    When 我输入边界值`,
      `    Then 页面不崩溃并给出可理解的反馈`,
    ].join('\n'),
  )
  scenarios.push(
    [
      `  Scenario: 异常输入不崩溃`,
      `    Given 已进入 ${title} 功能页面`,
      `    When 我输入异常内容`,
      `    Then 页面不崩溃并给出可理解的反馈`,
    ].join('\n'),
  )
  return `# GWT 骨架（由 DocumentEngine 生成，场景从行为断言派生，GWTTestRunner 执行）
Feature: ${title}

  As a 用户
  I want ${requirementStory(item)}
  So that 能完成核心目标

${scenarios.join('\n\n')}

  # 验收要点：${acceptance}
`
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

function readManifest(dir: string): ManifestEntry[] {
  const path = join(dir, '.document-manifest.json')
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { documents?: ManifestEntry[] }
    return Array.isArray(raw.documents) ? raw.documents : []
  } catch {
    return []
  }
}

function writeManifest(dir: string, entries: ManifestEntry[]): void {
  writeFileSync(join(dir, '.document-manifest.json'), `${JSON.stringify({ version: 1, documents: entries }, null, 2)}\n`, 'utf8')
}
