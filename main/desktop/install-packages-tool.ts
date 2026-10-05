/**
 * install_packages 受控安装刀（2026-10-05 迁移批：P1 依赖自由度）。
 *
 * 对位竞品差异：Proma-Easy 靠子会话通用 Bash 直接 pip install（Linux 实证环境的
 * 自然路径）；Bloma 裁决边界无 shell，故造声明制安装通道——收窄口径与
 * run_project_script 同族：
 * - 只装「声明的包」：入参包列表（名称+版本约束白名单格式）或 requirements.txt 全文；
 * - venv 隔离：项目根 .venv（首次安装时 python -m venv 创建），绝不污染系统解释器；
 * - pip 走 venv 解释器 -m pip（无 shell、无任意命令；超时硬停 300s）；
 * - 安装后逐包 import 探测回读（卡片库 import_name 映射，Pillow→PIL 一类不踩坑）；
 * - 每子会话安装调用 ≤4 次（防反复装卸循环）；
 * - spawn 可注入（测试零真实子进程）；执行器复用 execFileDriverSpawn。
 * 配套一致性：child-exec-tool 的 run_project_script 在 .venv 存在时自动改用
 * venv 解释器；LAUNCH.json 的 command 教用 .venv\\Scripts\\python.exe（冒烟同源）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { execFileDriverSpawn, DriverExecutionError, type DriverSpawn } from './process-driver'
import { findProject } from '../project/project-service'
import { WINDOWS_COMPONENT_CARDS } from './component-library'

const PIP_TIMEOUT_MS = 300_000
const VENV_TIMEOUT_MS = 120_000
const MAX_INSTALL_CALLS = 4
/** 包名/版本约束白名单格式：字母数字开头的包名 + 可选 PEP 440 约束段 */
const PACKAGE_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\s*(==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9][A-Za-z0-9.+!*-]*)?$/
const MAX_PACKAGES_PER_CALL = 12

export interface InstallPackagesDeps {
  spawn?: DriverSpawn
  maxCalls?: number
}

/** Windows venv 解释器相对路径（当前产品 Windows-only；跨平台时补 bin/python 分支）。 */
export function venvPythonRelativePath(): string {
  return join('.venv', 'Scripts', 'python.exe')
}

/** 组件包名 → import 模块名（卡片库映射，未登记的回退包名自身；先剥版本约束段）。 */
function importNameOf(packageSpec: string): string {
  const base = packageSpec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? packageSpec.trim()
  const card = WINDOWS_COMPONENT_CARDS.find((item) => item.package.toLowerCase() === base.toLowerCase())
  return card?.importName ?? base.replace(/[-_]+/g, '_')
}

