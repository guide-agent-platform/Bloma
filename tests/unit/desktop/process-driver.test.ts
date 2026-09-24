/**
 * 桌面驱动执行器测试（批次 C，2026-09-24）——spawn 注入式零真实子进程。
 *
 * 覆盖：三分类路由判定矩阵（锚点优先于退出码的保守序）、stdout 行级锚点解析、
 * env 白名单构建（生存集+交集）、runContractDriver 全路径（driver/self_check/
 * 未声明面/黑名单二道防线/spawn 异常翻译）、报告字段完备性。
 */
import { describe, expect, it } from 'vitest'
import {
  DriverExecutionError,
  buildDriverEnv,
  execFileDriverSpawn,
  parseDriverStdout,
  routeDriverOutcome,
  runContractDriver,
  type DriverScenarioOutcome,
} from '../../../main/desktop/process-driver'
import type { ProjectContract } from '../../../main/desktop/contract-schema'

function baseContract(): ProjectContract {
  return {
    schema_version: 1,
    entry: 'app.py',
    driver: {
      command: ['python', 'driver-skeleton.py'],
      timeout_ms: 60000,
      exit_code_semantics: { '0': 'pass', '1': 'fail-route-repair', '2': 'blocked-no-repair' },
      assert_readback: 'stdout 行级锚点（PASS/FAIL/BLOCKED/SUMMARY）',
    },
    self_check: { command: ['python', 'app.py', '--self-check'], expect_exit: 0, expect_stdout_contains: 'SELF-CHECK-OK' },
    env_whitelist: ['BLOMA_APP_LLM_KEY'],
    components: [],
  }
}

function scenarios(...items: Array<[string, DriverScenarioOutcome['outcome']]>): DriverScenarioOutcome[] {
  return items.map(([name, outcome]) => ({ name, outcome }))
}

describe('routeDriverOutcome 三分类路由矩阵', () => {
  it('退出码 0 + 全绿锚点 → pass', () => {
    expect(routeDriverOutcome(0, scenarios(['a', 'pass'], ['b', 'pass']))).toMatchObject({ routing: 'pass' })
  })

  it('退出码 0 无锚点 → pass（契约退出码语义兜底）', () => {
    expect(routeDriverOutcome(0, []).routing).toBe('pass')
  })

  it('锚点优先（保守序）：退出码 0 但有 FAIL 锚点 → fail（必须进修复轮）', () => {
    expect(routeDriverOutcome(0, scenarios(['a', 'pass'], ['b', 'fail']))).toMatchObject({ routing: 'fail' })
  })

  it('退出码 2 但有 FAIL 锚点 → fail（FAIL 优先于 blocked 分类）', () => {
    expect(routeDriverOutcome(2, scenarios(['a', 'fail']))).toMatchObject({ routing: 'fail' })
  })

  it('退出码 0 但有 BLOCKED 锚点 → blocked（最高优先——环境类不进修复轮）', () => {
    expect(routeDriverOutcome(0, scenarios(['a', 'blocked'], ['b', 'fail']))).toMatchObject({ routing: 'blocked' })
  })

  it('退出码 1 无锚点 → fail；退出码 2 无锚点 → blocked', () => {
    expect(routeDriverOutcome(1, []).routing).toBe('fail')
    expect(routeDriverOutcome(2, []).routing).toBe('blocked')
  })

  it('SKIP 不影响路由', () => {
    expect(routeDriverOutcome(0, scenarios(['a', 'skipped'])).routing).toBe('pass')
  })
})

describe('parseDriverStdout 行级锚点解析', () => {
  it('PASS/FAIL/BLOCKED/SKIP 场景行 + SUMMARY 行（骨架输出契约形态）', () => {
    const stdout = [
      'SELF-CHECK-OK',
      'PASS skeleton.self-check',
      'SKIP tray.launch-visible (assert not implemented: assert_tray_launch_visible)',
      'FAIL tray.hotkey-work: 键盘事件未捕获',
      'BLOCKED audio.record: self-check 报告组件缺失（环境阻塞）',
      'SUMMARY pass=1 fail=1 blocked=1',
    ].join('\n')
    const { scenarios: parsed, summaryLine } = parseDriverStdout(stdout)
    expect(parsed).toEqual([
      { name: 'skeleton.self-check', outcome: 'pass' },
      { name: 'tray.launch-visible', outcome: 'skipped' },
      { name: 'tray.hotkey-work', outcome: 'fail' },
      { name: 'audio.record', outcome: 'blocked' },
    ])
    expect(summaryLine).toBe('SUMMARY pass=1 fail=1 blocked=1')
  })

  it('CRLF 行尾兼容；多次 SUMMARY 取终值；无锚点输出返回空', () => {
    const { scenarios, summaryLine } = parseDriverStdout('PASS a\r\nSUMMARY pass=1\r\nSUMMARY pass=2\r\n')
    expect(scenarios).toEqual([{ name: 'a', outcome: 'pass' }])
    expect(summaryLine).toBe('SUMMARY pass=2')
    expect(parseDriverStdout('普通输出无锚点\n中文行')).toEqual({ scenarios: [], summaryLine: null })
  })

  it('行内嵌 FAIL 字样不误判（锚定行首）', () => {
    const { scenarios } = parseDriverStdout('说明：FAIL 场景应修复\nPASS real-scenario')
    expect(scenarios).toEqual([{ name: 'real-scenario', outcome: 'pass' }])
  })
})

