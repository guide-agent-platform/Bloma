/**
 * 工程契约 schema 校验器测试（批次 C，2026-09-24）。
 *
 * 覆盖：合法契约全过（骨架样例一致性锁定）、各类结构/语义违规、命令黑名单
 * （注册表/系统目录/破坏性命令）、env 白名单变量名形态、parseProjectContract
 * 抛错路径（fail-closed）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseProjectContract,
  validateProjectContract,
  violatesCommandBlacklist,
  type ProjectContract,
} from '../../../main/desktop/contract-schema'

/** 批次 B 骨架的契约样例路径（资产一致性锁定的真源）。 */
const SKELETON_CONTRACT = fileURLToPath(new URL('../../../main/templates/skeletons/desktop-python/contract.json', import.meta.url))

/** 合法契约基底（测试变体复制微改）。 */
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
    env_whitelist: [],
    components: [],
    packaging: {
      tool: 'pyinstaller',
      args: ['--onefile', '--windowed'],
      smoke: { command: ['dist/app.exe', '--self-check'], expect_exit: 0 },
    },
  }
}

describe('合法契约', () => {
  it('基底契约通过校验', () => {
    const result = validateProjectContract(baseContract())
    expect(result, result.errors.join('; ')).toEqual({ valid: true, errors: [] })
  })

  it('批次 B 骨架 contract.json 样例通过校验（资产一致性锁定——schema 与骨架同批交付）', () => {
    const text = readFileSync(SKELETON_CONTRACT, 'utf8')
    const contract = parseProjectContract(text)
    expect(contract.entry).toBe('app.py')
    expect(contract.driver.exit_code_semantics['2']).toContain('blocked')
  })
})

describe('结构与语义违规', () => {
  it('非对象输入', () => {
    expect(validateProjectContract(null).valid).toBe(false)
    expect(validateProjectContract('string').valid).toBe(false)
  })

  it('schema_version 不匹配当前版本', () => {
    const c = baseContract()
    ;(c as unknown as Record<string, unknown>).schema_version = 2
    expect(validateProjectContract(c).errors.some((e) => e.includes('schema_version'))).toBe(true)
  })

  it('entry 空/缺失', () => {
    const c = baseContract()
    c.entry = ''
    expect(validateProjectContract(c).errors.some((e) => e.includes('entry'))).toBe(true)
  })

  it('driver.command 空数组或非字符串元素', () => {
    const c = baseContract()
    c.driver.command = []
    expect(validateProjectContract(c).errors.some((e) => e.includes('driver.command'))).toBe(true)
    c.driver.command = ['python', 42] as unknown as string[]
    expect(validateProjectContract(c).errors.some((e) => e.includes('driver.command'))).toBe(true)
  })

  it('timeout_ms 越界（<1000 或 >600000）', () => {
    const c = baseContract()
    for (const bad of [0, 999, 600_001]) {
      c.driver.timeout_ms = bad
      expect(validateProjectContract(c).errors.some((e) => e.includes('timeout_ms')), String(bad)).toBe(true)
    }
  })

  it('exit_code_semantics 缺三分类键', () => {
    const c = baseContract()
    delete (c.driver.exit_code_semantics as Record<string, string>)['2']
    expect(validateProjectContract(c).errors.some((e) => e.includes('「2」'))).toBe(true)
  })

  it('assert_readback 空', () => {
    const c = baseContract()
    c.driver.assert_readback = ''
    expect(validateProjectContract(c).errors.some((e) => e.includes('assert_readback'))).toBe(true)
  })

  it('env_whitelist/components 非字符串数组', () => {
    const c = baseContract()
    ;(c as unknown as Record<string, unknown>).env_whitelist = 'PATH'
    expect(validateProjectContract(c).errors.some((e) => e.includes('env_whitelist'))).toBe(true)
  })

  it('self_check 形态违规（可选面存在即校验）', () => {
    const c = baseContract()
    ;(c.self_check as unknown as Record<string, unknown>).expect_exit = '0'
    expect(validateProjectContract(c).errors.some((e) => e.includes('self_check'))).toBe(true)
  })

  it('packaging 形态违规', () => {
    const c = baseContract()
    ;(c.packaging as unknown as Record<string, unknown>).tool = 123
    expect(validateProjectContract(c).errors.some((e) => e.includes('packaging'))).toBe(true)
  })
})

describe('命令黑名单', () => {
  it('注册表/Shell/破坏性命令全命中', () => {
    for (const command of [
      ['reg', 'query', 'HKLM'],
      ['regedit', '/s', 'x.reg'],
      ['powershell', '-Command', 'Get-Process'],
      ['cmd', '/c', 'dir'],
      ['format', 'D:'],
      ['del', '/s', '/q', 'C:\\x'],
      ['rmdir', '/s', '/q', 'x'],
      ['shutdown', '/r'],
      ['taskkill', '/f', '/im', 'x.exe'],
      ['schtasks', '/create'],
      ['python', 'C:\\Windows\\system32\\x.py'],
      ['python', 'C:/System32/x.py'],
    ]) {
      expect(violatesCommandBlacklist(command), command.join(' ')).not.toBeNull()
    }
  })

  it('合法驱动命令不命中', () => {
    for (const command of [
      ['python', 'driver-skeleton.py'],
      ['python', 'app.py', '--self-check'],
      ['.venv\\Scripts\\python.exe', '-m', 'pytest', '-q'],
      ['dist/app.exe', '--self-check'],
    ]) {
      expect(violatesCommandBlacklist(command), command.join(' ')).toBeNull()
    }
  })

  it('契约内黑名单命令 → schema 校验拒绝（driver/self_check/packaging.smoke 三面全覆盖）', () => {
    const c1 = baseContract()
    c1.driver.command = ['powershell', '-File', 'run.ps1']
    expect(validateProjectContract(c1).errors.some((e) => e.includes('driver.命令命中黑名单'))).toBe(true)

    const c2 = baseContract()
    c2.self_check!.command = ['reg', 'query', 'HKLM']
    expect(validateProjectContract(c2).errors.some((e) => e.includes('self_check.命令命中黑名单'))).toBe(true)

    const c3 = baseContract()
    c3.packaging!.smoke.command = ['cmd', '/c', 'app.exe']
    expect(validateProjectContract(c3).errors.some((e) => e.includes('packaging.smoke.命令命中黑名单'))).toBe(true)
  })
})

describe('env 白名单变量名形态', () => {
  it('合法名通过；注入形态拒绝（小写/含空格/含等号）', () => {
    const c = baseContract()
    c.env_whitelist = ['BLOMA_APP_LLM_KEY', 'MY_TOOL_CONFIG']
    expect(validateProjectContract(c).valid).toBe(true)
    for (const bad of ['path', 'X=Y', 'A B', '-FLAG', '']) {
      c.env_whitelist = [bad]
      expect(validateProjectContract(c).errors.some((e) => e.includes('env_whitelist')), JSON.stringify(bad)).toBe(true)
    }
  })
})

describe('parseProjectContract（fail-closed）', () => {
  it('JSON 解析失败抛 CONTRACT_PARSE_FAILED', () => {
    expect(() => parseProjectContract('{not json')).toThrow(/CONTRACT_PARSE_FAILED/)
  })

  it('校验不过抛 CONTRACT_INVALID（错误清单入消息）', () => {
    expect(() => parseProjectContract('{"schema_version": 9}')).toThrow(/CONTRACT_INVALID/)
  })
})
