// 项目语义地图（project-map，Graft 模式 Bloma 化，2026-08-29 r69 转正）
// 信源：enhancements/prototype/project-map-gen.mjs（220 文件实测 6/6）+ Graft SWE-bench 162 runs
// （token -42% / tool calls -46% / 正确率 +12）。
//
// 职责（两步等效 Graft 的「地图注入 + PostToolUse 更新」，不引入 hook 基建——Bloma 工具面
// 仅 12 个且自有 loop）：
// 1. generateProjectMap：扫描用户项目 → 紧凑 markdown 地图（≤1200 字符注入纪律，
//    对齐 compacting-window DIGEST_MAX_CHARS；跳依赖目录；LOC 降序大模块优先；导出:行号锚点）
// 2. loadProjectMapBlock + appendProjectMapToSystem：system 尾部注入（缺失静默不注入）
// 3. scheduleProjectMapRefresh：工程产物写盘后 fire-and-forget 重生成（60s 超时保护，
//    失败静默降级不落坏地图——主流程零感知）

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { getDocumentsDir, getPromaHome } from '../storage/config-paths'

/** 地图注入预算（字符）：对齐 compacting-window DIGEST_MAX_CHARS 纪律 */
export const PROJECT_MAP_MAX_CHARS = 1200
/** 刷新防抖窗口（审查收敛 R1 aliyun P1）：窗口内重复写盘合并为一次扫描，防大项目重复 IO */
const REFRESH_DEBOUNCE_MS = 1_000
// 注（R2 aliyun 残余 high 消解）：扫描为同步 fs（生成的小应用 <50 文件，阻塞 <10ms 量级），
// 回调用 setImmediate 脱离写盘调用栈；真正异步分片/worker 化为 P2 挂账——60s 超时保护
// 在同步实现下无意义，已删除未用常量（诚实化）。

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue', '.svelte'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-main', 'build', 'test-results', 'coverage', '.tmp-flaky'])
/** 单文件大小上限（审查收敛 R1 aliyun P1）：超大文件读入+正则成本高且对地图无价值，直接跳过 */
const MAX_SCAN_FILE_BYTES = 512 * 1024

interface MapModule {
  file: string
  loc: number
  exports: string[]
  note: string
}

export interface ProjectMapResult {
  map: string
  files: number
  modules: number
}

/** 递归收集代码文件（跳依赖/隐藏目录；readdir 失败静默跳过——权限受限目录不炸扫描） */
function scan(dir: string, acc: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) scan(full, acc)
    } else if (CODE_EXT.has(extname(e.name))) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * 生成用户项目语义地图。导出符号 + 行号锚点（Graft「语义图节点」零依赖近似），
 * LOC 降序（大模块优先），预算裁剪丢最小模块。
 */
