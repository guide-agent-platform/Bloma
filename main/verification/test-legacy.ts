import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getAnalyticsPath, getDocumentsDir } from '../../storage/config-paths'
import { findProject } from '../project/project-service'

import { replayRequirements, splitAdvisoryResults } from '../experience/replay-compiler'
import { reportReplayOutcomes } from '../experience/experience-service'

/**
 * 已退役 web 线的 GWT 测试报告兼容读取层（web 线拆除刀2，2026-10-01）：
 * 只保留类型定义、hasInteractiveEntry 与 readTestReport（旧项目报告文件 → analytics
 * test_completed 事件回退还原），供 recovery/judge/context-pack/repair-loop 等数据
 * 兼容消费。执行器（runGwtScenarios）与写侧（writeTestReport）随 web 生成线退役。
 */

export interface GwtFailureSummary {
  scenario: string
  reason: string
  /**
   * 失败归类（2026-09-26 照抄批·对方 AC L-001 回炉分流）：product=产品类（进修复轮）；
   * precondition=前置缺失（不可自动验证——不烧修复预算）；selector=映射类（找不到控件，
   * 失败原因带控件清单可修——修复轮处理）。缺省（存量/静态兜底路径）按 product 对待。
   * mapping=编译器无法构造可靠步骤（删除/撤销族、未实现 op）——测试侧能力缺口，
   * 不烧预算不放行（审计修复批补全）。缺省（存量/静态兑底路径）按 product 对待。
   */
  kind?: 'product' | 'precondition' | 'selector' | 'mapping'
}

export interface GwtTestResult {
  total_count: number
  passed_count: number
  failed_count: number
  failure_summary: GwtFailureSummary[]
  /**
   * 待评估断言（§8.1）：行为断言解析出了效果词表但产物未现关键词（可能走
   * SVG/canvas/@keyframes 等不落关键词的合法实现）→ 静态模式无法判定，不计失败，
   * 由行为脚本/LLM 裁判兜底。信息性字段，裁判不作硬约束依据。
   */
  unverified?: string[]
  /**
   * 产物入口聚合指纹（2026-09-25 挂账②，对方 entryFingerprint 直译——多文件聚合口径）：
   * index.html + src/** 递归 + dist/app.js 逐文件 sha256 组合。报告落盘时计算；
   * 消费侧（checkEntryFingerprintFresh）比对当前产物——验证后被改可检测。
   */
  entry_fingerprint?: EntryFingerprint
  /**
   * 探针降级标记（2026-09-25 对齐批·环境豁免）：true = 浏览器探针不可用，结果是
   * 静态启发式兜底判定——失败不可归因产物缺陷（静态口径的假红/待评估），
   * 修复轮据此不烧预算（对齐 Proma-Easy「环境类不入修复循环」铁律）。
   */
  probe_degraded?: boolean
}

/** 产物入口聚合指纹（多文件口径）。 */
export interface EntryFingerprint {
  /** 关键产物文件内容的组合 sha256（hex） */
  sha256: string
  /** 关键产物文件总字节数 */
  size: number
  /** 参与指纹的文件数 */
  files: number
}

/**
 * 计算产物入口聚合指纹：index.html + src/**（递归）+ server/**（递归）+ package.json/
 * package-lock.json + dist/app.js（2026-09-26 审计 P1-07 扩面：原口径漏后端与依赖
 * 清单——只改 server/*.js 不使指纹失效会放行「验证后被改」）。
 * 逐文件读内容进 hash 流（内容 + 相对路径，防同名挪位），返回组合指纹；
 * index.html 不存在返回 null（无入口可指纹——消费侧按无可比处理，不误报）。
 */
export interface RunGwtInput {
  project_id: string
  session_id: string
  preview_url?: string
}

const TEST_REPORT_JSON = 'test-report.json'
const TEST_REPORT_MD = 'test-report.md'

/** 在预览上执行 GWT 场景，返回结构化结果。 */
export function hasInteractiveEntry(html: string, appJs: string): boolean {
  if (!html || !appJs) return false
  const hasControl = /<(button|input|select|textarea|a|form)\b/i.test(html)
  const hasLogic = /\b(addEventListener|onclick|oninput|onchange|onsubmit|function)\b/i.test(appJs)
  return hasControl && hasLogic
}

/** 将 GWT 执行结果写为测试报告（本模块唯一写盘，供裁判读取）。 */
export function readTestReport(projectId: string): GwtTestResult | null {
  const project = findProject(projectId)
  const absolute = join(getDocumentsDir(project.workspace_slug, project.project_id), TEST_REPORT_JSON)
  if (existsSync(absolute)) {
    try {
      return JSON.parse(readFileSync(absolute, 'utf8')) as GwtTestResult
    } catch {
      /* 损坏文件继续走事件回退 */
    }
  }
  return readLastTestCompletedEvent(project.workspace_slug, projectId)
}

/** 从 analytics JSONL 取项目最近一条 test_completed 事件，还原测试报告。
 *  2026-09-26 审计 P1-03：kind/probe_degraded/unverified 随事件持久化（写入侧
 *  trackTestCompleted），此处同字段还原——回滚后分类与降级标记不丢失。 */
