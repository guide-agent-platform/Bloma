/**
 * 测试有效性反证（批6 2026-10-06，会话 f35363f6 讨论 turn11 第 5 点）：
 * - 6a AST 反空：平台资产 contract-audit.py 三态检查（reject/inconclusive/pass_static）
 *   ——标准模式仅诊断；严格模式 reject 阻断，inconclusive 呈现不阻断。
 * - 6b 故障种子击杀：平台资产 fault-seeds.py 语义种子（非随机变异，等价变异率低）
 *   仅严格模式执行。存活提示核对注入相关性和覆盖；环境阻塞不记击杀，恢复失败停止。
 *   标准模式不改写产物，不用未执行的变异检查证明业务已通过。
 *
 * 挂点：verify 收口 driver 全绿 + 裁判门之后（longterm 专属路径；quick 直通道不经过）。
 * 产物：00_VERIFY/fault-kill-report.json（MVP 过目页注入段消费）。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path'
import { mainRootDir } from '../platform/paths'
import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority } from '../model/prd-backplane'
import { runContractDriver, execFileDriverSpawn, type DriverExecutionReport } from './process-driver'
import type { ProjectContract } from './contract-schema'
import type { AdvanceDecision } from './dispatcher-gate'

export interface AuditFinding {
  file: string
  line: number
  kind: string
  /** whitelisted（批9）：生成层指标断言正向观测——不计求值、不阻断（分层断言白名单）。 */
  state: 'reject' | 'inconclusive' | 'whitelisted'
  detail: string
}

export type FaultKillResult = 'killed' | 'survived' | 'not_applicable' | 'not_run'

export interface FaultKillEntry {
  fid: string
  seed: string
  result: FaultKillResult
  detail?: string
}

export interface TestEffectivenessOutcome {
  /** standard: static diagnostics only; strict: includes mutation execution. */
  mode?: 'standard' | 'strict'
  audit: {
    passed: boolean
    findings: AuditFinding[]
    auditedFiles: string[]
    /** 审计器自身不可用（python 缺失/超时）——降级跳过并如实标注，不误杀 */
    error?: string
  }
  faultKill: {
    entries: FaultKillEntry[]
    executed: number
    killed: number
    survived: number
    notApplicable: number
    notRun: number
    passed: boolean
    error?: string
  }
}

export interface TestEffectivenessDeps {
  runAudit?: (files: string[]) => Promise<{ findings: AuditFinding[]; error?: string }>
  applySeed?: (file: string, seed: string) => Promise<{ applied: boolean; reason?: string; function?: string; line?: number }>
  restoreFile?: (file: string) => Promise<boolean>
  /** 注入后的驱动复跑（收口侧复用 runContractDriver 同款 spawn） */
  runDriver: () => Promise<{ routing: 'pass' | 'fail' | 'blocked'; routingReason?: string }>
  /** 击杀预算毫秒（缺省 60s；超预算剩余点记 not_run） */
  budgetMs?: number
}

/** P0 点种子轮换（确定性：点序 → 种子起点，三个种子依次尝试到 applied）。 */
const SEED_CYCLE = ['FS-VALIDATION-REMOVE', 'FS-SAVE-NOP', 'FS-BUTTON-NOP'] as const

const AUDIT_ASSET = join(mainRootDir(), 'templates', 'tools', 'contract-audit.py')
const SEEDS_ASSET = join(mainRootDir(), 'templates', 'tools', 'fault-seeds.py')

/** 运行平台 Python 资产并解析末行 JSON（超时/不可用返回 {__error}——调用方降级）。 */
function runPythonAsset<T>(args: string[], timeoutMs: number): Promise<T | { __error: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    try {
      const child = spawn('python', [args[0]!, ...args.slice(1)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill()
        resolve({ __error: `资产超时（${timeoutMs}ms）` })
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 32_768) stdout += chunk.toString('utf8')
      })
      child.once('exit', () => {
        clearTimeout(timer)
        const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            resolve(JSON.parse(lines[i]!) as T)
            return
          } catch {
            // 尝试上一行
          }
        }
        resolve({ __error: stdout.trim() ? '输出无法解析' : '无输出' })
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ __error: error instanceof Error ? error.message : String(error) })
      })
    } catch (error) {
      resolve({ __error: error instanceof Error ? error.message : String(error) })
    }
  })
}

