/**
 * R0.1（2026-09-19 狗粮 7601e5ae「日常收支本」实锤）：real-fullstack 构建断链根治。
 *
 * 病灶：构建门禁只在生成轮收口后跑一次；修复/迭代轮只改 src/ 不重建 dist/，而
 * real-fullstack 的 index.html 加载 dist/app.js——终验与 run_gwt_tests 永远测旧
 * bundle，F-001 六轮修复全败全因于此（模型两次确诊「served bundle is stale」，
 * 最后一次 write_file 重建意图还被 DSML 信道吃掉，见主记忆 09-19 条目）。
 *
 * 修复口径：终验（runGwtWithApiContract——初验与修复轮重验共用无旁路）与
 * run_gwt_tests 工具执行前，对 real-fullstack 变体做陈旧检测（src/ 任一文件
 * 新于 dist 产物，或产物缺失）→ 复用构建门禁 esbuild 重建。非 fullstack
 * （无变体标记 / real-static / 骨架包缺失）一律 no-op fail-open——旧路径字节不变。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project/project-service'
import { recordDecision } from '../project/decision-log'
import { loadRealScaffoldTemplate, type SkeletonBuildSpec } from '../project/project-templates'
import { readRealScaffoldVariant } from './preview-runtime'
import { runBuildGate } from './build-gate'

export interface DistRebuildOutcome {
  action: 'rebuilt' | 'fresh' | 'skipped'
  reason: string
}

/** src/ 全树最新 mtime 与 dist 产物比对（bundle 从 entry 起解析 import，被引文件
 *  可能在 src/ 任意位置——只比 entry 会漏掉被引模块的修改）。dist 缺失或 src
 *  不可读 → 判陈旧（重建是最安全侧；入口缺失由构建门禁自身如实拦截）。 */
function isDistStale(rootPath: string, spec: SkeletonBuildSpec): { stale: boolean; reason: string } {
  try {
    const distMtime = statSync(join(rootPath, spec.outfile)).mtimeMs
    let newest = 0
    let newestRel = ''
    const walk = (abs: string, rel: string): void => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childAbs = join(abs, entry.name)
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(childAbs, childRel)
        else if (entry.isFile()) {
          const mtime = statSync(childAbs).mtimeMs
          if (mtime > newest) {
            newest = mtime
            newestRel = childRel
          }
        }
      }
    }
    walk(join(rootPath, 'src'), 'src')
    if (newest > distMtime) return { stale: true, reason: `src 有更新：${newestRel} 晚于 ${spec.outfile}` }
    return { stale: false, reason: 'dist-not-stale' }
  } catch {
    return { stale: true, reason: `产物 ${spec.outfile} 缺失或 src/ 不可读` }
  }
}

/** real-fullstack 专属 dist 重建（陈旧才建，幂等；其余变体 no-op fail-open）。 */
export async function rebuildRealFullstackDist(input: { projectId: string; sessionId: string }): Promise<DistRebuildOutcome> {
  try {
    const project = findProject(input.projectId)
    if (!project) return { action: 'skipped', reason: 'project-not-found' }
    if (readRealScaffoldVariant(project.root_path) !== 'real-fullstack') {
      return { action: 'skipped', reason: 'variant-not-fullstack' }
    }
    const skeleton = loadRealScaffoldTemplate(true, { project_id: input.projectId, session_id: input.sessionId })
    const spec = skeleton?.build
    if (!skeleton || !spec) return { action: 'skipped', reason: 'no-build-spec' }

    const stale = isDistStale(project.root_path, spec)
    if (!stale.stale) return { action: 'fresh', reason: stale.reason }

    const gate = await runBuildGate({
      projectId: input.projectId,
      sessionId: input.sessionId,
      rootPath: project.root_path,
      skeleton,
    })
    try {
      recordDecision({
        project_id: input.projectId,
        session_id: input.sessionId,
        entry: {
          type: 'dist_rebuild',
          title: gate.status === 'passed' ? '真实脚手架 dist 已重建（src 变更后）' : `真实脚手架 dist 重建未成功（${gate.status}）`,
          why: `${stale.reason}；构建门禁 ${gate.status}${gate.detail ? `：${gate.detail.slice(0, 200)}` : ''}`,
          detail: { status: gate.status, trigger: stale.reason, entry: spec.entry, outfile: spec.outfile, duration_ms: gate.durationMs },
        },
      })
    } catch {
      // 决策日志失败不影响重建结果
    }
    if (gate.status === 'passed') return { action: 'rebuilt', reason: stale.reason }
    return { action: 'skipped', reason: `rebuild-${gate.status}: ${gate.detail ?? ''}`.slice(0, 200) }
  } catch (error) {
    return { action: 'skipped', reason: `fail-open: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) }
  }
}
