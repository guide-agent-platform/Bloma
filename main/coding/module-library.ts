import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateType } from '../../shared/types'

/**
 * OfficialModules — 官方功能模块库（VibeGame 借鉴第三层 / P1 模块侧，2026-09-04）。
 *
 * 为编程 Agent 提供「经过验证的可复用实现参考」：系统在 loop 启动前把适合当前
 * 项目类型的官方模块确定性物化到项目 `src/official-modules/{slug}/`（纯 fs，无 LLM），
 * 并通过「模块地图」随 system prompt 注入（事实与注入同源，不凭空宣称）。Agent 按
 * 地图 read_file 查看后，把源码复制到业务 src/ 文件按需改编——产物自包含，不留
 * 平台目录痕迹；目录本身只读（agent-tools 拒绝写入），不进入 import 图。
 *
 * 与 PR-1 骨架先行同哲学：
 * - 独立开关 `BLOMA_MODULES`（缺省开；关 = 现状字节级）；
 * - fail-open：目录缺失/模块非法/渲染异常 → 回退「无模块现状」，绝不阻断 MVP 生成；
 * - 物化幂等：目标已存在则跳过，迭代重跑/恢复场景不覆盖既有产物。
 *
 * 内置资产源：main/templates/official-modules/{category}/{slug}/（随仓库版本化，与
 * md 模板、骨架包同一套「内置资产」模式）。模块内容为平台维护的参考实现——来源是
 * 既有模板「常见模式范式」章 + 骨架示例 + learnings 沉淀纪律；真实行为验证由 Agent
 * 接入后的 GWT 断言兜底（自动蒸馏器 P1 主体二期再议）。
 */

/** slug 命名：小写英文 kebab（目录名与 module.json.slug 必须一致）。 */
export const MODULE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 模块文件后缀白名单（与 agent-tools WRITABLE_EXTENSIONS 对齐子集：源码 + 样式）。 */
const MODULE_FILE_EXTENSIONS = new Set(['.js', '.css'])

/** 合法产物类型集合（categories 每项必须是 TemplateType）。 */
const VALID_TYPES = new Set<TemplateType>(['web_fullstack', 'desktop_tool', 'personal_tool', 'game', 'ai_app'])

/** 官方模块目录名（物化到项目内的只读参考目录；与 agent-tools READONLY_DIR_PREFIXES 同源）。 */
export const OFFICIAL_MODULES_DIR = 'src/official-modules'
/** 经验库正向参考物化目录（G4；同协议只读参考，与官方目录隔离）。 */
export const REF_MODULES_DIR = 'src/ref-modules'

/** 模块地图文本总长上限（catalog 行 + 纪律 + 统计；防上下文膨胀，超长截断）。 */
const MAP_MAX_CHARS = 2400

export interface OfficialModuleFile {
  path: string
  role?: string
}

export interface OfficialModule {
  slug: string
  name: string
  categories: TemplateType[]
  version: number
  summary: string
  whenToUse: string
  whenNotToUse: string
  files: OfficialModuleFile[]
  /** 模块源目录（渲染时逐文件复制）。 */
  baseDir: string
  /** builtin=仓内预置手写；ref=经验库 verified pattern（G4，sidecar 源）。 */
  source: 'builtin' | 'ref'
}

export interface ModuleLoadResult {
  /** 校验合法且适用于目标产物类型的模块（按 slug 稳定排序）。 */
  modules: OfficialModule[]
  /** 校验失败的模块（slug + 原因；由调用方落决策日志，不阻断）。 */
  rejected: { slug: string; reason: string }[]
}

export interface ModuleRenderResult {
  written: string[]
  skipped: string[]
}

/** 模块库总开关：缺省开启；BLOMA_MODULES=0/off/false 关闭（关闭后行为=现状）。 */
export function modulesEnabled(): boolean {
  const raw = process.env.BLOMA_MODULES
  if (!raw) return true
  const value = raw.trim().toLowerCase()
  return value !== '0' && value !== 'off' && value !== 'false'
}

function extnameOf(path: string): string {
  const idx = path.lastIndexOf('.')
  return idx >= 0 ? path.slice(idx).toLowerCase() : ''
}

