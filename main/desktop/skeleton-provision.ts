/**
 * 骨架 v2 物化（批8 下半，2026-10-06）——平台供资产惯例（同 speech_locator.py /
 * drive-harness.py）：把 main/templates/skeletons/desktop-python/ 复制进项目根，
 * 子会话只做扩展不做抄写。
 *
 * 背景：批8 上半骨架 v2（pywebview 渲染层）落地后，任务书引用 ui/PATTERNS.md 让
 * 子会话 read——但子会话 read_file 沙箱锁项目根，组件手册必须在项目内才可读，
 * 故由平台在阶段入口物化。tkinter 时代任务书靠描述教学、子会话自写 ui_kit.py
 * （每单配色漂移、体验纪律靠自觉）；v2 改为平台供骨架 + 子会话照手册拼装。
 *
 * 纪律：
 * - 幂等：已存在的文件一律跳过（绝不覆盖子会话成果；阶段重跑/checkpoint 续跑安全）；
 * - 占位符渲染：{{project_name}}/{{project_title}} → 项目名（骨架源文件保持模板态）；
 * - contract.json 物化到 00_SCAFFOLD/ 时同步改写 driver.command 前缀（骨架样例按
 *   根目录写 ["python","driver-skeleton.py"]，物化后须指向 00_SCAFFOLD/ 路径）；
 * - fail-open：单文件缺失/失败记入 missing/failed，不抛错不阻断阶段（任务书教
 *   子会话「先 list_files 核对，缺失则按纪律从零补齐同构骨架」）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mainRootDir } from '../platform/paths'

/** 物化清单：骨架源相对路径 → 项目内相对路径。 */
const ROOT_FILES: readonly string[] = [
  'app.py',
  'requirements.txt',
  'README.md',
  'ui/index.html',
  'ui/tokens.css',
  'ui/kit.css',
  'ui/bridge.js',
  'ui/PATTERNS.md',
]

/** 工程契约/驱动骨架（scaffold 门禁位置；quick 模式不物化）。 */
const SCAFFOLD_FILES: readonly string[] = ['driver-skeleton.py', 'contract.json']

export interface SkeletonProvisionResult {
  copied: string[]
  skipped: string[]
  /** 骨架源缺失的文件（安装异常时如实暴露，任务书有从零补齐口径） */
  missing: string[]
  /** 复制失败（I/O 异常等，fail-open 不阻断） */
  failed: string[]
}

export interface SkeletonProvisionOptions {
  /** 同时物化 00_SCAFFOLD/ 的 driver-skeleton.py + contract.json（desktop-scaffold 阶段用） */
  includeScaffold?: boolean
}

/** 渲染骨架占位符（project_name/project_title 同值——项目名即窗口标题与文案名）。 */
function renderPlaceholders(content: string, projectName: string): string {
  return content.replace(/\{\{project_name\}\}/g, projectName).replace(/\{\{project_title\}\}/g, projectName)
}

/**
 * 物化桌面骨架 v2 到项目根。任何失败都收进结果（fail-open）——调用方（调度员
 * loop 入口）不因资产缺失阻断阶段，只 console.warn 留痕。
 */
export function provisionDesktopSkeletonV2(
  projectRoot: string,
  projectName: string,
  options: SkeletonProvisionOptions = {},
): SkeletonProvisionResult {
  const result: SkeletonProvisionResult = { copied: [], skipped: [], missing: [], failed: [] }
  const skeletonDir = join(mainRootDir(), 'templates', 'skeletons', 'desktop-python')
  const entries: Array<{ source: string; target: string }> = [
    ...ROOT_FILES.map((rel) => ({ source: rel, target: rel })),
    ...(options.includeScaffold ? SCAFFOLD_FILES.map((rel) => ({ source: rel, target: `00_SCAFFOLD/${rel}` })) : []),
  ]

  for (const entry of entries) {
    const sourceAbs = join(skeletonDir, entry.source)
    const targetAbs = join(projectRoot, entry.target)
    try {
      if (!statSync(sourceAbs).isFile()) {
        result.missing.push(entry.target)
        continue
      }
    } catch {
      result.missing.push(entry.target)
      continue
    }
    if (existsSync(targetAbs)) {
      result.skipped.push(entry.target)
      continue
    }
    try {
      mkdirSync(dirname(targetAbs), { recursive: true })
      if (entry.target.endsWith('contract.json')) {
        // 契约样例按根目录写 driver.command；物化到 00_SCAFFOLD/ 后补目录前缀
        const raw = JSON.parse(readFileSync(sourceAbs, 'utf8')) as { driver?: { command?: string[] } }
        const command = raw.driver?.command
        if (Array.isArray(command)) {
          const scriptIndex = command.findIndex((part) => part === 'driver-skeleton.py')
          if (scriptIndex >= 0) command[scriptIndex] = '00_SCAFFOLD/driver-skeleton.py'
        }
        writeFileSync(targetAbs, JSON.stringify(raw, null, 2), 'utf8')
      } else {
        copyFileSync(sourceAbs, targetAbs)
      }
      result.copied.push(entry.target)
    } catch {
      result.failed.push(entry.target)
    }
  }
  // 占位符渲染（copyFileSync 拿不到内容，统一对文本产物二次处理——幂等：仅本轮 copied）
  for (const rel of result.copied) {
    if (!/\.(py|md|html|css|js|txt|json)$/.test(rel)) continue
    const targetAbs = join(projectRoot, rel)
    try {
      const raw = readFileSync(targetAbs, 'utf8')
      const rendered = renderPlaceholders(raw, projectName)
      if (rendered !== raw) writeFileSync(targetAbs, rendered, 'utf8')
    } catch {
      // 渲染失败保持原文（占位符留着，子会话可自行替换）
    }
  }
  return result
}
