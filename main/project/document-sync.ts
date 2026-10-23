/**
 * 文档同步与文档 IO（PR4d 自 document-engine 拆出）：syncDocuments 全量同步、
 * 文档清单/读取、安全扫描/意图清单/视觉审计/计划文档写入、loop log、决策文档。
 * 纯机械搬移；对外契约经 document-engine re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DocumentReadResult, DocumentRef, DocumentSyncInput, DocumentSyncResult } from '../../shared/types';
import { getDocumentsDir } from '../../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'

import type { PrdBackplane, SketchRequirement } from "../model/prd-backplane";







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

import { buildPrdBackplane, readManifest, writeManifest, renderPrdJson, renderPrdDraft, renderPrdFull, renderTestReportMount, renderGwtSkeleton, renderChangelog, renderModeUpgraded, renderArchitecturePuml, renderSprintPlan, readPersistedUserConfirmedAt } from './prd-store';

export function syncDocuments(input: DocumentSyncInput, backplaneOverride?: PrdBackplane): DocumentSyncResult {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const requirements = readLastSketchRequirements(input.project_id)
  const previous = readManifest(dir)

  const documents: DocumentRef[] = []
  const files: Array<{ relativePath: string; content: string; type: DocumentRef['type'] }> = []

  if (backplaneOverride?.lean_brief) {
    const brief = backplaneOverride
    files.push({ relativePath: 'prd.json', content: renderPrdJson(brief), type: 'prd' },
      { relativePath: 'task.md', content: [brief.positioning, ...brief.requirements.map(row => `${row.id} ${row.description}\n完成应看到：${brief.acceptance[row.id] ?? ''}`),
        ...(brief.constraints ?? []), ...brief.out_of_scope.map(text => `不做：${text}`)].join('\n\n'), type: 'prd' })
  } else {
  switch (input.checkpoint) {
    case 'requirement_confirmed': {
      // PRD 前移检查点（2026-08-26）：需求确认弹窗通过后立即形成 PRD，早于草图；
      // 草图确认检查点（sketch_confirmed）会基于 readPrdBackplane 合并重写，不冲突
      const backplane = backplaneOverride ?? buildPrdBackplane(project, requirements, input.checkpoint)
      files.push(
        { relativePath: 'requirement_confirmed.md', content: renderPrdDraft(backplane, 'requirement_confirmed'), type: 'prd' },
        { relativePath: 'prd.json', content: renderPrdJson(backplane), type: 'prd' },
      )
      break
    }
    case 'sketch_confirmed': {
      const backplane = backplaneOverride ?? buildPrdBackplane(project, requirements, input.checkpoint)
      // 用户确认事实继承（2026-08-29 线上）：PRD 确认（markPrdUserConfirmed 落
      // user_confirmed_at）后用户点「生成完整功能」进入本检查点，此处全量重建
      // prd.json 若不带盘上确认标记，isPrdUserConfirmed 即 fail-closed 误判「未确认」
      // ——交付后的点选纠错/迭代全部被踢回确认流，而确认卡不会再发，通道死局
      // （线上案例：MVP 已交付，点选「太丑」被拒）。确认是用户行为事实而非产物
      // 判定，重建必须继承；requirement_confirmed 分支刻意不继承（修订闭环重写时
      // 「新 PRD 未确认」语义自洽，新确认卡会重新落盘）。
      const confirmedAt = readPersistedUserConfirmedAt(dir)
      files.push(
        { relativePath: 'sketch_confirmed.md', content: renderPrdDraft(backplane, 'sketch_confirmed'), type: 'prd' },
        {
          relativePath: 'prd.json',
          content: renderPrdJson(confirmedAt ? { ...backplane, user_confirmed_at: confirmedAt } : backplane),
          type: 'prd',
        },
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
      files.push(...renderGwtSkeleton(backplane, project.mode).map((feature) => ({
        relativePath: `features/${feature.fileName}`,
        content: feature.content,
        type: 'gwt_feature' as const,
      })))
      break
    }
    case 'mvp_tested':
      files.push({
        relativePath: 'mvp_tested.md',
        content: renderTestReportMount(requirements, dir),
        type: 'test_report',
      })
      break
    case 'iteration_completed': {
      // 追加式 changelog（用户裁决 2026-08-28，GA-03 P1）：读现有文件，末尾 append 历史条目，
      // append-only 永不改写（PRD §7.1「每轮迭代结束后追加 Changelog」字面语义）
      const changelogPath = join(dir, 'iteration_completed.md')
      const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
      files.push({
        relativePath: 'iteration_completed.md',
        content: renderChangelog(requirements, existingChangelog),
        type: 'changelog',
      })
      break
    }
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

  // 清单：被本次同步覆盖（同 path 再次产出）的旧文档标记为 stale。
  // 豁免 type 'loop_log'（P3 append-only 过程日志：无「过期重写」语义，防御纵深——
  // 结构上 loop-log.md 也从不与 checkpoint 产出路径重叠，双重保险，测试锁定）。
  const newPaths = new Set(files.map((file) => join(dir, file.relativePath)))
  const staleDocuments: DocumentRef[] = previous
    .filter((entry) => entry.status === 'synced' && entry.type !== 'loop_log' && newPaths.has(entry.path))
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
 * L1 视觉审计报告写盘 + 清单登记（幂等，按 path 去重；对齐 security-scan 先例）。
 * 使文档面板能看到双视觉互证全文（V1 详述 + V2 纠正），裁判摘要另经 testSummary 注入。
 */