/** 模块文件路径校验：非空、无 ../ 与绝对路径、后缀在白名单（防 module.json 携带越界路径）。 */
function isSafeModulePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false
  const normalized = path.replace(/\\/g, '/')
  if (normalized.includes('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false
  return MODULE_FILE_EXTENSIONS.has(extnameOf(normalized))
}

/** 内置模块源根目录（源码运行=main/templates/；esbuild bundle 后=dist-main/main/templates/，两态同源）。注：本文件在 main/coding/ 下，需回一级到 main/templates（PR1 归位后路径加深一层）。 */
function moduleRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'official-modules')
}

/**
 * 静态外链依赖扫描：模块源码必须是「无外部依赖」的 vanilla ES2022 实现（同产物依赖白名单）。
 * 拒绝 http(s) 静态 import / 网络 API（fetch/XMLHttpRequest/WebSocket）——沙箱 CSP connect-src
 * none 下这些本就不可用，禁止它们进入参考实现防误导 Agent 写出被拦截的代码。
 */
function hasExternalDependency(content: string): boolean {
  return (
    /(?:import|export)\s+[^;]*?from\s*['"]https?:\/\//i.test(content) ||
    /import\s*\(\s*['"]https?:\/\//i.test(content) ||
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(content)
  )
}

/** 读取单个模块目录：module.json 合法 + 文件真实存在 + 无外链依赖，才返回模块。 */
function readModuleDir(slug: string, dir: string): { module?: OfficialModule; reason?: string } {
  try {
    const manifestPath = join(dir, 'module.json')
    if (!existsSync(manifestPath)) return { reason: 'module.json 缺失' }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      slug?: string
      name?: string
      categories?: unknown[]
      version?: number
      summary?: string
      whenToUse?: string
      whenNotToUse?: string
      files?: unknown[]
    }
    if (typeof manifest.slug !== 'string' || manifest.slug !== slug) return { reason: 'slug 缺失或与目录名不一致' }
    if (!MODULE_SLUG_PATTERN.test(manifest.slug)) return { reason: 'slug 非小写英文 kebab' }
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) return { reason: 'name 缺失' }
    if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) return { reason: 'categories 缺失或为空' }
    if (!manifest.categories.every((c) => typeof c === 'string' && VALID_TYPES.has(c as TemplateType))) {
      return { reason: 'categories 含非法产物类型' }
    }
    if (typeof manifest.version !== 'number' || manifest.version < 1) return { reason: 'version 非法' }
    if (typeof manifest.summary !== 'string' || !manifest.summary.trim()) return { reason: 'summary 缺失' }
    if (typeof manifest.whenToUse !== 'string' || !manifest.whenToUse.trim()) return { reason: 'whenToUse 缺失' }
    if (typeof manifest.whenNotToUse !== 'string' || !manifest.whenNotToUse.trim()) return { reason: 'whenNotToUse 缺失' }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { reason: 'files 缺失或为空' }

    const files: OfficialModuleFile[] = []
    for (const raw of manifest.files) {
      const entry = raw as { path?: string; role?: string }
      if (!isSafeModulePath(entry.path ?? '')) return { reason: `files 路径非法：${String(entry?.path)}` }
      const abs = join(dir, entry.path as string)
      if (!existsSync(abs) || !statSync(abs).isFile()) return { reason: `文件不存在：${entry.path}` }
      if (extnameOf(entry.path as string) === '.js') {
        if (hasExternalDependency(readFileSync(abs, 'utf8'))) return { reason: `源码含外部依赖：${entry.path}` }
      }
      files.push({ path: entry.path as string, ...(typeof entry.role === 'string' ? { role: entry.role } : {}) })
    }

    return {
      module: {
        slug: manifest.slug,
        name: manifest.name.trim(),
        categories: manifest.categories as TemplateType[],
        version: manifest.version,
        summary: manifest.summary.trim(),
        whenToUse: manifest.whenToUse.trim(),
        whenNotToUse: manifest.whenNotToUse.trim(),
        files,
        baseDir: dir,
        source: 'builtin',
      },
    }
  } catch {
    return { reason: 'module.json 解析失败' }
  }
}

/**
 * 加载适用于目标产物类型的官方模块（单点收口）。
 * 扫描内置源根下所有分类目录与 slug 目录；单个模块非法 → 跳过并归入 rejected（由调用方
 * 落决策日志），不因坏模块阻断整批。源根缺失/开关关闭由调用方在 `modulesEnabled()` 层处理。
 * @param rootDir 模块源根目录（测试注入 fixture 用；缺省用内置 main/templates/official-modules）
 */