async function defaultRunAudit(files: string[]): Promise<{ findings: AuditFinding[]; error?: string }> {
  if (files.length === 0) return { findings: [], error: '无可审计的测试脚本（driver command 无 .py 参数）' }
  if (!existsSync(AUDIT_ASSET)) return { findings: [], error: '平台资产缺失：contract-audit.py' }
  const result = await runPythonAsset<{ findings?: AuditFinding[] }>([AUDIT_ASSET, '--files', ...files], 30_000)
  if ('__error' in result) return { findings: [], error: `审计器不可用：${result.__error}` }
  return { findings: Array.isArray(result.findings) ? result.findings : [] }
}

async function defaultApplySeed(file: string, seed: string): Promise<{ applied: boolean; reason?: string; function?: string; line?: number }> {
  if (!existsSync(SEEDS_ASSET)) return { applied: false, reason: '平台资产缺失：fault-seeds.py' }
  const result = await runPythonAsset<{ applied?: boolean; reason?: string; function?: string; line?: number }>(
    [SEEDS_ASSET, '--file', file, '--seed', seed, '--apply'],
    15_000,
  )
  if ('__error' in result) return { applied: false, reason: `种子器不可用：${result.__error}` }
  return { applied: result.applied === true, reason: result.reason, function: result.function, line: result.line }
}

async function defaultRestoreFile(file: string): Promise<boolean> {
  // 首选资产恢复；失败用 TS 侧备份拷贝兜底（产物绝不能带着已知坏交付）
  try {
    const result = await runPythonAsset<{ restored?: boolean }>([SEEDS_ASSET, '--file', file, '--restore'], 10_000)
    if (!('__error' in result) && result.restored === true) return true
  } catch {
    // 走兜底
  }
  try {
    const bak = `${file}.bloma-fault.bak`
    if (existsSync(bak)) {
      copyFileSync(bak, file)
      return true
    }
  } catch {
    // 兜底也失败——交给调用方呈现（survived 判定仍会拒收，不会带着坏产物通过）
  }
  return false
}

/** 契约 driver.command 中的测试脚本（相对根解析；无 .py 参数返回空）。 */
export function auditTargetFiles(contract: ProjectContract, rootPath: string): string[] {
  return contract.driver.command
    .filter((part) => part.endsWith('.py'))
    .map((part) => (isAbsolute(part) ? part : join(rootPath, part)))
}

/** 入口候选（与裁判门③同口径：根 / 00_IMPLEMENT / 00_SCAFFOLD）。 */
export function entryCandidates(entryFile: string, rootPath: string): string[] {
  return [join(rootPath, entryFile), join(rootPath, '00_IMPLEMENT', entryFile), join(rootPath, '00_SCAFFOLD', entryFile)]
}

/**
 * 执行测试有效性双门。纯编排：audit reject / fault survived → outcome 不通过（调用方
 * 拒收）；工具不可用 → 降级跳过如实标注（不误杀、不把「未检查」伪装成「已检查」）。
 */
