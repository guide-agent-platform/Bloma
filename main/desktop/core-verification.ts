import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority } from '../model/prd-backplane'
import { parseProjectContract } from './contract-schema'
import { execFileDriverSpawn, runContractDriver, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

export type CoreVerificationStatus = 'passed' | 'failed' | 'unverified' | 'environment_blocked'
export interface CoreVerificationResult {
  status: CoreVerificationStatus
  summary: string
  checked_at: string
  fingerprint?: string
  missing: string[]
  evidence: Array<{ fid: string; scenario: string; input: string; outcome: string }>
}
interface CoreScenario { name: string; covers: string[]; input: 'logic' | 'gui' | 'audio' | 'microphone' | 'mock' }
export const CORE_MANIFEST_REL = 'CORE_CHECK.json'
export const CORE_REPORT_REL = '00_VERIFY/core-verification.json'

function scenarioOutcome(stdout: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(PASS|FAIL|BLOCKED|SKIP)\\s+${escaped}(?::|$)`)
  const states = stdout.split(/\r?\n/).flatMap(line => {
    const match = pattern.exec(line.trim())
    return match ? [({ PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked', SKIP: 'skipped' } as Record<string, string>)[match[1]!]!] : []
  })
  return states.includes('fail') ? 'fail' : states.includes('blocked') ? 'blocked' : states.length && states.every(s => s === 'pass') ? 'pass' : 'unverified'
}

/** Minimal shared execution contract; input labels alone are not real audio evidence. */
export async function runCoreVerification(options: {
  projectId: string; sandboxRoot?: string; spawn?: DriverSpawn
}): Promise<CoreVerificationResult> {
  const result: CoreVerificationResult = { status: 'unverified', summary: '已生成，核心功能待验证。', checked_at: new Date().toISOString(), missing: [], evidence: [] }
  const root = options.sandboxRoot
  try {
    if (!root) throw new Error('项目路径不可用')
    const backplane = readPrdBackplane(options.projectId)
    const required = backplane.requirements.filter(item => requirementPriority(item) === 'P0')
    if (!required.length) throw new Error('没有已确认的核心需求')
    const fingerprint = verificationFingerprint(root, required)
    result.fingerprint = fingerprint
    if (!fingerprint) throw new Error('验证输入不可完整读取，不能运行或复用未知版本证据')
    if (!existsSync(join(root, CORE_MANIFEST_REL))) throw new Error('缺少核心业务验证入口 CORE_CHECK.json')
    const raw = JSON.parse(readFileSync(join(root, CORE_MANIFEST_REL), 'utf8')) as Record<string, unknown>
    const scenarios = raw.scenarios as CoreScenario[]
    if (raw.schema_version !== 1 || !Array.isArray(scenarios) || !scenarios.length || scenarios.length > 64 || scenarios.some(s =>
      !s || typeof s.name !== 'string' || !s.name || /[\r\n]/.test(s.name) || !Array.isArray(s.covers) || s.covers.some(fid => typeof fid !== 'string') ||
      !['logic', 'gui', 'audio', 'microphone', 'mock'].includes(s.input))) throw new Error('核心验证场景声明不合法')
    const command = raw.command as string[]
    // Only an in-project Python script can be registered; no inline code/shell.
    if (!Array.isArray(command) || command.length < 2 || command.some(p => typeof p !== 'string') ||
        !/(?:^|[\\/])python(?:3)?(?:\.exe)?$/i.test(command[0] ?? '') || !command[1]?.endsWith('.py')) throw new Error('核心验证命令必须为 Python 项目脚本')
    const script = resolve(root, command[1]!)
    const rel = relative(resolve(root), script)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(script)) throw new Error('核心验证脚本缺失或不在项目内')
    const knownIds = new Set(backplane.requirements.map(r => r.id))
    if (scenarios.some(s => s.covers.some(fid => !knownIds.has(fid)))) throw new Error('核心验证引用了不存在的需求')
    const contract = parseProjectContract(JSON.stringify({ schema_version: 1, entry: 'app.py',
      driver: { command, timeout_ms: 120000, exit_code_semantics: { 0: 'pass', 1: 'fail', 2: 'blocked' }, assert_readback: 'core scenario readback' },
      components: [], env_whitelist: ['APP_DATA_DIR', 'BLOMA_SPEECH_MODEL_DIR', 'BLOMA_SPEECH_OFFLINE'], scenarios,
    }))
    const report = await runContractDriver({ contract, cwd: root, spawn: options.spawn ?? execFileDriverSpawn,
      parentEnv: { ...process.env, APP_DATA_DIR: join(root, '00_VERIFY/core-data'), BLOMA_SPEECH_OFFLINE: '1' } })
    for (const scenario of scenarios) {
      const outcome = scenarioOutcome(report.stdoutExcerpt, scenario.name)
      for (const fid of scenario.covers) result.evidence.push({ fid, scenario: scenario.name, input: scenario.input, outcome })
    }
    if (verificationFingerprint(root, required) !== fingerprint) result.missing.push('验证期间源码或声明变化，本次结果作废')
    for (const requirement of required) {
      const rows = result.evidence.filter(e => e.fid === requirement.id && e.outcome === 'pass' && e.input !== 'mock')
      if (!rows.length) result.missing.push(requirement.id)
      // A product-owned test label cannot attest microphone capture or real-model execution.
      if (/(?:语音(?:输入|录入|识别|转写)|麦克风|录音|ASR)/i.test(requirement.description)) {
        result.missing.push(`${requirement.id}: 需要宿主音频探针与实际采集证据；文本模拟或自报 audio 不可替代`)
      }
    }
    if (!result.evidence.some(e => e.input === 'gui' && e.outcome === 'pass')) result.missing.push('缺少关键界面业务链的驱动回读')
    if (report.routing !== 'pass') result.missing.push(report.routingReason, report.stderrExcerpt.slice(0, 300))
    if (report.routing === 'blocked') { result.status = 'environment_blocked'; result.summary = '验证环境未就绪，程序已保留。' }
    else if (report.routing === 'fail') { result.status = 'failed'; result.summary = '核心功能测试失败，需要修复。' }
    else if (result.missing.length || !fingerprint) { result.summary = '已生成，核心功能仍有待验证项。' }
    else { result.status = 'passed'; result.summary = '核心业务驱动已通过，验证范围见报告。' }
  } catch (error) {
    result.missing.push(error instanceof Error ? error.message : String(error))
  }
  if (root) {
    try { const path = join(root, CORE_REPORT_REL); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(result, null, 2)) }
    catch { result.status = 'environment_blocked'; result.summary = '验证记录未能保存，不能确认交付。' }
  }
  return result
}

export const CORE_VERIFICATION_BRIEF = '\n核心业务验证：在项目根写 CORE_CHECK.json，形态 {"schema_version":1,"command":["python","core_check.py"],"scenarios":[{"name":"新增并重启仍保留","covers":["F-001"],"input":"gui"}]}。每个核心 P0 需求至少一条实际业务断言，stdout 为 PASS/FAIL/BLOCKED 加完全一致的场景名。input 如实填 logic/gui/audio/microphone/mock；mock 不覆盖核心真实能力。数据目录从 APP_DATA_DIR 读取。语音的文本模拟不能覆盖录音或 ASR；环境不具备时明确待验证。不要修改已确认需求或测试期望来绕过失败。'