export function loadOfficialModules(type: TemplateType, rootDir?: string): ModuleLoadResult {
  const root = rootDir ?? moduleRootDir()
  const modules: OfficialModule[] = []
  const rejected: { slug: string; reason: string }[] = []
  if (!existsSync(root)) return { modules, rejected }

  let categories: string[] = []
  try {
    categories = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory())
  } catch {
    return { modules, rejected }
  }

  for (const category of categories.sort()) {
    const categoryDir = join(root, category)
    let slugs: string[] = []
    try {
      slugs = readdirSync(categoryDir).filter((name) => statSync(join(categoryDir, name)).isDirectory())
    } catch {
      continue
    }
    for (const slug of slugs.sort()) {
      const { module, reason } = readModuleDir(slug, join(categoryDir, slug))
      if (!module) {
        rejected.push({ slug: `${category}/${slug}`, reason: reason ?? '未知原因' })
        continue
      }
      if (module.categories.includes(type)) modules.push(module)
    }
  }
  // slug 稳定排序（注入文本可测）
  modules.sort((a, b) => a.slug.localeCompare(b.slug))
  return { modules, rejected }
}

/**
 * 把官方模块物化到项目 `src/official-modules/{slug}/`（纯 fs，幂等）。
 * 逐文件：目标存在 → skip；否则 mkdir -p + 复制。返回文件级 written/skipped 清单。
 */
export function renderOfficialModulesToProject(modules: OfficialModule[], rootPath: string): ModuleRenderResult {
  const written: string[] = []
  const skipped: string[] = []
  for (const mod of modules) {
    const dir = mod.source === 'ref' ? REF_MODULES_DIR : OFFICIAL_MODULES_DIR
    for (const file of mod.files) {
      const rel = `${dir}/${mod.slug}/${file.path}`
      const target = join(rootPath, dir, mod.slug, file.path)
      if (existsSync(target)) {
        skipped.push(rel)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(join(mod.baseDir, file.path), 'utf8'), 'utf8')
      written.push(rel)
    }
  }
  return { written, skipped }
}

/**
 * 模块地图（注入 system prompt）：catalog 行（slug/名称/摘要/适用/不用）+ 使用纪律 + 渲染统计。
 * 只在模块实际物化成功后由编排器传入（事实与注入同源）；返回 null = 无模块。
 */
export function buildModuleMapInjection(modules: OfficialModule[], rendered: ModuleRenderResult): string | null {
  if (modules.length === 0) return null
  const hasRefs = modules.some((mod) => mod.source === 'ref')
  const catalogLines = modules.map((mod) => {
    const head = mod.source === 'ref' ? `- ref:${mod.slug}` : `- ${mod.slug}`
    const parts = [`${head}：${mod.name}——${mod.summary}`]
    if (mod.whenToUse) parts.push(`  适用：${mod.whenToUse}`)
    if (mod.whenNotToUse) parts.push(`  不用：${mod.whenNotToUse}`)
    return parts.join('\n')
  })
  const body = [
    '官方模块目录已就位（系统渲染，非你创建）：',
    `目录：${OFFICIAL_MODULES_DIR}/`,
    ...catalogLines,
    '',
    '使用纪律：',
    '1. read_file 查看模块源码后，把源码复制到业务文件（src/ 下新模块或并入现有 app.js）按需改编——产物自包含，不 import src/official-modules/ 下的文件。',
    `2. ${OFFICIAL_MODULES_DIR}/ 是只读参考目录：write_file/edit_file 会被拒绝，不要改写。`,
    '3. 模块是参考资产不是功能项；是否接入、接入多少由你按功能项判断，接入后仍以行为断言（GWT）为验收口径。',
    ...(hasRefs
      ? ['4. 标 ref: 的条目是经验库外部参考（检索+编译沙箱出证）：src/ref-modules/ 同为只读目录；许可/出处见各模块 README，先 read 后模仿改编，勿整段复制。']
      : []),
    `本轮渲染：新写入 ${rendered.written.length} 个文件，已存在跳过 ${rendered.skipped.length} 个。`,
  ].join('\n')
  return body.length > MAP_MAX_CHARS ? body.slice(0, MAP_MAX_CHARS) : body
}
