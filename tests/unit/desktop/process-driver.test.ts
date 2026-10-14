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
    scenarios: [{ name: 'S1 主流程', covers: ['F-001'] }],
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

  it('场景号前置方言（狗粮 c21e10b1 实证，2026-10-03）：`S<n> PASS <描述>` 全量解析；INFO 等非结果词行忽略', () => {
    const stdout = [
      '== 驱动执行 ==',
      'S1 PASS 无窗口纯引擎路径：初始显示=0',
      'S2 PASS 连按 7、75 追加正确：command: key_7+key_5',
      'S7 FAIL 除零提示不正确',
      'S12 INFO screenshot saved: 00_VERIFY\\screenshots\\S12.png',
      'S12 PASS 真实窗口按钮链路 7+5=12',
      '结果: 11/12 通过',
      '退出码: 1',
    ].join('\n')
    const { scenarios, summaryLine } = parseDriverStdout(stdout)
    expect(scenarios).toEqual([
      { name: 'S1', outcome: 'pass' },
      { name: 'S2', outcome: 'pass' },
      { name: 'S7', outcome: 'fail' },
      { name: 'S12', outcome: 'pass' },
    ])
    expect(summaryLine).toBeNull()
  })

  it('前置方言误报防线：PASSed/裸英文叙述行不命中；含分隔符标识合法', () => {
    const { scenarios } = parseDriverStdout(['tests PASSed as expected', 'the PASS gate is fine', 'test_add PASS 数学正确', 'case-2 FAIL 边界错误'].join('\n'))
    expect(scenarios).toEqual([
      { name: 'test_add', outcome: 'pass' },
      { name: 'case-2', outcome: 'fail' },
    ])
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

  it('PYTHONIOENCODING=utf-8 注入（GBK 乱码根治，c21e10b1 实证）；父环境已设时不覆盖', () => {
    const env = buildDriverEnv(baseContract(), { SystemRoot: 'C:\\Windows' })
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    const overridden = buildDriverEnv(baseContract(), { SystemRoot: 'C:\\Windows', PYTHONIOENCODING: 'gbk' })
    expect(overridden.PYTHONIOENCODING).toBe('gbk')
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

  it('语义源对账（批9.5 搬竞品 evidence 对账）：驱动执行期间被测入口/驱动脚本被改 → 结果作废 blocked；未变 → 正常路由', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'bloma-semantics-'))
    writeFileSync(join(dir, 'driver-skeleton.py'), 'print(1)', 'utf8')
    writeFileSync(join(dir, 'app.py'), 'print(2)', 'utf8')
    // 不变：正常路由 pass
    const stable = await runContractDriver({
      contract: baseContract(),
      cwd: dir,
      spawn: async () => ({ code: 0, stdout: 'PASS S1\nSUMMARY pass=1', stderr: '' }),
    })
    expect(stable.routing).toBe('pass')
    // 驱动执行中被测入口被改（测试热修被测代码）→ 作废 blocked
    const tampered = await runContractDriver({
      contract: baseContract(),
      cwd: dir,
      spawn: async () => {
        writeFileSync(join(dir, 'app.py'), 'print("hot-fixed")', 'utf8') // 模拟驱动在执行期间热改被测代码
        return { code: 0, stdout: 'PASS S1\nSUMMARY pass=1', stderr: '' }
      },
    })
    expect(tampered.routing).toBe('blocked')
    expect(tampered.routingReason).toContain('验收语义源被修改')
    // 运行时输出不在对账面：新增无关文件不影响
    writeFileSync(join(dir, 'data.json'), '{}', 'utf8')
    const untouched = await runContractDriver({
      contract: baseContract(),
      cwd: dir,
      spawn: async () => ({ code: 0, stdout: 'PASS S1\nSUMMARY pass=1', stderr: '' }),
    })
    expect(untouched.routing).toBe('pass')
  })

  it('超时预算自适应兜底（批9 2026-10-07）：场景多时抬高下限，声明更大值仍受尊重', async () => {
    // 狗粮 4ad53aa7 实锤：16 场景完整跑 61s，60s 缺省被强杀→空报告→artifacts-missing 拒收
    // →闭环预算耗尽降级人工。兜底=max(声明值, 20s + 场景数×6s)，上限 240s。
    const seen: number[] = []
    const spawn = async (request: { timeoutMs: number }) => {
      seen.push(request.timeoutMs)
      return { code: 0, stdout: 'PASS S1\nSUMMARY pass=1', stderr: '' }
    }
    // 16 场景 + 声明 60000 → 兑底 116000（20s + 16×6s）
    const many = { ...baseContract(), scenarios: Array.from({ length: 16 }, (_, i) => ({ name: `S${i + 1}`, covers: ['F-001'] })) }
    await runContractDriver({ contract: many, cwd: '/proj', spawn })
    expect(seen[seen.length - 1]).toBe(116_000)
    // 声明 200000 > 兑底 116000 → 尊重声明值
    const declared = { ...many, driver: { ...many.driver, timeout_ms: 200_000 } }
    await runContractDriver({ contract: declared, cwd: '/proj', spawn })
    expect(seen[seen.length - 1]).toBe(200_000)
    // 场景极大时上限 240s 封顶
    const huge = { ...baseContract(), scenarios: Array.from({ length: 60 }, (_, i) => ({ name: `S${i + 1}`, covers: ['F-001'] })) }
    await runContractDriver({ contract: huge, cwd: '/proj', spawn })
    expect(seen[seen.length - 1]).toBe(240_000)
    // 批9.5 审核修正回归锁：显式声明 600s（schema 上限）不被 240s 封顶砍掉
    const declaredHuge = { ...huge, driver: { ...huge.driver, timeout_ms: 600_000 } }
    await runContractDriver({ contract: declaredHuge, cwd: '/proj', spawn })
    expect(seen[seen.length - 1]).toBe(600_000)
    // 场景少时维持声明值（1 场景 → 兑底 26s < 声明 60s → 60s 不变）
    await runContractDriver({ contract: baseContract(), cwd: '/proj', spawn })
    expect(seen[seen.length - 1]).toBe(60_000)
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
    expect(seenEnv?.PYTHONIOENCODING).toBe('utf-8') // GBK 乱码根治（c21e10b1）
    expect(seenEnv?.PYTHONUTF8).toBe('1') // 嵌套 subprocess 文本管道同样使用 UTF-8
    expect(Object.keys(seenEnv ?? {}).sort()).toEqual(['BLOMA_APP_LLM_KEY', 'PYTHONIOENCODING', 'PYTHONUTF8', 'SystemRoot'])
  })
})