export async function runTestEffectivenessGates(input: {
  rootPath: string
  contract: ProjectContract
  p0Fids: string[]
  entryFile: string
  deps: TestEffectivenessDeps
  includeMutation?: boolean
}): Promise<TestEffectivenessOutcome> {
  const deps = input.deps

  // ── 6a AST 反空 ──
  const auditFiles = auditTargetFiles(input.contract, input.rootPath)
  const runAudit = deps.runAudit ?? defaultRunAudit
  const auditResult = await runAudit(auditFiles)
  const audit = {
    passed: auditResult.error === undefined && auditResult.findings.every((f) => f.state !== 'reject'),
    findings: auditResult.findings,
    auditedFiles: auditFiles,
    ...(auditResult.error ? { error: auditResult.error } : {}),
  }

  // ── 6b 故障种子击杀 ──
  const entries: FaultKillEntry[] = []
  if (input.includeMutation === false) {
    return {
      mode: 'standard', audit,
      faultKill: {
        entries: input.p0Fids.map((fid) => ({ fid, seed: '-', result: 'not_run', detail: '标准验收不自动运行故障注入；静态检查仅作诊断' })),
        executed: 0, killed: 0, survived: 0, notApplicable: 0, notRun: input.p0Fids.length, passed: true,
      },
    }
  }
  const startedAt = Date.now()
  const budgetMs = deps.budgetMs ?? 60_000
  const applySeed = deps.applySeed ?? defaultApplySeed
  const restoreFile = deps.restoreFile ?? defaultRestoreFile
  const entry = entryCandidates(input.entryFile, input.rootPath).find((candidate) => existsSync(candidate))

  if (entry === undefined) {
    return {
      audit,
      faultKill: { entries, executed: 0, killed: 0, survived: 0, notApplicable: 0, notRun: 0, passed: audit.passed, error: '入口文件不存在（种子无处注入）' },
    }
  }

  for (const [index, fid] of input.p0Fids.entries()) {
    if (Date.now() - startedAt > budgetMs) {
      entries.push({ fid, seed: '-', result: 'not_run', detail: `预算耗尽（${budgetMs}ms）` })
      continue
    }
    // 确定性轮换起点，依次尝试到 applied
    let appliedSeed: string | null = null
    let appliedInfo: { applied: boolean; reason?: string; function?: string; line?: number } | null = null
    const tried: string[] = []
    for (let step = 0; step < SEED_CYCLE.length; step++) {
      const seed = SEED_CYCLE[(index + step) % SEED_CYCLE.length]!
      if (tried.includes(seed)) continue
      tried.push(seed)
      const info = await applySeed(entry, seed)
      if (info.applied) {
        appliedSeed = seed
        appliedInfo = info
        break
      }
    }
    if (appliedSeed === null || appliedInfo === null) {
      entries.push({ fid, seed: tried.join('/'), result: 'not_applicable', detail: appliedInfo?.reason ?? '三个种子均未定位到注入点' })
      continue
    }
    const seedInfo = appliedInfo
    try {
      const rerun = await deps.runDriver()
      const result: FaultKillResult = rerun.routing === 'blocked' ? 'not_run' : rerun.routing === 'pass' ? 'survived' : 'killed'
      entries.push({
        fid,
        seed: appliedSeed,
        result,
        detail: result === 'survived'
          ? `注入 ${appliedSeed}（${seedInfo.function ?? '?'}@L${seedInfo.line ?? '?'}）后驱动仍全绿；需核对注入目标与验收点的相关性及断言覆盖`
          : result === 'not_run' ? `注入后复跑被环境阻塞：${rerun.routingReason ?? '原因未知'}；未取得击杀结论`
          : `注入 ${appliedSeed}（${seedInfo.function ?? '?'}@L${seedInfo.line ?? '?'}）被测试判红`,
      })
    } finally {
      if (!await restoreFile(entry)) {
        return { mode: 'strict', audit, faultKill: { entries, executed: 0, killed: 0, survived: 0,
          notApplicable: 0, notRun: input.p0Fids.length, passed: false, error: '故障注入后入口恢复失败，停止验证；必须恢复原文件后再交付' } }
      }
    }
  }

  const executed = entries.filter((e) => e.result === 'killed' || e.result === 'survived').length
  const killed = entries.filter((e) => e.result === 'killed').length
  const survived = entries.filter((e) => e.result === 'survived').length
  const notApplicable = entries.filter((e) => e.result === 'not_applicable').length
  const notRun = entries.filter((e) => e.result === 'not_run').length
  return {
    mode: 'strict',
    audit,
    faultKill: {
      entries,
      executed,
      killed,
      survived,
      notApplicable,
      notRun,
      // 硬门口径（首版拍板）：定位成功且执行完成的种子必须全部击杀（survived=0）；
      // not_applicable/not_run 呈现不阻塞（观测一轮狗粮后再议收紧）。audit 的通过与否
      // 独立判定（工具不可用降级由调用方守护），不在此处合并。
      passed: survived === 0,
    },
  }
}

