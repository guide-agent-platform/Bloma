import { existsSync, readFileSync } from 'node:fs'
import { mainRootDir } from '../platform/paths'
import { dirname, join } from 'node:path'
import { getProjectTemplatePath, getSkeletonDirPath } from '../../storage/config-paths'
import { recordDecision } from './decision-log'
import type { ConstraintLevel, TemplateType } from '../../shared/types'

/**
 * ProjectTemplates — 类型模板包加载器（2026-09-02 周计划 §5 P4，方案 §5.2）。
 *
 * 模板 = 预设包（PRD 12.1）：硬约束等级 + PRD 章节必填子集 + 依赖白名单 +
 * tech_skeleton + 测试策略 + 同类型脱敏样例。存放两层（沿用 prompt-config 模式）：
 * - 内置：main/templates/{type}.md（随仓库版本化，同 OpenSpec 模板进包的做法）；
 * - 外置覆盖：~/.proma/templates/{type}.md（存在且合法即全量生效，改文件即时生效）。
 *
 * fail-closed（方案 §5.2/§九验收 5）：外置存在但非法（frontmatter 解析失败/type 不匹配/
 * level 缺失）→ 回退内置 + 决策日志记录（template_override_rejected），绝不因坏文件
 * 阻断生成链路。
 *
 * 纪律：模板永不整本进上下文、不进对话历史（§六）——消费方按注入点切片取用
 * （few-shot 取 sample 且硬截断 500 token；骨架取 techSkeleton 列表；etc）。
 */

/** few-shot 样例硬截断（字符≈中文 800 字，约 500 token；方案 §5.2）。 */
export const SAMPLE_MAX_CHARS = 800

/** 模板文件名（type snake_case ↔ 文件 kebab-case）。 */
const TEMPLATE_FILES: Record<TemplateType, string> = {
  web_fullstack: 'web-fullstack.md',
  desktop_tool: 'desktop-tool.md',
  personal_tool: 'personal-tool.md',
  game: 'game.md',
  ai_app: 'ai-app.md', // 二期（模板包 v1 不含，读取时回退 personal-tool 内置）
}

export interface ProjectTemplate {
  type: TemplateType
  level: ConstraintLevel
  version: number
  name: string
  /** 同类型脱敏样例（已硬截断；注入点③ few-shot） */
  sample: string
  /** 来源：builtin = 内置生效；override = 外置覆盖生效；builtin_fallback = 外置非法回退内置 */
  source: 'builtin' | 'override' | 'builtin_fallback'
  /** 正文 markdown（按消费者切片消费，永不整本注入） */
  body: string
}

/** frontmatter 结构化字段（正文前的 --- 块，手写解析避免引入 yaml 依赖）。 */
interface TemplateFrontmatter {
  type?: string
  level?: string
  version?: number
  name?: string
}

const VALID_LEVELS = new Set<ConstraintLevel>(['loose', 'standard', 'strict'])
const VALID_TYPES = new Set<TemplateType>(['web_fullstack', 'desktop_tool', 'personal_tool', 'game', 'ai_app'])

/** 解析 frontmatter（--- 包围的首块；key: value 行集合，version 转 number）。 */
function parseFrontmatter(text: string): { frontmatter: TemplateFrontmatter; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return null
  const fields: TemplateFrontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
    if (!entry) continue
    const [, key, rawValue] = entry
    const value = rawValue.trim()
    if (key === 'version') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) fields.version = parsed
    } else if (key === 'type' || key === 'level' || key === 'name') {
      fields[key] = value
    }
  }
  return { frontmatter: fields, body: match[2] ?? '' }
}

/** 提取「## 同类型脱敏样例」章节文本（到下一 ## 标题或文末；行扫描避免正则零长捕获陷阱）。 */
function extractSample(body: string): string {
  const section = extractMarkdownSection(body, '同类型脱敏样例')
  return section.length > SAMPLE_MAX_CHARS ? section.slice(0, SAMPLE_MAX_CHARS) : section
}

/** markdown ## 章节切片（标题含 keyword 的首章节正文；行扫描实现，稳定可测）。 */
function extractMarkdownSection(body: string, keyword: string): string {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(keyword))
  if (start < 0) return ''
  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break
    collected.push(lines[i])
  }
  return collected.join('\n').trim()
}

