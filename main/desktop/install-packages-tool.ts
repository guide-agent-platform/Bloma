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
import { consumeProjectAttempt } from '../platform/execution/project-attempts'
import { buildChildExecEnv } from './child-exec-tool'
import { DEFAULT_DESKTOP_EXECUTION_LIMITS } from './execution-limits'

const PIP_TIMEOUT_MS = 300_000
const VENV_TIMEOUT_MS = 120_000
const MAX_INSTALL_CALLS = DEFAULT_DESKTOP_EXECUTION_LIMITS.install_calls
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
function importNameOf(packageSpec: string, imports: Record<string, string>): string {
  const base = packageSpec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? packageSpec.trim()
  const card = WINDOWS_COMPONENT_CARDS.find((item) => item.package.toLowerCase() === base.toLowerCase())
  return imports[base.toLowerCase().replace(/[-_.]+/g, '-')] ?? card?.importName ?? base.replace(/[-_]+/g, '_')
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
      '包名与导入名不同时可给 imports 映射（如 {"beautifulsoup4":"bs4"}）；平台已知映射自动识别。语音专用接入指引按需读 read_production_context。' +
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
        imports: { type: 'object', additionalProperties: { type: 'string' }, description: '可选：本次声明的发行包名到 Python 导入模块名的映射，模块名可含点号' },
      },
    },
    execute: async (input, ctx) => {
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
        if (input.packages.some(item => typeof item !== 'string' || !item.trim())) return { output: 'packages 必须是非空包声明的字符串数组；未忽略任何声明，也未安装。', isError: true }
        specs = input.packages.map((item: string) => item.trim())
      }
      if (specs.length === 0) {
        return { output: '未声明任何包：给 packages 列表或 requirements=true。', isError: true }
      }
      if (input.requirements === true && input.packages !== undefined) return { output: 'packages 与 requirements=true 只能选择一项；未安装。', isError: true }
      const imports: Record<string, string> = Object.create(null)
      const requestedNames = new Set(specs.map(spec => spec.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]?.toLowerCase().replace(/[-_.]+/g, '-')))
      if (input.imports !== undefined) {
        if (!input.imports || typeof input.imports !== 'object' || Array.isArray(input.imports)) return { output: 'imports 必须是包名到模块名的对象；未安装。', isError: true }
        for (const [name, module] of Object.entries(input.imports)) {
          const normalized = name.toLowerCase().replace(/[-_.]+/g, '-')
          if (!requestedNames.has(normalized) || typeof module !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module)) {
            return { output: `imports 只接受本次声明包名与合法 Python 模块名：${name}；未安装。`, isError: true }
          }
          if (normalized in imports) return { output: `imports 包名重复：${name}；未安装。`, isError: true }
          imports[normalized] = module
        }
      }
      // Bare speech dependencies use the locally validated baseline. Explicit user versions win.
      const speechBaseline: Record<string, string> = { 'sherpa-onnx': '1.13.8', numpy: '2.5.4', sounddevice: '0.5.6' }
      const hasSpeech = specs.some(spec => /^sherpa[-_]onnx\b/i.test(spec))
      if (hasSpeech) {
        specs = specs.map(spec => {
          const name = spec.toLowerCase().replace(/_/g, '-')
          return speechBaseline[name] ? `${name}==${speechBaseline[name]}` : spec
        })
        if (!specs.some(spec => /^numpy\b/i.test(spec))) specs.push('numpy==2.5.4')
      }
      if (specs.length > MAX_PACKAGES_PER_CALL) {
        return { output: `单次至多 ${MAX_PACKAGES_PER_CALL} 个包（当前 ${specs.length}），分批安装。`, isError: true }
      }
      const bad = specs.filter((spec) => !PACKAGE_SPEC_RE.test(spec))
      if (bad.length > 0) {
        return { output: `包声明格式不合法（只允许 名称 或 名称+版本约束）：${bad.join('、')}`, isError: true }
      }

      const env = buildChildExecEnv(process.env)
      try {
        const attempt = consumeProjectAttempt(projectId, `install:${ctx.sessionId}`, maxCalls)
        if (!attempt.allowed) return { output: `安装调用预算用尽（${maxCalls} 次），续接不会清零，请保存未完成项。`, isError: true, budgetExhausted: true,
          feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', source: 'host', scope: 'dependency_imports', category: 'budget', recovery: 'stop',
            budget: { resource: 'install_calls', scope: 'session', used: attempt.used, limit: maxCalls, remaining: 0, resets_on: 'new_run' } } }
        calls = attempt.used
      } catch { return { output: '安装计数不可保存，未执行安装。请恢复执行记录后重试。', isError: true } }
      const venvPython = join(root, venvPythonRelativePath())
      const steps: string[] = []

      // ① venv（幂等：已存在跳过）
      if (!existsSync(venvPython)) {
        try {
          await spawn({ command: ['python', '-m', 'venv', '.venv'], timeoutMs: VENV_TIMEOUT_MS, env, cwd: root, signal: ctx.signal })
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
          signal: ctx.signal,
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
        if (hasSpeech) {
          const { readFileSync, writeFileSync } = await import('node:fs')
          const reqPath = join(root, 'requirements.txt')
          const original = existsSync(reqPath) ? readFileSync(reqPath, 'utf8') : ''
          const lines = original.split(/\r?\n/).map(line => {
            const name = line.trim().toLowerCase().replace(/_/g, '-')
            return speechBaseline[name] ? `${name}==${speechBaseline[name]}` : line
          })
          for (const spec of specs) {
            const name = spec.split(/[<>=!~]/)[0]!.toLowerCase().replace(/_/g, '-')
            if (!lines.some(line => line.trim().split(/[<>=!~]/)[0]?.toLowerCase().replace(/_/g, '-') === name)) lines.push(spec)
          }
          writeFileSync(reqPath, lines.filter(Boolean).join('\n') + '\n', 'utf8')
          steps.push('语音依赖声明已保存；裸包名采用实测版本，显式版本约束保留。')
        }
      } catch (error) {
        if (error instanceof DriverExecutionError) {
          return { output: `安装失败（${error.kind}）：${error.message}。timeout 类不要反复重试。`, isError: true }
        }
        return { output: `安装异常：${error instanceof Error ? error.message : String(error)}`, isError: true }
      }

      // ③ 逐包 import 探测回读（卡片库 import_name 映射）
      const probeResults: string[] = []
      const probeFailures: string[] = []
      for (const spec of specs) {
        const moduleName = importNameOf(spec, imports)
        try {
          const { code, stderr } = await spawn({
            command: [venvPython, '-c', `import ${moduleName}`],
            timeoutMs: 30_000,
            env,
            cwd: root,
            signal: ctx.signal,
          })
          probeResults.push(code === 0 ? `${spec} → import ${moduleName} ✓` : `${spec} → import ${moduleName} ✗（装上但导入失败，看依赖项）`)
          if (code !== 0) probeFailures.push(`${spec}: ${stderr.slice(-1000) || `import 退出码 ${code}`}`)
        } catch (error) {
          probeResults.push(`${spec} → import ${moduleName} ✗（探测超时/异常）`)
          probeFailures.push(`${spec}: ${error instanceof Error ? error.message.slice(0, 1000) : '探测异常'}`)
        }
      }

      // ④ 语音识别平台资产：装 sherpa-onnx 时自动落 speech_locator.py 进项目根
      //（模型定位器：~/.proma/speech-models/ 与平台语音输入共用，miss 自动从 hf-mirror 下载；
      //  2026-10-05 语音批 C 线——平台供资产惯例，子会话零寻路成本，产物自带源码可独立分发）
      if (specs.some((spec) => spec.trim().toLowerCase().startsWith('sherpa-onnx'))) {
        const locatorTarget = join(root, 'speech_locator.py')
        if (!existsSync(locatorTarget)) {
          const { cpSync } = await import('node:fs')
          const { mainRootDir } = await import('../platform/paths')
          const source = join(mainRootDir(), 'templates', 'tools', 'speech_locator.py')
          if (existsSync(source)) {
            cpSync(source, locatorTarget)
            steps.push('已生成 speech_locator.py（语音模型定位器：import 它调 ensure_models() 拿模型路径，勿手写下载逻辑）')
          }
        }
        const runtimeTarget = join(root, 'speech_runtime.py')
        if (!existsSync(runtimeTarget)) {
          const { cpSync } = await import('node:fs')
          const { mainRootDir } = await import('../platform/paths')
          const source = join(mainRootDir(), 'templates', 'tools', 'speech_runtime.py')
          if (existsSync(source)) {
            cpSync(source, runtimeTarget)
            steps.push('已生成 speech_runtime.py：SpeechEngine.prepare/transcribe(samples,sample_rate)，StreamingRecorder.start(on_text,on_error)/stop；on_text 是累计转写文本，回调转到 UI 线程。模型准备失败可重试，录音回调仅入队。')
          }
        }
      }

      return {
        isError: probeFailures.length > 0,
        output: [
          probeFailures.length ? '包已安装，但依赖导入检查未通过；按下列原因修复后补验，不能宣称环境就绪：' : '依赖安装与导入检查完成（声明制 · 项目内 .venv）：',
          ...steps,
          '--- import 探测回读 ---',
          ...probeResults,
          ...probeFailures,
          '后续一致性：run_project_script 将自动改用 .venv 解释器；LAUNCH.json 的 command 请改为 [".venv\\\\Scripts\\\\python.exe", "主程序.py"]（相对项目根）。',
          `（剩余安装预算 ${maxCalls - calls}/${maxCalls} 次）`,
        ].join('\n'),
        detail: { installed: specs, imports_verified: probeFailures.length === 0, venv_python: venvPythonRelativePath(), call_index: calls },
      }
    },
  }
}
