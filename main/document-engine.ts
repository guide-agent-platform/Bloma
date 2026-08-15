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
 * 组装 PRD 背板（快消型的唯一需求事实源）。
 *
 * - positioning 取 F-001（主题锚点，改造 A 已保证 F-001 是用户最初想做什么）；
 * - acceptance 由确定性规则生成默认验收要点（GWT 派生源，改造 D 消费）；
 * - out_of_scope / assumptions 在草案阶段留空，由后续生成回填（改造 C）。
 * - mvp_before_generation 时冻结（落盘 frozen_at），此后编程管线只读冻结版。
 */
export function buildPrdBackplane(
  project: Project,
  requirements: SketchRequirement[],
  checkpoint: DocumentSyncInput['checkpoint'],
): PrdBackplane {
  const items = readRequirements(requirements)
  const acceptance: Record<string, string> = {}
  for (const item of items) {
    acceptance[item.id] = `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  return {
    project_id: project.project_id,
    name: project.name,
    positioning: items[0]?.description ?? project.name,
    requirements: items,
    acceptance,
    out_of_scope: [],
    assumptions: [],
    ...(checkpoint === 'mvp_before_generation' ? { frozen_at: new Date().toISOString() } : {}),
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
    out_of_scope: [],
    assumptions: [],
  }
}

function renderPrdJson(backplane: PrdBackplane): string {
  return `${JSON.stringify(backplane, null, 2)}\n`
}

function renderPrdDraft(backplane: PrdBackplane): string {
  const items = backplane.requirements
  const list = items.map((item) => `- [ ] **${item.id}** ${item.description}`).join('\n')
  const acceptance = items
    .map((item) => `- **${item.id}**：${backplane.acceptance[item.id] ?? ''}`)
    .join('\n')
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((scope) => `- ${scope}`).join('\n')
    : '- 暂无'
  return `# ${backplane.name} · PRD 草案

> 状态：草图已确认，进入 MVP 生成前。（checkpoint: sketch_confirmed）

## 1. 产品定位

${backplane.positioning}

## 2. 核心功能项

${list}

## 3. 验收标准

${acceptance}

## 4. 范围外（非目标）

${outOfScope}

## 5. 说明
- 本草案由确认后的草图需求生成，供 MVP 生成与 GWT 骨架使用。
- 后续需求细化见对话历史。
`
}

function renderPrdFull(backplane: PrdBackplane): string {
  const items = backplane.requirements
  const list = items.map((item) => `- [x] **${item.id}** ${item.description}`).join('\n')
  const featureRefs = items.map((item) => `- \`features/${item.id}.feature\``).join('\n')
  return `# ${backplane.name} · PRD（MVP 生成前）

> 状态：功能项已锁定，GWT 骨架已生成。（checkpoint: mvp_before_generation）
> 冻结时间：${backplane.frozen_at ?? '—'}

## 1. 产品定位

${backplane.positioning}

## 2. 完整功能项

${list}

## 3. 验收标准

${items.map((item) => `- **${item.id}**：${backplane.acceptance[item.id] ?? ''}`).join('\n')}

## 4. GWT 骨架
每个 P0 功能项至少包含 1 个 GWT 场景，feature 文件位于 \`documents/{project_id}/features/\`：

${featureRefs}
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

/** GWT 骨架：按 PRD 背板生成 Gherkin feature 文件（确定性模板，不依赖 LLM）。 */
export function renderGwtSkeleton(
  backplane: PrdBackplane,
): Array<{ fileName: string; content: string }> {
  return readRequirements(backplane.requirements).map((item) => {
    const id = safeFileName(item.id)
    const title = shortTitle(item.description)
    const acceptance = backplane.acceptance[item.id] ?? `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
    return {
      fileName: `${id}.feature`,
      content: renderFeatureFile(id, title, item.description, acceptance),
    }
  })
}

/**
 * 每个功能项生成「正常路径 + 边界 + 异常」三条场景（对齐 PRD §11.3）。
 * 场景是确定性骨架（快消型无浏览器执行器，实际断言由 gwt-service 的
 * hasInteractiveEntry / 原文匹配兜底），但保证每个 P0 功能项覆盖三类路径。
 */
function renderFeatureFile(id: string, title: string, description: string, acceptance: string): string {
  return `# GWT 骨架（由 DocumentEngine 生成，GWTTestRunner 执行）
Feature: ${title}

  As a 用户
  I want ${description}
  So that 能完成核心目标

  Scenario: 核心路径可运行
    Given 已进入 ${title} 功能页面
    When 我执行核心操作
    Then 页面返回预期结果

  Scenario: 边界输入不崩溃
    Given 已进入 ${title} 功能页面
    When 我输入边界值
    Then 页面不崩溃并给出可理解的反馈

  Scenario: 异常输入不崩溃
    Given 已进入 ${title} 功能页面
    When 我输入异常内容
    Then 页面不崩溃并给出可理解的反馈

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