/** 内置模板文本（源码运行=main/templates/；esbuild bundle 后=dist-main/main/templates/，
 * 由 build:main 复制步骤落位；import.meta.url 定位自身目录，两态同源）。
 *  ai_app 候选链的 personal_tool 兑底当前必被 validateTemplate 拒（frontmatter.type
 * ≠ ai_app，m-4 实锤）——ai_app 模板包二期提供前「ai_app 取不到内置模板」是现状，
 * 测试锁定 null；二期重写时要么提供真 ai_app.md，要么显式按 personal_tool 加载。 */
function readBuiltinTemplate(type: TemplateType): string | null {
  const ownDir = mainRootDir()
  const candidates = type === 'ai_app' ? [TEMPLATE_FILES.ai_app, TEMPLATE_FILES.personal_tool] : [TEMPLATE_FILES[type]]
  for (const file of candidates) {
    try {
      const path = join(ownDir, 'templates', file)
      if (existsSync(path)) return readFileSync(path, 'utf8')
    } catch {
      // 读取失败尝试下一候选
    }
  }
  return null
}

/** 校验模板文本：frontmatter 齐全且 type 匹配预期（外置文件不许冒充他类型模板）。 */
function validateTemplate(text: string, expectedType: TemplateType): ProjectTemplate | null {
  const parsed = parseFrontmatter(text)
  if (!parsed) return null
  const { frontmatter, body } = parsed
  if (frontmatter.type !== expectedType) return null
  if (!frontmatter.level || !VALID_LEVELS.has(frontmatter.level as ConstraintLevel)) return null
  if (!frontmatter.name) return null
  return {
    type: expectedType,
    level: frontmatter.level as ConstraintLevel,
    version: frontmatter.version ?? 1,
    name: frontmatter.name,
    sample: extractSample(body),
    source: 'builtin',
    body,
  }
}

/**
 * 加载类型模板（单点收口：调用方拿到的永远是「已解析且合法」的模板）。
 * 无外置 → 内置；外置合法 → 外置（source=override）；外置非法 → 内置 + 决策日志。
 * 内置也缺失（打包异常）→ null，调用方按无模板现状运行（fail-closed 不阻断）。
 */
export function loadProjectTemplate(type: TemplateType, logContext?: { project_id?: string; session_id?: string }): ProjectTemplate | null {
  const builtinText = readBuiltinTemplate(type)
  const builtin = builtinText ? validateTemplate(builtinText, type) : null

  try {
    const overridePath = getProjectTemplatePath(TEMPLATE_FILES[type])
    if (!existsSync(overridePath)) return builtin
    const overrideText = readFileSync(overridePath, 'utf8')
    const override = validateTemplate(overrideText, type)
    if (override) return { ...override, source: 'override' }
    // fail-closed：外置非法 → 回退内置 + 决策日志（§九验收 5：写坏文件回退内置且有记录）
    try {
      recordDecision({
        project_id: logContext?.project_id ?? '',
        session_id: logContext?.session_id ?? '',
        entry: {
          type: 'template_override_rejected',
          title: '外置模板非法，回退内置',
          why: '外置模板 frontmatter 缺失/type 不匹配/level 非法——fail-closed 回退内置模板，不阻断生成链路',
          detail: { template_type: type, path: overridePath },
        },
      })
    } catch {
      // 决策日志失败不影响回退
    }
    return builtin ? { ...builtin, source: 'builtin_fallback' } : builtin
  } catch {
    return builtin
  }
}

/** 模板章节切片（按消费者取段；keyword 命中 ## 标题即取该节正文）。 */
export function templateSection(template: ProjectTemplate, keyword: string): string {
  return extractMarkdownSection(template.body, keyword)
}

// =========================================================================
// 骨架包（PR-1 骨架先行，2026-09-03）：loop 前由系统确定性渲染的文件骨架
// =========================================================================

/** 骨架文件条目：path 相对项目根；role 供注入⑥骨架地图；readonly 供工具面只读保护。 */
export interface SkeletonFileEntry {
  path: string
  role?: string
  readonly?: boolean
}

/** 构建门禁规约（manifest v2 可选 build 段；无段 = 静态形态，行为与 PR-1 完全一致）。 */
export interface SkeletonBuildSpec {
  tool: 'esbuild'
  /** 构建入口（相对项目根，通常是逻辑入口文件） */
  entry: string
  /** 产物路径（相对项目根） */
  outfile: string
  format: 'iife'
  minify: boolean
}