/**
 * verify 收口批6段（R7 拆出）：背板 P0 清单 + 驱动复跑注入，返回 undefined = 无背板/
 * 无根上下文（测试桩）跳过。拒绝决策构造也在此（loop 只保留分支骨架）。
 */
export async function runVerifyEffectivenessPhase(input: {
  projectId: string
  sandboxRoot: string | undefined
  contract: ProjectContract
  driverSpawn?: Parameters<typeof runContractDriver>[0]['spawn']
  policy?: 'standard' | 'strict'
}): Promise<TestEffectivenessOutcome | undefined> {
  let p0Fids: string[] | null = null
  try {
    const backplane = readPrdBackplane(input.projectId)
    p0Fids = (backplane.requirements ?? []).filter((item) => requirementPriority(item) === 'P0').map((item) => item.id)
  } catch {
    return undefined
  }
  if (!input.sandboxRoot) return undefined
  return await runTestEffectivenessGates({
    rootPath: input.sandboxRoot,
    contract: input.contract,
    p0Fids,
    entryFile: input.contract.entry,
    includeMutation: input.policy === 'strict',
    deps: {
      runDriver: () => runContractDriver({
        contract: input.contract,
        cwd: input.sandboxRoot ?? process.cwd(),
        spawn: input.driverSpawn ?? execFileDriverSpawn,
        parentEnv: process.env,
      }).then((rerun) => ({ routing: rerun.routing, routingReason: rerun.routingReason })),
    },
  })
}

/** 6a 拒收决策（test-invalid）：永真断言/吞异常/无断言硬拒收。 */
export function buildTestInvalidReject(outcome: TestEffectivenessOutcome, driverReport: DriverExecutionReport, reportPath: string): AdvanceDecision {
  const findings = outcome.audit.findings.filter((f) => f.state === 'reject')
  return {
    decision: 'reject',
    reason: 'test-invalid',
    missingArtifacts: [{ gateId: 'driver-report', artifacts: [reportPath] }],
    discardedObservations: [],
    education:
      `测试脚本反空检查未过（永真断言/吞异常/无断言 ${findings.length} 处）：\n` +
      `${findings.slice(0, 10).map((f) => `- ${f.file} L${f.line}：${f.detail}`).join('\n')}\n` +
      '严格检查发现以上测试疑点。请核对具体分支与期望来源，修正测试基础设施或业务断言后重新收口；不要降低已确认的业务要求。',
  }
}

/** 6b 拒收决策（fault-survived）：注入已知缺陷后测试仍全绿 = 没证明任何东西。 */
export function buildFaultSurvivedReject(outcome: TestEffectivenessOutcome, reportPath: string): AdvanceDecision {
  const survivedEntries = outcome.faultKill.entries.filter((e) => e.result === 'survived')
  return {
    decision: 'reject',
    reason: 'fault-survived',
    missingArtifacts: [{ gateId: 'driver-report', artifacts: [reportPath] }],
    discardedObservations: [],
    education:
      `故障种子击杀未过（${survivedEntries.length} 个 P0 验收点的测试在注入已知缺陷后仍然全绿）：\n` +
      `${survivedEntries.map((e) => `- ${e.fid}：${e.detail ?? e.seed}`).join('\n')}\n` +
      '请先核对种子实际修改的方法是否对应本验收点，再判断是否需要补充断言；种子存活不能单独证明所有测试无效。明细见 00_VERIFY/fault-kill-report.json。',
  }
}