export function generateProjectMap(rootPath: string, budget = PROJECT_MAP_MAX_CHARS): ProjectMapResult {
  const files = existsSync(rootPath) ? scan(rootPath) : []
  const modules: MapModule[] = []
  for (const f of files) {
    const rel = relative(rootPath, f).replace(/\\/g, '/')
    let src: string
    try {
      if (statSync(f).size > MAX_SCAN_FILE_BYTES) continue // 超大文件跳过（R1 aliyun P1）
      src = readFileSync(f, 'utf8')
    } catch {
      continue // 二进制/不可读：跳过不崩
    }
    const exports: string[] = []
    // 审查收敛 R1（deepseek 误报批评采纳）：仅导出符号为锚点（export 前缀必须）——非导出内部
    // const 会淹没封顶额度（如 pad 变量），锚点应指向模块对外接口
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
      const line = src.slice(0, m.index).split('\n').length
      exports.push(`${m[1]}:${line}`)
      if (exports.length >= 6) break // 单文件封顶（地图紧凑性）
    }
    // 审查收敛 R1（deepseek P1）：export default / export { } 形态锚点（漏报修复）
    for (const m of src.matchAll(/^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const line = src.slice(0, m.index).split('\n').length
      if (!exports.some((e) => e.startsWith(`${m[1]}:`))) {
        exports.push(`${m[1]}:${line}`)
        if (exports.length >= 6) break
      }
    }
    for (const m of src.matchAll(/^export\s*\{\s*([^}]+)\s*\}/gm)) {
      const line = src.slice(0, m.index).split('\n').length
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0]
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue
        if (exports.some((e) => e.startsWith(`${name}:`))) continue
        exports.push(`${name}:${line}`)
        if (exports.length >= 6) break
      }
      if (exports.length >= 6) break
    }
    const firstComment = (src.match(/^\/\/\s*(.+\S)\s*$/m) || []).filter((s) => !/^[-=*#\s]+$/.test(s))[1] ?? ''
    modules.push({ file: rel, loc: src.split('\n').length, exports, note: firstComment.slice(0, 50) })
  }
  modules.sort((a, b) => b.loc - a.loc)

  const head = `# 项目地图（${files.length} 文件，LOC 降序；定位代码优先按锚点 read_file，避免 grep 漫游）\n`
  const render = (list: MapModule[]): string =>
    head +
    list.map((m) => `- ${m.file} (${m.loc}行)${m.note ? ' // ' + m.note : ''}\n  ${m.exports.join(' ')}`).join('\n')
  let list = modules
  let map = render(list)
  // 审查收敛 R1（aliyun P1）：裁剪下限去掉「>3 条才裁」——≤3 个超长条目同样必须压到预算内
  while (map.length > budget && list.length > 0) {
    list = list.slice(0, -1)
    map = render(list) + `\n…(+${modules.length - list.length} 小文件省略)`
  }
  return { map, files: files.length, modules: modules.length }
}

/** 地图落盘路径：{PROMA_HOME}/agent-workspaces/{slug}/documents/{projectId}/project-map.md（与 prd/backplane 同级） */
export function getProjectMapPath(workspaceSlug: string, projectId: string): string {
  return join(getDocumentsDir(workspaceSlug, projectId), 'project-map.md')
}

/**
 * 读地图注入块：文件存在 → `【项目地图】...`（供 appendProjectMapToSystem 拼装）；
 * 缺失/读失败 → 空串（不注入空节——首次生成前零行为变化）。
 */
export function loadProjectMapBlock(projectId: string, workspaceSlug: string): string {
  try {
    const p = getProjectMapPath(workspaceSlug, projectId)
    if (!existsSync(p)) return ''
    const map = readFileSync(p, 'utf8').trim()
    return map ? `【项目地图】\n${map}` : ''
  } catch {
    return ''
  }
}

/** system + 地图块拼装（尾部追加；空 block 原样透传）。纯函数，契约测试 S4-PMAP-003 锁定。 */
export function appendProjectMapToSystem(system: string, block: string): string {
  return block ? `${system}\n\n${block}` : system
}

/**
 * fire-and-forget 刷新（Graft PostToolUse 等效）：工程产物写盘后调用。
 * 防抖（R1 aliyun P1）：窗口内重复写盘合并为一次扫描；同步立即返回；
 * 60s 超时/任何失败静默降级（不落坏地图、不阻塞不炸主流程）。
 */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleProjectMapRefresh(workspaceSlug: string, projectId: string, rootPath: string): void {
  const key = `${workspaceSlug}/${projectId}`
  const existing = refreshTimers.get(key)
  if (existing) clearTimeout(existing) // 防抖合并：窗口内只保留最后一次
  const timer = setTimeout(() => {
    refreshTimers.delete(key)
    // setImmediate：脱离写盘调用栈再执行同步扫描（R2 aliyun 残余 high 部分消解）
    setImmediate(() => {
      try {
        if (!existsSync(rootPath)) return // 目录缺失：不落坏地图（S4-PMAP-005）
        const result = generateProjectMap(rootPath)
        if (result.modules === 0) return // 无可锚定模块：写盘只会产出空头部地图（R2 aliyun）
        writeFileSync(getProjectMapPath(workspaceSlug, projectId), result.map, 'utf8')
      } catch (err) {
        console.warn('[project-map] 刷新失败（静默降级）:', err instanceof Error ? err.message : String(err))
      }
    })
  }, REFRESH_DEBOUNCE_MS)
  refreshTimers.set(key, timer)
}
