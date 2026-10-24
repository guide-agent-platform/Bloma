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
import { dirname, join } from 'node:path'
import { isSoftwareProject } from '../desktop/workflow-policy'
import { readLaunchDeclaration } from '../desktop/launch-smoke'
import { getDocumentsDir } from '../../storage/config-paths'
import { findProject } from '../project/project-service'
import { assertExportPathNotLink, resolveProjectExportTarget } from '../project/export-target'
import { buildExportManifest, exportManifestEnabled, MANIFEST_FILE, readProjectGitCommit, writeExportManifest } from '../coding/export-manifest'
import type { ProjectExportInput, ProjectExportResult, Project } from '../../shared/types'

/** 导出排除目录（防御性：当前产物形态干净，为后续工程形态预留；与 agent-tools SKIPPED_DIRS 同集）。 */
const EXPORT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])

/** README 数据的最小 PRD 投影（自读 prd.json，解析失败/缺失回退 null 走极简 README）。 */
interface ReadmeBackplane {
  positioning?: string
  requirements?: Array<{ id?: string; description?: string }>
  out_of_scope?: string[]
  interface_spec?: Array<{ endpoint?: string; method?: string; request?: string; response?: string }>
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
function copyProjectTree(src: string, dest: string, software = false, artifactDir?: string, rel = ''): void {
  assertExportPathNotLink(dest)
  mkdirSync(dest, { recursive: true })
  if (!existsSync(src)) return
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const inArtifact = artifactDir && (childRel === artifactDir || childRel.startsWith(`${artifactDir}/`))
      if (software ? entry.name === '.git' || ['.venv', 'venv', '__pycache__', '.pytest_cache'].includes(entry.name)
        || entry.name === 'node_modules' && !inArtifact : EXPORT_EXCLUDE_DIRS.has(entry.name)) continue
      copyProjectTree(join(src, entry.name), join(dest, entry.name), software, artifactDir, childRel)
    } else if (entry.isFile()) {
      assertExportPathNotLink(join(dest, entry.name))
      copyFileSync(join(src, entry.name), join(dest, entry.name))
    }
  }
}

function renderReadme(project: Project, backplane: ReadmeBackplane | null): string {
  if (isSoftwareProject(project.project_id)) {
    const declared = readLaunchDeclaration(project.root_path)
    return [`# ${project.name}`, '', backplane?.positioning || project.name, '', '## 使用', '',
      '在Bloma交付面板点击「启动程序」。运行配置、依赖与已知限制以本项目DELIVERY.md和LAUNCH.json为准。', '',
      declared?.ok ? `实际入口：\`${declared.launch.command.join(' ')}\`` : '当前没有有效的启动声明。', '',
      '## 导出内容', '',
      '本包保留源码和已有构建产物，开发依赖目录未随源码复制。源码包在另一台机器上需要相应运行环境和依赖；不等于独立安装包。',
      declared?.ok && declared.launch.artifact ? `声明的打包产物：${declared.launch.artifact}。能否脱离本机使用，以该包的独立运行验证为准。` : '本项目未声明独立打包产物。', '',
      '用户运行数据由Bloma存放在项目专属数据目录，不混入源码导出包；迁移数据应另行备份。', '',
      ...(backplane?.requirements ?? []).map(item => `- ${item.id ?? ''} ${item.description ?? ''}`), ''].join('\n')
  }
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const features = (backplane?.requirements ?? [])
    .filter((item) => item?.id && item?.description)
    .map((item) => `- [${item.id}] ${item.description}`)
  const outOfScope = (backplane?.out_of_scope ?? []).filter(Boolean)
  const endpoints = (backplane?.interface_spec ?? []).filter((ep) => ep?.endpoint)
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
    ...(endpoints.length > 0
      ? [
          '',
          '## 后端 API（前后端契约）',
          '',
          ...endpoints.map((ep) => `- \`${ep.method ?? 'GET'} ${ep.endpoint}\` → ${ep.response ?? 'JSON'}${ep.request && ep.request !== '无' ? `（请求：${ep.request}）` : ''}`),
        ]
      : []),
    '',
    '## 架构（前后端分离）',
    '',
    '- 前端：index.html + src/（浏览器侧只发同源请求，不持有任何密钥）；',
    '- 后端：server/routes/*.js（文件名即路由前缀，notes.js → /api/notes/*），由 static-server.js 自动挂载，改完文件下一次请求即生效；',
    '- 数据：data/ 目录（JSON 持久化，重启不丢）；快照/回滚语义包含 data/。',
    '',
    '## 启动方式',
    '',
    '需要 Node.js 18+（仅用内置模块，无需 npm install）：',
    '',
    '```bash',
    'npm start        # 等价于 node static-server.js，默认 http://localhost:3000',
    '```',
    '',
    '请通过本地服务器访问（后端 API 依赖 Node 进程；直接双击 index.html 无法访问 /api/*）。',
    '',
    ...(endpoints.length > 0
      ? [
          '## AI 能力配置（可选）',
          '',
          '应用内的 AI 功能经同源 /api/llm 代理调用真实模型，密钥经环境变量注入服务器进程（不写入任何代码文件）：',
          '',
          '```bash',
          'BLOMA_APP_LLM_BASE_URL=https://api.deepseek.com \\',
          'BLOMA_APP_LLM_KEY=sk-你的密钥 \\',
          'BLOMA_APP_LLM_MODEL=你的模型名 \\',
          'npm start',
          '```',
          '',
          '未配置时 /api/llm 返回 503 llm_not_configured（应用的失败态兜住，其余功能不受影响）。',
          '',
        ]
      : []),
    '',
    '## 目录结构',
    '',
    '- index.html — 入口页（唯一 HTML 入口）',
    '- src/app.js — 前端交互逻辑入口',
    '- src/styles.css — 样式（骨架基线 + 业务扩展）',
    '- server/routes/ — 后端 API 路由（文件名即路由前缀）',
    '- data/ — 运行数据（JSON 持久化，随版本快照/回滚）',
    '- src/examples/ — 只读参考示例（可安全删除）',
    '- package.json / static-server.js — 平台托管的启动配置与应用服务器',
    '',
    '## 继续开发',
    '',
    '- 无构建链、无外部依赖：改文件即生效（路由文件热加载，保存后下一次请求生效）；',
    '- 浏览器侧仅同源请求；外部出网只发生在服务器进程（含 /api/llm 模型代理）；',
    '- 交付后本目录与 Bloma 平台解耦，可直接 git init 纳管。',
    '',
  ].join('\n')
}

