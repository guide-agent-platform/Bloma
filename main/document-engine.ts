import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DocumentRef, DocumentSyncInput, DocumentSyncResult } from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import type { SketchRequirement } from './sketch-engine'

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

export function syncDocuments(input: DocumentSyncInput): DocumentSyncResult {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const requirements = readLastSketchRequirements(input.project_id)
  const previous = readManifest(dir)

  const documents: DocumentRef[] = []
  const files: Array<{ relativePath: string; content: string; type: DocumentRef['type'] }> = []

  switch (input.checkpoint) {
    case 'sketch_confirmed':
      files.push({ relativePath: 'sketch_confirmed.md', content: renderPrdDraft(project.name, requirements), type: 'prd' })
      break
    case 'mvp_before_generation':
      files.push({
        relativePath: 'mvp_before_generation.md',
        content: renderPrdFull(project.name, requirements),
        type: 'prd',
      })
      files.push(...renderGwtSkeleton(requirements).map((feature) => ({
        relativePath: `features/${feature.fileName}`,
        content: feature.content,
        type: 'gwt_feature' as const,
      })))
      break
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

/** 读取需求清单；为空时回退到默认功能项，保证文档始终可读。 */
function readRequirements(requirements: SketchRequirement[]): SketchRequirement[] {
  if (requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个可运行、可操作的功能页面。' }]
}

function renderPrdDraft(projectName: string, requirements: SketchRequirement[]): string {
  const items = readRequirements(requirements)
  const list = items.map((item) => `- [ ] **${item.id}** ${item.description}`).join('\n')
  return `# ${projectName} · PRD 草案

> 状态：草图已确认，进入 MVP 生成前。（checkpoint: sketch_confirmed）

## 核心功能项

${list}

## 说明
- 本草案由确认后的草图需求生成，供 MVP 模板与 GWT 骨架使用。
- 后续需求细化见对话历史（A2-06 顺延项）。
`
}

function renderPrdFull(projectName: string, requirements: SketchRequirement[]): string {
  const items = readRequirements(requirements)
  const list = items.map((item) => `- [x] **${item.id}** ${item.description}`).join('\n')
  const featureRefs = items.map((item) => `- \`features/${item.id}.feature\``).join('\n')
  return `# ${projectName} · PRD（MVP 生成前）

> 状态：功能项已锁定，GWT 骨架已生成。（checkpoint: mvp_before_generation）

## 完整功能项

${list}

## GWT 骨架
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

/** GWT 骨架：按需求清单生成 Gherkin feature 文件（确定性模板，不依赖 LLM）。 */
export function renderGwtSkeleton(
  requirements: SketchRequirement[],
): Array<{ fileName: string; content: string }> {
  return readRequirements(requirements).map((item) => {
    const id = safeFileName(item.id)
    const title = shortTitle(item.description)
    return {
      fileName: `${id}.feature`,
      content: `# GWT 骨架（由 DocumentEngine 生成，GWTTestRunner 执行）
Feature: ${title}

  As a 用户
  I want ${item.description}
  So that 能完成核心目标

  Scenario: 核心路径可运行
    Given 已进入 ${title} 功能页面
    When 我执行核心操作
    Then 页面返回预期结果
`,
    }
  })
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