export function buildInstallPackagesTool(projectId: string, deps: InstallPackagesDeps = {}): AgentLoopTool {
  const spawn = deps.spawn ?? execFileDriverSpawn
  const maxCalls = deps.maxCalls ?? MAX_INSTALL_CALLS
  let calls = 0

  return {
    name: 'install_packages',
    description:
      '在项目内 .venv 安装声明的第三方包（声明制，无任意命令）：入参给包列表（如 ["pystray","Pillow>=10"]）' +
      '或 requirements=true 读项目根 requirements.txt。首次自动建 venv；装完逐包 import 探测回读；' +
      '装好后 run_project_script 与 LAUNCH 命令自动/应改用 .venv\\Scripts\\python.exe。' +
      '可用组件速查：pynput=全局热键注入｜pystray+Pillow=托盘｜sounddevice=录音播放｜pyperclip=剪贴板｜winotify=Toast 通知。' +
      `全程至多 ${maxCalls} 次安装调用。`,
    input_schema: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: '包声明列表（名称或 名称+版本约束，PEP 440 白名单格式）',
        },
        requirements: { type: 'boolean', description: 'true=安装项目根 requirements.txt 声明的全部包' },
      },
    },
    execute: async (input) => {
      calls += 1
      if (calls > maxCalls) {
        return {
          output: `安装调用预算用尽（${maxCalls} 次）：依赖问题请如实写进 DELIVERY.md 已知限制，不要反复装卸。`,
          isError: true,
        }
      }
      const project = findProject(projectId)
      const root = project?.root_path
      if (!root) return { output: `项目不存在（projectId=${projectId}）。`, isError: true }

      // 声明收集与白名单校验
      let specs: string[] = []
      if (input.requirements === true) {
        const reqPath = join(root, 'requirements.txt')
        if (!existsSync(reqPath)) {
          return { output: 'requirements.txt 不存在（先 write_file 声明依赖再安装）。', isError: true }
        }
        const { readFileSync } = await import('node:fs')
        specs = readFileSync(reqPath, 'utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
        if (specs.length === 0) return { output: 'requirements.txt 为空，无可安装声明。', isError: true }
      } else if (Array.isArray(input.packages)) {
        specs = input.packages.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      }
      if (specs.length === 0) {
        return { output: '未声明任何包：给 packages 列表或 requirements=true。', isError: true }
      }
      if (specs.length > MAX_PACKAGES_PER_CALL) {
        return { output: `单次至多 ${MAX_PACKAGES_PER_CALL} 个包（当前 ${specs.length}），分批安装。`, isError: true }
      }
      const bad = specs.filter((spec) => !PACKAGE_SPEC_RE.test(spec))
      if (bad.length > 0) {
        return { output: `包声明格式不合法（只允许 名称 或 名称+版本约束）：${bad.join('、')}`, isError: true }
      }

      const env = { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? 'utf-8' }
      const venvPython = join(root, venvPythonRelativePath())
      const steps: string[] = []

      // ① venv（幂等：已存在跳过）
      if (!existsSync(venvPython)) {
        try {
          await spawn({ command: ['python', '-m', 'venv', '.venv'], timeoutMs: VENV_TIMEOUT_MS, env, cwd: root })
          steps.push('已创建项目内 .venv（系统解释器零污染）')
        } catch (error) {
          return {
            output: `venv 创建失败：${error instanceof Error ? error.message : String(error)}（python 不在 PATH 时先用 probe_desktop_env 诊断）`,
            isError: true,
          }
        }
      }
      if (!existsSync(venvPython)) {
        return { output: `venv 创建命令成功但未找到解释器：${venvPythonRelativePath()}`, isError: true }
      }

      // ② pip 安装（venv 解释器 -m pip，无 shell）
      const startedAt = Date.now()
      try {
        const { code, stdout, stderr } = await spawn({
          command: [venvPython, '-m', 'pip', 'install', '--quiet', ...specs],
          timeoutMs: PIP_TIMEOUT_MS,
          env,
          cwd: root,
        })
        const durationMs = Date.now() - startedAt
        if (code !== 0) {
          return {
            output: [
              `pip install 退出码 ${code}（红，${durationMs}ms）——按报错修正声明（版本冲突/包名拼错/无网）后重试：`,
              `--- stderr（尾 2KB）---`,
              (stderr || stdout).slice(-2_048) || '（空）',
            ].join('\n'),
            isError: true,
          }
        }
        steps.push(`pip install 完成（${durationMs}ms）：${specs.join('、')}`)
      } catch (error) {
        if (error instanceof DriverExecutionError) {
          return { output: `安装失败（${error.kind}）：${error.message}。timeout 类不要反复重试。`, isError: true }
        }
        return { output: `安装异常：${error instanceof Error ? error.message : String(error)}`, isError: true }
      }

      // ③ 逐包 import 探测回读（卡片库 import_name 映射）
      const probeResults: string[] = []
      for (const spec of specs) {
        const moduleName = importNameOf(spec)
        try {
          const { code } = await spawn({
            command: [venvPython, '-c', `import ${moduleName}`],
            timeoutMs: 30_000,
            env,
            cwd: root,
          })
          probeResults.push(code === 0 ? `${spec} → import ${moduleName} ✓` : `${spec} → import ${moduleName} ✗（装上但导入失败，看依赖项）`)
        } catch {
          probeResults.push(`${spec} → import ${moduleName} ✗（探测超时/异常）`)
        }
      }

      return {
        output: [
          '依赖安装完成（声明制 · 项目内 .venv）：',
          ...steps,
          '--- import 探测回读 ---',
          ...probeResults,
          '后续一致性：run_project_script 将自动改用 .venv 解释器；LAUNCH.json 的 command 请改为 [".venv\\\\Scripts\\\\python.exe", "主程序.py"]（相对项目根）。',
          `（剩余安装预算 ${maxCalls - calls}/${maxCalls} 次）`,
        ].join('\n'),
        detail: { installed: specs, venv_python: venvPythonRelativePath(), call_index: calls },
      }
    },
  }
}