/** 已加载且校验合法的骨架包（baseDir = 文件读取根，渲染时逐文件复制）。 */
export interface ProjectSkeleton {
  type: TemplateType
  /** 真实脚手架变体（W1，2026-09-18 改造）：real-static（纯静态一等公民）/ real-fullstack（Express 真实工程）。
 *  旧骨架包无 variant 字段；两态判定在 loadRealScaffoldTemplate（interface_spec 非空→ fullstack）。 */
  variant?: 'real-static' | 'real-fullstack'
  version: number
  baseDir: string
  files: SkeletonFileEntry[]
  /** 构建门禁规约（manifest 无 build 段时缺省，静态形态） */
  build?: SkeletonBuildSpec
  /** 来源：builtin = 内置生效；override = 外置覆盖生效；builtin_fallback = 外置非法回退内置 */
  source: 'builtin' | 'override' | 'builtin_fallback'
}

/** 骨架目录映射：game 复用 web_fullstack（产物形态同为 web 全栈）；personal_tool 同样复用
 * （2026-09-18 本月流水账案止血：无骨架 → _example.js 不预置 → 路由键约定无样例可参照，
 * 404 六次盲调不可恢复；个人工具型产物与 web 全栈同形态，直接复用）；其余类型无骨架 = 现状从零写。 */
const SKELETON_DIRS: Partial<Record<TemplateType, string>> = {
  web_fullstack: 'web-fullstack',
  game: 'web-fullstack',
  personal_tool: 'web-fullstack',
}

/** 骨架校验类型：game/personal_tool 复用 web_fullstack 骨架（manifest.type 是 web_fullstack），校验时按 web_fullstack。 */
function skeletonValidateType(type: TemplateType): TemplateType {
  return type === 'game' || type === 'personal_tool' ? 'web_fullstack' : type
}

/** 骨架文件后缀白名单（与 agent-tools WRITABLE_EXTENSIONS 同集：静态前端产物；
 *  W1（2026-09-18）：real-fullstack 携带 package.json，增 .json）。 */
const SKELETON_EXTENSIONS = new Set(['.html', '.js', '.css', '.json'])

/** 骨架文件路径校验：非空字符串、无 ../ 与绝对路径、后缀在白名单（防 manifest 携带越界路径）。 */
function isSafeSkeletonPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false
  const normalized = path.replace(/\\/g, '/')
  if (normalized.includes('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  return SKELETON_EXTENSIONS.has(extnameOf(normalized))
}

function extnameOf(path: string): string {
  const idx = path.lastIndexOf('.')
  return idx >= 0 ? path.slice(idx).toLowerCase() : ''
}

/** 读取并校验一个骨架目录：manifest 存在、可解析、type 匹配、files 非空且全部真实存在；build 段可选且字段完整才采纳。 */
function readSkeletonDir(dir: string, expectedType: TemplateType): ProjectSkeleton | null {
  try {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      type?: string
      variant?: string
      version?: number
      build?: Partial<SkeletonBuildSpec>
      files?: SkeletonFileEntry[]
    }
    if (manifest.type !== expectedType || !Array.isArray(manifest.files) || manifest.files.length === 0) return null
    for (const entry of manifest.files) {
      if (!entry || !isSafeSkeletonPath(entry.path)) return null
      if (!existsSync(join(dir, entry.path))) return null
    }
    // PR-2 build 段：字段不全/入口越界 → 整段丢弃（降级静态形态），不因坏 build 段拒整个骨架
    let build: SkeletonBuildSpec | undefined
    const raw = manifest.build
    if (raw && raw.tool === 'esbuild' && typeof raw.entry === 'string' && typeof raw.outfile === 'string'
      && isSafeSkeletonPath(raw.entry) && isSafeSkeletonPath(raw.outfile)) {
      build = {
        tool: 'esbuild',
        entry: raw.entry,
        outfile: raw.outfile,
        format: 'iife',
        minify: raw.minify !== false,
      }
    }
    return {
      type: expectedType,
      variant: manifest.variant === 'real-static' || manifest.variant === 'real-fullstack' ? manifest.variant : undefined,
      version: typeof manifest.version === 'number' ? manifest.version : 1,
      baseDir: dir,
      files: manifest.files,
      ...(build ? { build } : {}),
      source: 'builtin',
    }
  } catch {
    return null
  }
}