/**
 * L1 结构化问题落盘（vision-audit.json）：给**编程模型**消费的问题清单（带 bbox 证据）。
 * 与 vision-audit.md（人读报告）同目录同检查点；修复轮组装 RepairTask 时读取本文件。
 */
/**
 * 意图清单落盘（intent-list.json，裁定第 2 步）：视觉审计的基准，人工可审。
 * 带 backplane_hash，背板更新即失效（intentListFresh 判定）。
 */
export function writeIntentListDocument(projectId: string, json: string): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'intent-list.json')
  writeFileSync(path, json, 'utf8')
  const previous = readManifest(dir)
  if (previous.some((entry) => entry.path === path)) return
  writeManifest(dir, [
    ...previous,
    { document_id: 'intent-list', path, type: 'test_report', checkpoint: 'vision_intent', status: 'synced' },
  ])
}

export function writeVisionProblemsDocument(projectId: string, json: string): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'vision-audit.json')
  writeFileSync(path, json, 'utf8')
  const previous = readManifest(dir)
  if (previous.some((entry) => entry.path === path)) return
  writeManifest(dir, [
    ...previous,
    { document_id: 'vision-audit-json', path, type: 'test_report', checkpoint: 'vision_audit', status: 'synced' },
  ])
}

export function writeVisionAuditDocument(projectId: string, markdown: string): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'vision-audit.md')
  writeFileSync(path, markdown, 'utf8')
  const previous = readManifest(dir)
  if (previous.some((entry) => entry.path === path)) return
  writeManifest(dir, [
    ...previous,
    { document_id: 'vision-audit', path, type: 'test_report', checkpoint: 'vision_audit', status: 'synced' },
  ])
}

/**
 * P3 任务级三文档契约（2026-09-04）：plan 腿产出的技术合同写盘 + 清单登记。
 *
 * - 文件 documents/{project_id}/plan.md（markdown 人读全文由 loop-planner 渲染）；
 * - 幂等登记（按 path 去重，同 security-scan 口径）：重跑时覆盖重写文件、清单条目不翻新
 *   ——plan 按 checkpoint 语义重写是合理行为（实施稿 §9：每次 loop 前合同都是新鲜的）；
 * - 不走 checkpoint switch：plan 生命周期独立于 13 阶段检查点；
 * - syncDocuments 的 stale 标记只作用于自身产出路径，plan.md 不会被后续检查点误清。
 */
export function writePlanDocument(projectId: string, markdown: string): DocumentRef | null {
  try {
    const project = findProject(projectId)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'plan.md')
    writeFileSync(path, markdown, 'utf8')
    const previous = readManifest(dir)
    if (!previous.some((entry) => entry.path === path)) {
      writeManifest(dir, [
        ...previous,
        { document_id: 'plan', path, type: 'plan', checkpoint: 'plan', status: 'synced' },
      ])
    }
    return { document_id: 'plan', type: 'plan', path, status: 'synced' }
  } catch {
    return null
  }
}

// =========================================================================
// P3 loop-log（2026-09-04）：append-only 过程日志
// =========================================================================

/** 开关已删除（2026-10-01 开关面收敛批）：loop-log 无条件落盘（append-only 取证通道）。 */

