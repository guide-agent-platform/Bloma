/**
 * install_packages 受控安装刀测试（2026-10-05 迁移批）。
 *
 * 覆盖：venv 创建幂等序、声明白名单校验、requirements 通道、pip 红/绿、
 * import 回读映射（Pillow→PIL）、安装预算、角色装配面、venv 解释器一致性
 * （run_project_script 在 .venv 存在时优先 venv python）。
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import type { DriverCommandRequest } from '../../../main/desktop/process-driver'
import { buildInstallPackagesTool, venvPythonRelativePath } from '../../../main/desktop/install-packages-tool'
import { buildChildScriptRunnerTool } from '../../../main/desktop/child-exec-tool'
import { buildDesktopChildTools } from '../../../main/desktop/dispatcher-loop'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createProject, updateProject } from '../../../main/project/project-service'

function ctxFor(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: 'session-install-pkgs',
    requestId: 'req-install-pkgs',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

describe('install_packages（声明制 venv 安装刀）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let projectId: string
  let projectRoot: string

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-install-'))
    const project = createProject({ request_id: 'req-install-setup', mode: 'quick' })
    projectId = project.project_id
    projectRoot = project.root_path
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  /** spawn 桩：venv 创建成功落真文件；pip/import 按脚本返回。 */
  function makeSpawn(script: Array<{ match: (cmd: readonly string[]) => boolean; code: number; stdout?: string; stderr?: string }>) {
    return vi.fn(async (request: DriverCommandRequest): Promise<{ code: number; stdout: string; stderr: string }> => {
      // venv 创建：真实落 .venv\Scripts\python.exe 占位，后续 existsSync 判定才成立
      if (request.command.includes('-m') && request.command.includes('venv')) {
        mkdirSync(join(request.cwd ?? '', '.venv', 'Scripts'), { recursive: true })
        writeFileSync(join(request.cwd ?? '', venvPythonRelativePath()), '#stub', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      const hit = script.find((item) => item.match(request.command))
      if (!hit) return { code: 0, stdout: '', stderr: '' }
      return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
    })
  }

  it('happy path：venv 创建 + pip 绿 + import 回读映射（Pillow→PIL）', async () => {
    const spawn = makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 0 }])
    const tool = buildInstallPackagesTool(projectId, { spawn })
    const outcome = await tool.execute({ packages: ['pystray', 'Pillow>=10'] }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('.venv')
    expect(outcome.output).toContain('pystray → import pystray ✓')
    expect(outcome.output).toContain('Pillow>=10 → import PIL ✓')
    // 调用序：venv → pip → 两轮 import 探测
    const commands = spawn.mock.calls.map((call) => (call[0] as DriverCommandRequest).command.join(' '))
    expect(commands.some((cmd) => cmd.includes('-m venv .venv'))).toBe(true)
    expect(commands.some((cmd) => cmd.includes('-m pip install --quiet pystray Pillow>=10'))).toBe(true)
    expect(commands.filter((cmd) => cmd.includes('import'))).toHaveLength(2)
  })

  it.skipIf(process.platform !== 'win32')('rejects installed pywebview when its lazy Windows CLR dependency fails', async () => {
    const spawn = makeSpawn([{ match: command => command.some(part => part.includes('import clr')), code: 1, stderr: 'ImportError: DLL load failed: 文件名或扩展名太长' }])
    const result = await buildInstallPackagesTool(projectId, { spawn }).execute({ packages: ['pywebview'] }, ctxFor(projectId))
    expect(result.isError).toBe(true)
    expect(result.detail).toMatchObject({ imports_verified: false })
    expect(result.output).toContain('Windows CLR')
    expect(result.output).toContain('文件名或扩展名太长')
    expect(result.output).toContain('不能宣称环境就绪')
    expect(spawn.mock.calls.some(([request]) => request.command.some(part => part.includes('System.Windows.Forms')))).toBe(true)
  })

  it('venv 幂等：已存在时不再创建', async () => {
    mkdirSync(join(projectRoot, '.venv', 'Scripts'), { recursive: true })
    writeFileSync(join(projectRoot, venvPythonRelativePath()), '#stub', 'utf8')
    const spawn = makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 0 }])
    const tool = buildInstallPackagesTool(projectId, { spawn })
    await tool.execute({ packages: ['pyperclip'] }, ctxFor(projectId))
    expect(spawn.mock.calls.some((call) => (call[0] as DriverCommandRequest).command.includes('venv'))).toBe(false)
  })

  it('声明白名单：非法格式拒答；requirements 通道读取声明', async () => {
    const tool = buildInstallPackagesTool(projectId, { spawn: makeSpawn([]) })
    const ctx = ctxFor(projectId)
    expect((await tool.execute({ packages: ['pystray; rm -rf /'] }, ctx)).isError).toBe(true)
    expect((await tool.execute({ packages: [] }, ctx)).isError).toBe(true)
    expect((await tool.execute({ requirements: true }, ctx)).isError).toBe(true) // 无 requirements.txt
    writeFileSync(join(projectRoot, 'requirements.txt'), '# 注释\nsounddevice\npyperclip\n', 'utf8')
    const spawn = makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 0 }])
    const tool2 = buildInstallPackagesTool(projectId, { spawn })
    const outcome = await tool2.execute({ requirements: true }, ctx)
    expect(outcome.isError).toBeFalsy()
    expect(spawn.mock.calls.some((call) => (call[0] as DriverCommandRequest).command.join(' ').includes('sounddevice pyperclip'))).toBe(true)
  })

  it('pip 红：非零退出码带 stderr 回传', async () => {
    const spawn = makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 1, stderr: 'ResolutionImpossible' }])
    const tool = buildInstallPackagesTool(projectId, { spawn })
    const outcome = await tool.execute({ packages: ['no-such-pkg'] }, ctxFor(projectId))
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('ResolutionImpossible')
  })

  it('安装预算：超上限拒答', async () => {
    const tool = buildInstallPackagesTool(projectId, { spawn: makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 0 }]), maxCalls: 1 })
    const ctx = ctxFor(projectId)
    expect((await tool.execute({ packages: ['pyperclip'] }, ctx)).isError).toBeFalsy()
    const second = await tool.execute({ packages: ['pyperclip'] }, ctx)
    expect(second.isError).toBe(true)
    expect(second.output).toContain('预算用尽')
  })
  it('pip and import probes receive resource paths without model-channel credentials', async () => {
    const previous = process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-channel-secret'
    try {
      const spawn = makeSpawn([])
      await buildInstallPackagesTool(projectId, { spawn }).execute({ packages: ['numpy'] }, ctxFor(projectId))
      expect(spawn.mock.calls.every(([request]) => request.env.ANTHROPIC_AUTH_TOKEN === undefined)).toBe(true)
    } finally { if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = previous }
  })

  it('pip success with failed import returns isError and the real failure; later correction can recover', async () => {
    const runner = makeSpawn([{ match: cmd => cmd.includes('import sounddevice'), code: 1, stderr: "ModuleNotFoundError: No module named 'numpy'" }])
    const installer = buildInstallPackagesTool(projectId, { spawn: runner })
    const failed = await installer.execute({ packages: ['sounddevice'] }, ctxFor(projectId))
    expect(failed.isError).toBe(true)
    expect(failed.detail).toMatchObject({ imports_verified: false })
    expect(failed.output).toContain("No module named 'numpy'")
    expect(failed.output).not.toContain('依赖安装完成')
    runner.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const recovered = await installer.execute({ packages: ['numpy', 'sounddevice'] }, ctxFor(projectId))
    expect(recovered.isError).toBe(false)
    expect(recovered.detail).toMatchObject({ imports_verified: true })
  })

  it('venv 解释器一致性：run_project_script 在 .venv 存在时优先 venv python', async () => {
    mkdirSync(join(projectRoot, '.venv', 'Scripts'), { recursive: true })
    writeFileSync(join(projectRoot, venvPythonRelativePath()), '#stub', 'utf8')
    writeFileSync(join(projectRoot, '自测.py'), 'print("S1 PASS")', 'utf8')
    const spawn = vi.fn(async (_request: DriverCommandRequest): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 0, stdout: 'S1 PASS\n', stderr: '' }))
    const tool = buildChildScriptRunnerTool(projectId, { spawn, resolvePython: async () => 'C:/SystemPython/python.exe' })
    await tool.execute({ script: '自测.py' }, ctxFor(projectId))
    const command = (spawn.mock.calls[0][0] as DriverCommandRequest).command
    expect(command[0].endsWith(join('.venv', 'Scripts', 'python.exe'))).toBe(true)
  })

  it('角色装配面：implement 同时有 run_project_script 与 install_packages，research 都没有', () => {
    const impl = buildDesktopChildTools(projectId, 'implement', 'diff').map((tool) => tool.name)
    expect(impl).toContain('run_project_script')
    expect(impl).toContain('install_packages')
    const research = buildDesktopChildTools(projectId, 'research', 'diff').map((tool) => tool.name)
    expect(research).not.toContain('run_project_script')
    expect(research).not.toContain('install_packages')
  })

  it('语音资产：装 sherpa-onnx 时项目根自动落 speech_locator.py（幂等，其他包不落）', async () => {
    const spawn = makeSpawn([{ match: (cmd) => cmd.includes('pip'), code: 0 }])
    const tool = buildInstallPackagesTool(projectId, { spawn })
    const outcome = await tool.execute({ packages: ['sherpa-onnx'] }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    const locator = join(projectRoot, 'speech_locator.py')
    expect(existsSync(locator)).toBe(true)
    expect(readFileSync(locator, 'utf8')).toContain('def ensure_models(')
    expect(outcome.output).toContain('speech_locator.py')
    expect(existsSync(join(projectRoot, 'speech_runtime.py'))).toBe(true)
    expect(outcome.output).toContain('speech_runtime.py')
    expect(readFileSync(join(projectRoot, 'requirements.txt'), 'utf8')).toContain('sherpa-onnx==1.13.8')
    expect(readFileSync(join(projectRoot, 'requirements.txt'), 'utf8')).toContain('numpy==2.5.4')
    // 幂等：第二次安装不再重复提示
    const again = await tool.execute({ packages: ['sherpa-onnx'] }, ctxFor(projectId))
    expect(again.output).not.toContain('已生成 speech_locator.py')
    // 其他包不触发落盘
    const otherRoot = createProject({ request_id: 'req-install-other', mode: 'quick' }).root_path
    expect(existsSync(join(otherRoot, 'speech_locator.py'))).toBe(false)
  })
  it('installing a generic GUI package does not inject a filename-renaming business helper', async () => {
    const tool = buildInstallPackagesTool(projectId, { spawn: makeSpawn([{ match: cmd => cmd.includes('pip'), code: 0 }]) })
    const first = await tool.execute({ packages: ['pywebview'] }, ctxFor(projectId))
    const path = join(projectRoot, 'file_plan_guard.py')
    expect(first.isError).toBeFalsy()
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, '# existing product helper')
    await tool.execute({ packages: ['pywebview'] }, ctxFor(projectId))
    expect(readFileSync(path, 'utf8')).toBe('# existing product helper')
  })
  it('accepts explicit distribution/import mappings outside the platform component catalog', async () => {
    const spawn = makeSpawn([])
    const tool = buildInstallPackagesTool(projectId, { spawn, maxCalls: 1 })
    for (const input of [{ packages: ['requests', 3] }, { packages: ['requests'], requirements: true },
      { packages: ['beautifulsoup4'], imports: { beautifulsoup4: 'bs4;exit()' } },
      { packages: ['beautifulsoup4'], imports: { unknown: 'bs4' } }]) {
      expect((await tool.execute(input, ctxFor(projectId))).isError).toBe(true)
    }
    expect(spawn).not.toHaveBeenCalled()
    const outcome = await tool.execute({ packages: ['beautifulsoup4'], imports: { beautifulsoup4: 'bs4' } }, ctxFor(projectId))
    expect(outcome.isError).toBe(false)
    expect(spawn.mock.calls.some(([request]) => request.command.includes('import bs4'))).toBe(true)
  })
})
