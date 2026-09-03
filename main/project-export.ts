/**
 * ProjectExport — U10 导出的「移交增强」层（PR-3 完整实现一个项目，2026-09-03）。
 *
 * 原实现（project-service.exportProject）是整目录无差别复制；本模块叠加移交语义：
 * - 排除非产物目录（node_modules/.git/dist/dist-main——对齐 agent-tools SKIPPED_DIRS）；
 * - 生成 README.md（项目名/定位/功能清单/启动方式/目录结构——数据自读 prd.json，
 *   不 import document-engine 以避免 project-service ↔ document-engine 循环依赖）；
 * - 生成 .gitignore（git init 友好）；
 * - README/.gitignore 一律「不存在才写」，不覆盖项目内已有文件（幂等，重复导出不改写）。
 *
 * 导出仍是只读语义：不触碰索引/会话/快照，不改变任何项目状态。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject } from './project-service'
import type { ProjectExportInput, ProjectExportResult, Project } from '../shared/types'

/** 导出排除目录（防御性：当前产物形态干净，为后续工程形态预留；与 agent-tools SKIPPED_DIRS 同集）。 */
const EXPORT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])

/** README 数据的最小 PRD 投影（自读 prd.json，解析失败/缺失回退 null 走极简 README）。 */
interface ReadmeBackplane {
  positioning?: string
  requirements?: Array<{ id?: string; description?: string }>
  out_of_scope?: string[]
}

function readBackplaneForReadme(project: Project): ReadmeBackplane | null {
  try {
    const path = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReadmeBackplane
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 带排除的递归复制（mkdir+copyFile 手动实现——cpSync 对 Windows 非 ASCII 目标会静默失败，同 project-service 口径）。 */
function copyProjectTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  if (!existsSync(src)) return
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXPORT_EXCLUDE_DIRS.has(entry.name)) continue
      copyProjectTree(join(src, entry.name), join(dest, entry.name))
    } else if (entry.isFile()) {
      copyFileSync(join(src, entry.name), join(dest, entry.name))
    }
  }
}

function renderReadme(project: Project, backplane: ReadmeBackplane | null): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const features = (backplane?.requirements ?? [])
    .filter((item) => item?.id && item?.description)
    .map((item) => `- [${item.id}] ${item.description}`)
  const outOfScope = (backplane?.out_of_scope ?? []).filter(Boolean)
  return [
    `# ${project.name}`,
    '',
    `> 本项目由 Bloma（向导 Agent 多智能体协同开发平台）生成，导出于 ${date}。`,
    '',
    '## 产品定位',
    '',
    backplane?.positioning || project.name,
    '',
    '## 功能清单',
    '',
    ...(features.length > 0 ? features : ['- （见源码实现）']),
    ...(outOfScope.length > 0 ? ['', '## 范围外（未实现）', '', ...outOfScope.map((entry) => `- ${entry}`)] : []),
    '',
    '## 启动方式',
    '',
    '需要 Node.js 18+（仅用内置模块，无需 npm install）：',
    '',
    '```bash',
    'npm start        # 等价于 node static-server.js，默认 http://localhost:3000',
    '```',
    '',
    '也可以直接用浏览器打开 index.html（本地数据用 localStorage 保存时推荐 npm start）。',
    '',
    '## 目录结构',
    '',
    '- index.html — 入口页（唯一 HTML 入口）',
    '- src/app.js — 交互逻辑入口',
    '- src/styles.css — 样式（骨架基线 + 业务扩展）',
    '- src/examples/ — 只读参考示例（可安全删除）',
    '- package.json / static-server.js — 平台托管的启动配置与本地静态服务器',
    '',
    '## 继续开发',
    '',
    '- 纯前端静态产物：无构建链、无外部依赖，改文件即生效；',
    '- 沙箱口径延续：不引入外部 CDN/网络请求，数据内联或 localStorage；',
    '- 交付后本目录与 Bloma 平台解耦，可直接 git init 纳管。',
    '',
  ].join('\n')
}

function renderGitignore(): string {
  return '# Bloma 导出项目\nnode_modules/\ndist/\ndist-main/\n.DS_Store\n*.log\n'
}

/** 递归统计文件数（普通文件；排除目录不计入）。 */
function countFiles(dir: string): number {
  let count = 0
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXPORT_EXCLUDE_DIRS.has(entry.name)) continue
      count += countFiles(join(dir, entry.name))
    } else if (entry.isFile()) count += 1
  }
  return count
}

function sanitizeFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
  return cleaned.length > 0 ? cleaned : '未命名项目'
}

/**
 * 导出项目（移交增强版）：复制到 destination/项目名/ 并生成 README.md 与 .gitignore。
 * 幂等：README/.gitignore 仅在目标不存在时写入；已有文件一律以项目内容为准。
 */
export function exportProjectHandoff(input: ProjectExportInput, destination: string): ProjectExportResult {
  const project = findProject(input.project_id)
  const target = join(destination, sanitizeFolderName(project.name))
  copyProjectTree(project.root_path, target)

  const backplane = readBackplaneForReadme(project)
  const readmePath = join(target, 'README.md')
  if (!existsSync(readmePath)) writeFileSync(readmePath, renderReadme(project, backplane), 'utf8')
  const gitignorePath = join(target, '.gitignore')
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, renderGitignore(), 'utf8')

  return { canceled: false, destination: target, file_count: countFiles(target) }
}