/**
 * 加载骨架包（单点收口）：无外置 → 内置；外置合法 → 外置；外置非法 → 回退内置 + 决策日志
 * （skeleton_override_rejected，同 loadProjectTemplate fail-closed 口径）；
 * 内置也缺失/非法 → null，调用方按无骨架现状运行（增强不阻断）。
 * 未提供骨架的类型（v1 除 web_fullstack 外）直接 null。不缓存（改文件即时生效，与 md 模板同语义）。
 */
export function loadSkeletonTemplate(
  type: TemplateType,
  logContext?: { project_id?: string; session_id?: string },
): ProjectSkeleton | null {
  const dirName = SKELETON_DIRS[type]
  if (!dirName) return null
  // game 复用 web_fullstack 骨架：manifest.type 是 web_fullstack，校验类型单独映射（skeletonValidateType）；
  // 返回时 type 修正为传入 type（game），保持调用方看到的 skeleton.type 与项目类型一致。
  const validateType = skeletonValidateType(type)
  const ownDir = mainRootDir()
  const builtinDir = join(ownDir, 'templates', 'skeletons', dirName)
  const builtinRaw = readSkeletonDir(builtinDir, validateType)
  const builtin = builtinRaw ? { ...builtinRaw, type } : null

  try {
    const overrideDir = getSkeletonDirPath(dirName)
    if (!existsSync(join(overrideDir, 'manifest.json'))) return builtin
    const overrideRaw = readSkeletonDir(overrideDir, validateType)
    if (overrideRaw) return { ...overrideRaw, type, source: 'override' }
    try {
      recordDecision({
        project_id: logContext?.project_id ?? '',
        session_id: logContext?.session_id ?? '',
        entry: {
          type: 'skeleton_override_rejected',
          title: '外置骨架包非法，回退内置',
          why: '外置骨架 manifest 缺失/type 不匹配/files 非法或文件不存在——fail-closed 回退内置骨架，不阻断生成链路',
          detail: { template_type: type, path: overrideDir },
        },
      })
    } catch {
      // 决策日志失败不影响回退
    }
    return builtin ? { ...builtin, source: 'builtin_fallback' } : builtin
  } catch {
    return builtin
  }
}

// =========================================================================
// W1 真实脚手架（2026-09-18 改造，BLOMA_REAL_SCAFFOLD 缺省 off = 字节级现状）
// =========================================================================

/** 开关已删（2026-10-01 第二刀）：真实脚手架为唯一主线（real-static / real-fullstack 两态）。
 *  旧项目兼容由磁盘标记 .bloma-real-variant 兜底（无标记 → 旧预览路径，数据兼容逻辑非开关分支）。 */

/** 参与真实脚手架的 web 形态类型；desktop_tool / ai_app 维持旧路径（v0 不扩）。 */
export const REAL_SCAFFOLD_TYPES: ReadonlySet<string> = new Set(['web_fullstack', 'personal_tool', 'game'])

/** 两态判定加载器：interface_spec 非空 → real-fullstack（Express 真实工程）；
 *  空 → real-static（纯静态一等公民，localStorage 持久化合法）。
 *  判定依据是 PRD 契约本身（背板），不是模板类型猜测——纯静态是合法终态。
 *  骨架包缺失/非法 → null（fail-open 回旧路径，不阻断生成）。 */
export function loadRealScaffoldTemplate(
  hasBackendContract: boolean,
  logContext?: { project_id?: string; session_id?: string },
): ProjectSkeleton | null {
  const dirName = hasBackendContract ? 'real-fullstack' : 'real-static'
  const ownDir = mainRootDir()
  const raw = readSkeletonDir(join(ownDir, 'templates', 'skeletons', dirName), 'web_fullstack')
  if (raw) return raw
  try {
    recordDecision({
      project_id: logContext?.project_id ?? '',
      session_id: logContext?.session_id ?? '',
      entry: {
        type: 'skeleton_render_failed',
        title: '真实脚手架包非法，回退旧路径',
        why: `real-${hasBackendContract ? 'fullstack' : 'static'} 骨架包缺失或 manifest 非法——fail-open 回退旧注入式路径，不阻断生成`,
        detail: { variant: dirName },
      },
    })
  } catch {
    // 决策日志失败不影响回退
  }
  return null
}