describe('buildDriverEnv 白名单', () => {
  it('生存集 + 白名单交集；其余不透传', () => {
    const parent = {
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      windir: 'C:\\Windows',
      BLOMA_APP_LLM_KEY: 'secret',
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\x',
      APPDATA: 'C:\\Users\\x\\AppData',
    }
    const env = buildDriverEnv(baseContract(), parent)
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.BLOMA_APP_LLM_KEY).toBe('secret')
    expect(env.PATH).toBeUndefined()
    expect(env.USERPROFILE).toBeUndefined()
    expect(env.APPDATA).toBeUndefined()
  })

  it('白名单变量父环境缺失时不造键', () => {
    const env = buildDriverEnv(baseContract(), { SystemRoot: 'C:\\Windows' })
    expect('BLOMA_APP_LLM_KEY' in env).toBe(false)
  })
})

describe('runContractDriver 执行路径', () => {
  it('driver 面：全绿 → pass 报告（场景读回+命令留档）', async () => {
    const spawn = async () => ({
      code: 0,
      stdout: 'PASS a\nPASS b\nSUMMARY pass=2 fail=0 blocked=0',
      stderr: '',
    })
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('pass')
    expect(report.exitCode).toBe(0)
    expect(report.scenarios).toHaveLength(2)
    expect(report.summaryLine).toContain('pass=2')
    expect(report.command).toBe('python driver-skeleton.py')
    expect(report.routingReason).toContain('2/2 场景全绿')
    expect(report.startedAt).toBeTruthy()
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('driver 面：FAIL 锚点 → fail（路由进修复轮）', async () => {
    const spawn = async () => ({ code: 1, stdout: 'PASS a\nFAIL b: 断言失败\nSUMMARY pass=1 fail=1', stderr: '' })
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('fail')
    expect(report.routingReason).toContain('修复轮')
    expect(report.routingReason).toContain('b')
  })

  it('driver 面：BLOCKED 锚点 → blocked（不进修复轮）', async () => {
    const spawn = async () => ({ code: 2, stdout: 'BLOCKED a: 组件缺失\nSUMMARY blocked=1', stderr: '' })
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('不进修复轮')
  })

  it('spawn 超时 → blocked（timeout 环境类）', async () => {
    const spawn = async () => {
      throw new DriverExecutionError('timeout', '驱动超时（>60000ms）强杀')
    }
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('timeout')
    expect(report.exitCode).toBeNull()
  })

  it('spawn ENOENT → blocked（not-found——venv 未装配归因）', async () => {
    const spawn = async () => {
      throw new DriverExecutionError('not-found', '命令不存在：python（venv 未装配或解释器路径错）')
    }
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('venv 未装配')
  })

  it('未知 spawn 异常 → blocked 兜底', async () => {
    const spawn = async () => {
      throw new Error('EACCES')
    }
    const report = await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('spawn-failed')
  })

  it('self_check 面：退出码+锚点双验证', async () => {
    const ok = await runContractDriver({
      contract: baseContract(), cwd: '/proj', which: 'self_check',
      spawn: async () => ({ code: 0, stdout: 'SELF-CHECK-OK', stderr: '' }),
    })
    expect(ok.routing).toBe('pass')
    expect(ok.routingReason).toContain('锚点')

    const noAnchor = await runContractDriver({
      contract: baseContract(), cwd: '/proj', which: 'self_check',
      spawn: async () => ({ code: 0, stdout: '别的输出', stderr: '' }),
    })
    expect(noAnchor.routing).toBe('fail')
    expect(noAnchor.routingReason).toContain('锚点')
  })

  it('契约未声明 self_check 时执行该面 → blocked（声明制）', async () => {
    const contract = baseContract()
    delete contract.self_check
    const report = await runContractDriver({ contract, cwd: '/p', which: 'self_check', spawn: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('未声明')
  })

  it('内存契约命令被改为黑名单 → 执行前拦截（二道防线）', async () => {
    const contract = baseContract()
    contract.driver.command = ['powershell', '-File', 'evil.ps1']
    const report = await runContractDriver({
      contract, cwd: '/p', spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    expect(report.routing).toBe('blocked')
    expect(report.routingReason).toContain('安全拦截')
  })

  it('parentEnv 注入生效（不读测试进程真实环境）', async () => {
    let seenEnv: Record<string, string> | undefined
    const report = await runContractDriver({
      contract: baseContract(), cwd: '/p', parentEnv: { SystemRoot: 'C:\\Win', BLOMA_APP_LLM_KEY: 'k' },
      spawn: async (req) => {
        seenEnv = req.env
        return { code: 0, stdout: 'PASS a', stderr: '' }
      },
    })
    expect(report.routing).toBe('pass')
    expect(seenEnv?.SystemRoot).toBe('C:\\Win')
    expect(seenEnv?.BLOMA_APP_LLM_KEY).toBe('k')
    expect(Object.keys(seenEnv ?? {}).length).toBe(2)
  })
})

describe('生产 spawn 实现导出面', () => {
  it('execFileDriverSpawn 已定义（接线批次 D 消费；此处仅锁导出面存在）', () => {
    expect(typeof execFileDriverSpawn).toBe('function')
  })
})