describe('生产 spawn 实现导出面', () => {
  it('execFileDriverSpawn 已定义（接线批次 D 消费；此处仅锁导出面存在）', () => {
    expect(typeof execFileDriverSpawn).toBe('function')
  })
})

describe('parseDriverStdout 竖线方言兼容（狗粮 f277dbf1 实证，2026-10-02）', () => {
  it('SCENARIO|id|outcome|detail 行与 SUMMARY|total=.. 行可解析（生成物偏离官方 PASS 方言时锚点不丢失）', () => {
    const stdout = [
      'ENV|backend|fake',
      'SCENARIO|F-001|pass|悬浮球常驻桌面 size 96x96',
      'SCENARIO|F-002|pass|同窗口双视图切换',
      'SCENARIO|F-007|fail|飘字文本与输入不一致',
      'SCENARIO|F-008|blocked|PySide6 不可用',
      'SUMMARY|total=4|pass=2|fail=1|blocked=1|exit_code=1',
    ].join('\n')
    const { scenarios, summaryLine } = parseDriverStdout(stdout)
    expect(scenarios).toEqual([
      { name: 'F-001', outcome: 'pass' },
      { name: 'F-002', outcome: 'pass' },
      { name: 'F-007', outcome: 'fail' },
      { name: 'F-008', outcome: 'blocked' },
    ])
    expect(summaryLine).toBe('SUMMARY|total=4|pass=2|fail=1|blocked=1|exit_code=1')
  })

  it('竖线方言与官方空格方言混用互不干扰；routeDriverOutcome 对竖线方言按锚点优先裁决', () => {
    const { scenarios } = parseDriverStdout('PASS official-name\nSCENARIO|F-001|pass|desc')
    expect(scenarios).toEqual([
      { name: 'official-name', outcome: 'pass' },
      { name: 'F-001', outcome: 'pass' },
    ])
    const routed = routeDriverOutcome(0, [{ name: 'F-007', outcome: 'fail' }])
    expect(routed.routing).toBe('fail')
  })
})