function renderGitignore(): string {
  return '# Bloma 导出项目\nnode_modules/\ndist/\ndist-main/\n.DS_Store\n*.log\n'
}

/** 递归统计文件数（普通文件；排除目录不计入）。 */
function countFiles(dir: string, software = false): number {
  let count = 0
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!software && EXPORT_EXCLUDE_DIRS.has(entry.name)) continue
      count += countFiles(join(dir, entry.name), software)
    } else if (entry.isFile()) count += 1
  }
  return count
}

/**
 * 导出项目（移交增强版）：复制到 destination/项目名/ 并生成 README.md 与 .gitignore。
 * 幂等：README/.gitignore 仅在目标不存在时写入；已有文件一律以项目内容为准。
 */
export function exportProjectHandoff(input: ProjectExportInput, destination: string): ProjectExportResult {
  const project = findProject(input.project_id)
  const target = resolveProjectExportTarget(destination, project.name)
  const software = isSoftwareProject(project.project_id), launch = software ? readLaunchDeclaration(project.root_path) : undefined
  const artifactDir = launch?.ok && launch.launch.artifact ? dirname(launch.launch.artifact).replaceAll('\\', '/') : undefined
  copyProjectTree(project.root_path, target, software, artifactDir === '.' ? undefined : artifactDir)

  const backplane = readBackplaneForReadme(project)
  const readmePath = join(target, 'README.md')
  if (!existsSync(readmePath)) writeFileSync(readmePath, renderReadme(project, backplane), 'utf8')
  const gitignorePath = join(target, '.gitignore')
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, software ? 'node_modules/\n.git/\n.venv/\n*.log\n' : renderGitignore(), 'utf8')

  // Phase 7 U3 I8（2026-09-10）：导出包带版本标识（每次导出覆盖写——与 README 首写
  // 幂等不同，导出信息应反映本次导出时点）：源版本/导出时间/交付状态已知限制。
  // 「导出后线上状态未知」——部署后是否可用不归平台观测，UI 侧同步标注。
  try {
    const exportInfo = {
      exported_at: new Date().toISOString(),
      source_snapshot_id: project.current_snapshot_id ?? null,
      delivery_status: project.delivery_status ?? 'not_evaluated',
      note:
        project.delivery_status === 'verified'
          ? '导出时点的验证状态：关键任务已通过验证。部署后的实际状态需要你自行确认（平台无法观测线上环境）。'
          : project.delivery_status
            ? '导出时点的验证状态：存在未通过或未验证的部分（详见导出时的验证报告）。部署后的实际状态需要你自行确认（平台无法观测线上环境）。'
            : '导出时点未执行交付状态评估。部署后的实际状态需要你自行确认（平台无法观测线上环境）。',
    }
    writeFileSync(join(target, 'export-info.json'), JSON.stringify(exportInfo, null, 2), 'utf8')
  } catch {
    // 导出信息失败不阻断导出主链
  }

  // Phase 10 W1-6（BLOMA_EXPORT_V2 off=字节级现状）：导出包带文件 manifest 与
  // v2 字段（project_id/git 基线）——漂移对账与升级链的地基；fail-open 不阻断导出。
  if (exportManifestEnabled()) {
    try {
      const manifest = buildExportManifest(target)
      writeExportManifest(target, manifest)
      const v2 = {
        exported_at: new Date().toISOString(),
        project_id: project.project_id,
        source_snapshot_id: project.current_snapshot_id ?? null,
        git_commit: readProjectGitCommit(project.root_path) ?? null,
        manifest: { file: MANIFEST_FILE, files: Object.keys(manifest).length, algorithm: 'sha256-16' },
        note: 'export-manifest.json 是本包文件清单（升级前可用其对账手改）；升级流程见 upgrade-report 约定。',
      }
      writeFileSync(join(target, 'export-info.json'), JSON.stringify(v2, null, 2), 'utf8')
    } catch {
      // manifest 失败不阻断导出主链
    }
  }

  return { canceled: false, destination: target, file_count: countFiles(target, software) }
}