/** loop-log 条目：会话头（每次 runAgentLoop 一个）/ 轮次行（onTurn 实时）/ 终态节。 */
export type LoopLogEntry =
  | {
      kind: 'session_start'
      mode: import('../../shared/types').ProjectMode
      maxTurns: number
      /** plan 摘要行（PR-B 依赖 A：filesToTouch 一行摘要；null = 未生成） */
      planSummary?: string | null
      /** 会话标签（「MVP 生成」/「迭代重生成」——迭代重跑新增分节不覆盖历史） */
      label?: string
    }
  | {
      kind: 'turn'
      turn: number
      toolCalls: Array<{ name: string; path?: string }>
      inputTokens?: number
      outputTokens?: number
    }
  | { kind: 'final'; status: string; turns: number; toolCalls: number; /** P2a：真实出口原因标注（如 degenerate_output） */ terminationReason?: string }

/** 文档头（首次创建时写入一次；后续会话分节追加）。 */
const LOOP_LOG_DOC_HEADER = [
  '# Agent Loop 过程记录（loop-log）',
  '',
  '> append-only 过程日志：每轮实时追加；取消/崩溃后磁盘证据完整（磁盘证据收敛口径直接受益）。',
  '> 迭代重跑新增会话分节，历史永不改写。',
  '',
].join('\n')

/**
 * P3 loop-log 追加写盘（append-only，不走 checkpoint switch）：
 *
 * - 文件 documents/{project_id}/loop-log.md；首次写入文档头，之后纯追加；
 * - 会话头：时间/mode/maxTurns/plan 摘要行；轮次：`- 轮 N：tool(path) → tool ｜ tokens`；
 *   终态：`### 终态：status（N 轮 / M 次工具调用）`——cancelled/error 也如实写（硬约束 7）；
 * - 清单登记幂等（type 'loop_log'，永不标 stale——见 syncDocuments 豁免）；
 * - 每轮一次小 IO（appendFileSync 毫秒级，D4）；抛错由调用方静默（诊断增强不阻断主链路）。
 */
export function appendLoopLogDocument(projectId: string, entry: LoopLogEntry): void {
  const project = findProject(projectId)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'loop-log.md')
  let block: string
  if (entry.kind === 'session_start') {
    const head = [
      `## ${entry.label ?? 'Agent Loop 会话'}（${new Date().toISOString()}）`,
      '',
      `- 模式：${entry.mode}｜轮次上限：${entry.maxTurns}`,
      `- 技术合同：${entry.planSummary ?? '未生成（plan 腿关闭或失败）'}`,
      '',
    ].join('\n')
    block = existsSync(path) ? `\n${head}` : `${LOOP_LOG_DOC_HEADER}\n${head}`
  } else if (entry.kind === 'turn') {
    const tools = entry.toolCalls.length > 0
      ? entry.toolCalls.map((call) => (call.path ? `${call.name}(${call.path})` : call.name)).join(' → ')
      : '（无工具调用）'
    const tokens =
      entry.inputTokens !== undefined || entry.outputTokens !== undefined
        ? ` ｜ tokens in ${entry.inputTokens ?? '-'}/out ${entry.outputTokens ?? '-'}`
        : ''
    block = `- 轮 ${entry.turn}：${tools}${tokens}\n`
  } else {
    block = `\n### 终态：${entry.status}（${entry.turns} 轮 / ${entry.toolCalls} 次工具调用）${
      entry.terminationReason ? `｜${entry.terminationReason}` : ''
    }\n`
  }
  appendFileSync(path, block, 'utf8')
  const previous = readManifest(dir)
  if (!previous.some((existing) => existing.path === path)) {
    writeManifest(dir, [
      ...previous,
      { document_id: 'loop-log', path, type: 'loop_log', checkpoint: 'loop_log', status: 'synced' },
    ])
  }
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
export function assertInsideDocumentsDir(dir: string, target: string): void {
  const root = resolve(dir)
  const resolved = resolve(target)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`DOCUMENT_PATH_SAFETY: path outside documents dir: ${target}`)
  }
}

/** 读取需求清单；为空时回退到默认功能项，保证文档始终可读。 */
export function readRequirements(requirements: SketchRequirement[]): SketchRequirement[] {
  if (requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个可运行、可操作的功能页面。' }]
}

