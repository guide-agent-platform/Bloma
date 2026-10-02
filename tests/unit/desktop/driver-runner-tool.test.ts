/**
 * run_project_driver 工具测试（ada13257 根治批，2026-10-02）。
 *
 * 覆盖：合法契约三分类读回渲染、契约缺失/不合法的 fail-closed 教育、
 * 项目根不可解析的 blocked 指引、阶段白名单（implement 放行 / 其余阶段拦截）。
 * spawn 与 resolveRoot 全注入——零真实子进程；contract.json 走真实临时目录。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProjectDriverRunnerTool } from '../../../main/desktop/driver-runner-tool'
import { checkDispatcherToolGate } from '../../../main/desktop/dispatcher-gate'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'

const CONTRACT = {
  schema_version: 1,
  entry: 'app.py',
  driver: {
    command: ['python', 'driver.py'],
    timeout_ms: 60000,
    exit_code_semantics: { '0': 'pass', '1': 'fail-route-repair', '2': 'blocked-no-repair' },
    assert_readback: 'stdout 行级锚点（PASS/FAIL/BLOCKED/SUMMARY）',
  },
  self_check: { command: ['python', 'app.py', '--self-check'], expect_exit: 0, expect_stdout_contains: 'SELF-CHECK-OK' },
  env_whitelist: [],
  components: [],
}

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeRoot(withContract: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'driver-runner-'))
  dirs.push(root)
  if (withContract) {
    await writeFile(join(root, '00_SCAFFOLD', 'contract.json'), JSON.stringify(CONTRACT), 'utf-8').catch(async () => {
      // 00_SCAFFOLD 可能不存在（mkdtemp 不建子目录）
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, '00_SCAFFOLD'), { recursive: true })
      await writeFile(join(root, '00_SCAFFOLD', 'contract.json'), JSON.stringify(CONTRACT), 'utf-8')
    })
  }
  return root
}

function toolFor(root: string | undefined, spawn: Parameters<typeof buildProjectDriverRunnerTool>[1] extends never ? never : any) {
  return buildProjectDriverRunnerTool('proj-test', {
    resolveRoot: () => root,
    spawn,
  })
}

describe('run_project_driver 工具', () => {
  it('合法契约 + 全绿驱动 → pass 渲染（场景读回 + 命令留档）', async () => {
    const root = await makeRoot(true)
    const tool = toolFor(root, async () => ({ code: 0, stdout: 'PASS 加法\nPASS 除零\nSUMMARY pass=2 fail=0', stderr: '' }))
    const out = await tool.execute!({} as never, {} as never)
    expect(out.isError).toBeUndefined()
    expect(out.output).toContain('PASS')
    expect(out.output).toContain('2/2 PASS')
    expect(out.output).toContain('python driver.py')
  })

  it('合法契约 + 断言失败 → fail 渲染（红绿清单可喂回修复线）', async () => {
    const root = await makeRoot(true)
    const tool = toolFor(root, async () => ({ code: 1, stdout: 'PASS 加法\nFAIL 除零\nSUMMARY pass=1 fail=1', stderr: 'ZeroDivisionError' }))
    const out = await tool.execute!({} as never, {} as never)
    expect(out.isError).toBeUndefined()
    expect(out.output).toContain('FAIL')
    expect(out.output).toContain('[FAIL] 除零')
    expect(out.output).toContain('stderr 摘录')
  })

  it('契约缺失 → contract-invalid fail-closed 教育（isError）', async () => {
    const root = await makeRoot(false)
    const tool = toolFor(root, async () => ({ code: 0, stdout: '', stderr: '' }))
    const out = await tool.execute!({} as never, {} as never)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('contract-invalid')
    expect(out.output).toContain('契约声明制')
  })

  it('契约 JSON 不合法 → contract-invalid 教育（schema_version 字符串方言三错防线）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'driver-runner-'))
    dirs.push(root)
    await (await import('node:fs/promises')).mkdir(join(root, '00_SCAFFOLD'), { recursive: true })
    await writeFile(join(root, '00_SCAFFOLD', 'contract.json'), JSON.stringify({ ...CONTRACT, schema_version: '1.0' }), 'utf-8')
    const tool = toolFor(root, async () => ({ code: 0, stdout: '', stderr: '' }))
    const out = await tool.execute!({} as never, {} as never)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('contract-invalid')
    expect(out.output).toContain('schema_version 数字 1')
  })

  it('项目根不可解析 → blocked 指引（不崩 loop）', async () => {
    const tool = toolFor(undefined, async () => ({ code: 0, stdout: '', stderr: '' }))
    const out = await tool.execute!({} as never, {} as never)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('项目根不可解析')
    expect(out.output).toContain('blocked')
  })
})

describe('run_project_driver 阶段白名单', () => {
  it('desktop-implement 放行（extraTools 声明）', () => {
    expect(checkDispatcherToolGate(DESKTOP_PHASES['desktop-implement'], 'run_project_driver')).toBeNull()
  })

  it('其余阶段拦截 + 教育文案列出可用面', () => {
    for (const id of ['desktop-arch', 'desktop-scaffold', 'desktop-verify'] as const) {
      const result = checkDispatcherToolGate(DESKTOP_PHASES[id], 'run_project_driver')
      expect(result?.deny, id).toBe(true)
      expect(result?.message, id).toContain('本阶段可用')
    }
  })

  it('implement 任务书不再承诺本阶段无法兑现的「逐条变绿」', () => {
    const template = DESKTOP_PHASES['desktop-implement'].taskTemplate
    expect(template).toContain('run_project_driver')
    expect(template).toContain('静态自洽')
    expect(template).not.toContain('驱动断言逐条变绿')
  })
})