function readLastTestCompletedEvent(workspaceSlug: string, projectId: string): GwtTestResult | null {
  const analyticsPath = getAnalyticsPath(workspaceSlug)
  if (!existsSync(analyticsPath)) return null
  try {
    const lines = readFileSync(analyticsPath, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed: { event_type?: string; project_id?: string; payload?: {
        total_count?: number; passed_count?: number; failed_count?: number
        failures?: Array<{ scenario?: unknown; reason?: unknown; kind?: unknown }>
        probe_degraded?: boolean; unverified?: string[]
      } }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.event_type !== 'test_completed' || parsed.project_id !== projectId) continue
      const payload = parsed.payload ?? {}
      const failed = typeof payload.failed_count === 'number' ? payload.failed_count : 0
      const failureKinds = new Set(['product', 'precondition', 'selector', 'mapping'])
      const unverifiedRestored = Array.isArray(payload.unverified) ? payload.unverified.filter((u): u is string => typeof u === 'string') : []
      return {
        total_count: typeof payload.total_count === 'number' ? payload.total_count : 0,
        passed_count: typeof payload.passed_count === 'number' ? payload.passed_count : 0,
        failed_count: failed,
        failure_summary: (Array.isArray(payload.failures) ? payload.failures : [])
          .filter((f): f is { scenario: string; reason: string; kind?: string } => typeof f?.scenario === 'string' && typeof f?.reason === 'string')
          .map((f) => ({
            scenario: f.scenario,
            reason: f.reason,
            ...(typeof f.kind === 'string' && failureKinds.has(f.kind) ? { kind: f.kind as GwtFailureSummary['kind'] } : {}),
          })),
        ...(payload.probe_degraded === true ? { probe_degraded: true } : {}),
        ...(unverifiedRestored.length > 0 ? { unverified: unverifiedRestored } : {}),
      }
    }
  } catch {
    /* 读不了事件就如实 null */
  }
  return null
}

// ── 产物入口聚合指纹（桌面线 P2-01 确认卡绑定用；web 线拆除刀2 自 gwt-service 迁入）──
export interface EntryFingerprint {
  /** 关键产物文件内容的组合 sha256（hex） */
  sha256: string
  /** 关键产物文件总字节数 */
  size: number
  /** 参与指纹的文件数 */
  files: number
}

/**
 * 计算产物入口聚合指纹：index.html + src/**（递归）+ server/**（递归）+ package.json/
 * package-lock.json + dist/app.js（2026-09-26 审计 P1-07 扩面：原口径漏后端与依赖
 * 清单——只改 server/*.js 不使指纹失效会放行「验证后被改」）。
 * 逐文件读内容进 hash 流（内容 + 相对路径，防同名挪位），返回组合指纹；
 * index.html 不存在返回 null（无入口可指纹——消费侧按无可比处理，不误报）。
 */
export function computeEntryFingerprint(projectRoot: string): EntryFingerprint | null {
  const entry = join(projectRoot, 'index.html')
  if (!existsSync(entry)) return null
  const hash = createHash('sha256')
  let size = 0
  let files = 0
  const absorb = (abs: string, rel: string): void => {
    const content = readFileSync(abs)
    hash.update(rel)
    hash.update(content)
    size += content.length
    files += 1
  }
  absorb(entry, 'index.html')
  const srcRoot = join(projectRoot, 'src')
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs, `${prefix}${name}/`)
      else absorb(abs, `${prefix}${name}`)
    }
  }
  walk(srcRoot, 'src/')
  // P1-07：后端与依赖清单纳入指纹（见头部注释）
  walk(join(projectRoot, 'server'), 'server/')
  for (const name of ['package.json', 'package-lock.json']) {
    const abs = join(projectRoot, name)
    if (existsSync(abs)) absorb(abs, name)
  }
  const distEntry = join(projectRoot, 'dist', 'app.js')
  if (existsSync(distEntry)) absorb(distEntry, 'dist/app.js')
  return { sha256: hash.digest('hex'), size, files }
}

/**
 * 报告新鲜度校验（消费侧，对方 checkGwtDeliveryFacts b 道直译的最小版）：
 * 比对最近测试报告的 entry_fingerprint 与当前产物指纹。
 * true=一致（历史结论仍有效）/ false=验证后产物被修改（历史全绿结论失效）/
 * null=无可比（旧报告无指纹字段，或产物入口缺失——不误报）。
 */
export function checkEntryFingerprintFresh(projectId: string): boolean | null {
  const report = readTestReport(projectId)
  if (!report?.entry_fingerprint) return null
  const project = findProject(projectId)
  if (!project) return null
  const current = computeEntryFingerprint(project.root_path)
  if (!current) return null
  return current.sha256 === report.entry_fingerprint.sha256
}

/** 将测试结果写为报告 JSON（刀2 简化版：不再写 md；供测试造数与未来桌面报告落盘复用）。 */
export function writeTestReport(input: {
  request_id: string
  session_id: string
  project_id: string
  result: GwtTestResult
}): { path: string } {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const fingerprint = computeEntryFingerprint(project.root_path)
  if (fingerprint) input.result.entry_fingerprint = fingerprint
  const path = join(dir, TEST_REPORT_JSON)
  writeFileSync(path, `${JSON.stringify(input.result, null, 2)}\n`, 'utf-8')
  writeFileSync(join(dir, TEST_REPORT_MD), `# 测试报告\n\n总计 ${input.result.total_count}，通过 ${input.result.passed_count}，失败 ${input.result.failed_count}。\n`, 'utf-8')
  return { path }
}
