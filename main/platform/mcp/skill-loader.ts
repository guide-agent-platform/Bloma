import { readdir, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'
import { findProject } from '../../project/project-service'

/**
 * Skill 机制（2026-08-28，guidance v5 ①）：团队 SOP 的文件级沉淀 + 按需注入。
 *
 * 五层管线（信源：Proma pi-agent-adapter.ts:396-590，r14 方向 A 原型 16/16 转正）：
 * ① 发现 discoverSkills——扫各白名单根下一级目录的 SKILL.md，frontmatter name 优先/目录名回退；
 * ② 安全——白名单根 + realpath 过滤（junction/符号链接逃逸拦截；SkillSec-Eval
 *    admission 防线，2026-06「Fake AI Agent Skill」事件佐证）；
 * ③ 触发——`/skill:name` 斜杠命令（多命令去重保序）；
 * ④ 注入——用户消息前置 `<skill>` block（strip frontmatter + XML 转义），非 system 注入
 *    ——激活只影响当条消息，随 agent-loop 消息窗口自然滑出，不永久污染 system token；
 * ⑤ 延迟激活 tracker 不移植（Proma UI 双轨特有问题，Bloma 无此架构）。
 *
 * [DECISION] 全局根用 <PROMA_HOME>/skills 而非字面 %USERPROFILE%/.bloma/skills：
 * 与 prompts/ 覆盖目录同一约定，且天然服从 PROMA_HOME 测试隔离。
 */

// ---------- 数据结构 ----------

export interface DiscoveredSkill {
  /** frontmatter.name 优先，回退目录名 */
  name: string
  /** frontmatter.description ?? '' */
  description: string
  /** SKILL.md 所在目录名 */
  dirName: string
  /** 绝对路径 */
  filePath: string
  /** 剥离 frontmatter 后的正文 */
  body: string
  /** 所属白名单根（realpath 后） */
  root: string
}

export interface PreparedPrompt {
  content: string
  activatedSkills: string[]
}

interface SkillAttrs {
  name?: string
  description?: string
}

// ---------- frontmatter 解析（BOM / `---` / `...` 结尾 / key: value 简易 YAML） ----------

function parseFrontmatter(raw: string): { attrs: SkillAttrs; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '')
  const m = normalized.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)
  if (!m) return { attrs: {}, body: normalized }
  const attrs: SkillAttrs = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    if (kv[1] === 'name' || kv[1] === 'description') {
      attrs[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { attrs, body: normalized.slice(m[0].length) }
}

// ---------- 白名单过滤（realpath 解析，防 junction/符号链接逃逸） ----------

function resolveGuardedRealPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

// ---------- 发现：扫 roots 下 */SKILL.md ----------

export async function discoverSkills(roots: string[]): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = []
  for (const root of roots) {
    const guardedRoot = resolveGuardedRealPath(root)
    let entries: Dirent[]
    try {
      entries = await readdir(guardedRoot, { withFileTypes: true })
    } catch {
      continue // 根不存在/不可读 → 跳过该根（零异常）
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const filePath = join(guardedRoot, entry.name, 'SKILL.md')
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      // 逃逸拦截：junction/符号链接把 SKILL.md 指到白名单根外 → 不加载
      const guardedPath = resolveGuardedRealPath(filePath)
      if (!isPathWithinRoot(guardedPath, guardedRoot)) continue
      const { attrs, body } = parseFrontmatter(raw)
      const trimmed = body.trim()
      if (!attrs.name && !trimmed) continue // 空文件且无名 → 忽略
      out.push({
        name: attrs.name || entry.name,
        description: attrs.description ?? '',
        dirName: entry.name,
        filePath,
        body: trimmed,
        root: guardedRoot,
      })
    }
  }
  return out
}

// ---------- 别名索引（name/dirName，先到先得不覆盖：roots 参数顺序即优先级） ----------

export function buildSkillLookup(skills: DiscoveredSkill[]): Map<string, DiscoveredSkill> {
  const lookup = new Map<string, DiscoveredSkill>()
  for (const skill of skills) {
    for (const alias of new Set([skill.name, skill.dirName, basename(dirname(skill.filePath))])) {
      if (!lookup.has(alias)) lookup.set(alias, skill)
    }
  }
  return lookup
}

// ---------- /skill:name 命令提取（多命令去重保序） ----------

const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

export function extractSkillCommandNames(prompt: string): string[] {
  const names: string[] = []
  for (const m of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const n = m[1]?.trim()
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}

// ---------- prompt 前置注入（strip frontmatter + XML 转义 + 原文在后） ----------

function escapeXmlAttr(v: string): string {
  // 单引号同转（r51 aliyun high 采纳）：属性虽用双引号包裹，转义单引号可防御未来单引号包裹的模板/下游解析器
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')
}

export async function preparePromptWithSkills(lookup: Map<string, DiscoveredSkill>, prompt: string): Promise<PreparedPrompt> {
  const requested = extractSkillCommandNames(prompt)
  if (requested.length === 0) return { content: prompt, activatedSkills: [] }
  const blocks: string[] = []
  const activated: string[] = []
  const injected = new Set<string>()
  for (const name of requested) {
    const skill = lookup.get(name)
    if (!skill || injected.has(skill.name) || !skill.body) continue // 未知命令/空正文静默忽略
    injected.add(skill.name)
    activated.push(skill.name)
    blocks.push(
      `<skill name="${escapeXmlAttr(skill.name)}" location="${escapeXmlAttr(skill.filePath)}">\n` +
        `References are relative to ${dirname(skill.filePath)}.\n\n${skill.body}\n</skill>`,
    )
  }
  if (blocks.length === 0) return { content: prompt, activatedSkills: [] }
  return { content: `${blocks.join('\n\n')}\n\n${prompt}`, activatedSkills: activated }
}

// ---------- 两级白名单根（项目级优先 + 全局兜底） ----------

/**
 * 项目级 `<projectRoot>/.bloma/skills/` + 全局 `<PROMA_HOME>/skills/`，项目优先。
 * 项目不存在（孤儿 id/单测场景）→ 只回全局根，不抛 PROJECT_NOT_FOUND。
 */
export function resolveSkillRoots(projectId?: string): string[] {
  const roots: string[] = []
  if (projectId) {
    try {
      roots.push(join(findProject(projectId).root_path, '.bloma', 'skills'))
    } catch {
      // 项目不存在 → 跳过项目级根
    }
  }
  roots.push(join(getPromaHome(), 'skills'))
  return roots
}

/**
 * agent-loop 一次 hook 入口：任务含 /skill: 命令时发现+注入；无命令零 IO 返回原文。
 * 委派子 loop 复用同一 runAgentLoop 入口，自动获得同等能力。
 */
export async function prepareTaskWithSkills(task: string, projectId?: string): Promise<PreparedPrompt> {
  if (extractSkillCommandNames(task).length === 0) return { content: task, activatedSkills: [] }
  const skills = await discoverSkills(resolveSkillRoots(projectId))
  return preparePromptWithSkills(buildSkillLookup(skills), task)
}
