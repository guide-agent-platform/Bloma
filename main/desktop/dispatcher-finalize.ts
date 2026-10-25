/**
 * 桌面调度员收口判定族（批10 旧账③ R7 拆分，2026-10-07）——从 dispatcher-loop.ts
 * 原样迁出（零行为变化）：两道确定性门（裁判门/安全门）+ 非 verify 纯装配收口
 * （finalizeDesktopDispatch）+ verify 异步完整收口（runVerifyFinalize：契约解析→
 * 驱动执行→覆盖聚合→最低证据门→安全门→裁判门→测试有效性→PQ→checkpoint）。
 *
 * dispatcher-loop 对外 re-export 本模块公开成员（旧路径零断链，hub 化惯例）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PhaseNode } from './dispatcher-phases'
import { evaluateAdvance, type AdvanceDecision } from './dispatcher-gate'
import { parseProjectContract, aggregateAcceptanceCoverage, type ProjectContract } from './contract-schema'
import { earlyArtifactIssues } from './early-artifacts'
import { runContractDriver, execFileDriverSpawn, type DriverExecutionReport } from './process-driver'
import { runSecurityScan } from '../verification/security-scan'
import { findProject } from '../project/project-service'
import { recordPhaseCheckpoint } from './phase-checkpoint'
import { runProviderQualificationIfLlm } from './provider-qualification'
import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority } from '../model/prd-backplane'
import type { AssistantTurnCollector, DesktopDispatchRunInput } from './dispatcher-loop'

/** 驱动报告落盘相对路径（对齐阶段表 desktop-verify gate 产物）。 */
export const DRIVER_REPORT_PATH = '00_VERIFY/driver-report.json'
/** 故障种子击杀报告（批6 2026-10-06）：AST 反空 + 击杀明细，MVP 过目页注入段消费。 */
export const FAULT_KILL_REPORT_PATH = '00_VERIFY/fault-kill-report.json'

/** 契约默认路径（对齐批次 B 骨架）。 */
export const CONTRACT_PATH = '00_SCAFFOLD/contract.json'

/** finalize 的中间产物（驱动前置只发生在 desktop-verify）。 */
export interface DesktopFinalizeOutcome {
  testEffectiveness?: import('./test-effectiveness').TestEffectivenessOutcome
  advance: AdvanceDecision
  driverReport?: DriverExecutionReport
  /** P0-1c 软对账：裁判门附带的 P0 断言覆盖缺口（观测不阻断）。 */
  judgeCoverageGaps?: string[]
  /** 刀2 checkpoint：advance 分支写入的阶段存证。 */
  checkpoint?: { stage: string }
}

/** P0-1 完整版（2026-10-02）：桌面线裁判门——judge-engine 确定性硬约束的桌面化子集。
 *  对齐 09-26 拍板「验收走驱动执行」：不复活 GWT/LLM 语义腿，只做零渠道依赖的
 *  fail-closed 规则门——① PRD 背板存在且功能项非空（judge ① 原语义）；② 驱动场景
 *  覆盖（judge ② 桌面化：P0 功能项数 ≤ driver 非 skipped 场景数，场景源=driver 回读
 *  锚点，非生成方自述）；③ 入口真实存在（judge ③ 存在性基线的契约制等价物：
 *  contract.entry 指向的文件在产物根存在）。附软对账（P0-1c）：P0 断言关键词 ↔
 *  driver 场景名命中率，只观测进遥测不阻断（防误杀，狗粮跑一轮看误杀率再议升硬门）。 */
function runDesktopJudgeGate(input: {
  projectId: string
  sandboxRoot?: string
  driverReport: DriverExecutionReport
  entryFile: string
  contract?: ProjectContract
}): { passed: boolean; hardFailures: string[]; coverageGaps: string[] } | null {
  let backplane: ReturnType<typeof readPrdBackplane>
  try {
    backplane = readPrdBackplane(input.projectId)
  } catch {
    return null // 无项目上下文（测试桩）：不阻断，留痕
  }
  const hardFailures: string[] = []
  const coverageGaps: string[] = []
  const requirements = backplane.requirements ?? []
  // ① PRD 存在性（judge ①）
  if (requirements.length === 0) hardFailures.push('PRD 核心功能项为空——没有可验收的需求清单，不能交付')
  // ② 驱动场景覆盖（judge ② 桌面化；批4 2026-10-06 升级为验收点映射完整性）
  const p0Items = requirements.filter((item) => requirementPriority(item) === 'P0')
  const coveredScenarios = input.driverReport.scenarios.filter((scenario) => scenario.outcome !== 'skipped')
  if (input.contract && Array.isArray(input.contract.scenarios) && input.contract.scenarios.length > 0) {
    // 映射制（新基线）：covers 悬空硬拦；每个 P0 F-id 至少一个全绿覆盖；P1 缺口软观测
    const coverage = input.driverReport.acceptance_coverage ?? aggregateAcceptanceCoverage(input.contract, input.driverReport.scenarios)
    const fidSet = new Set(requirements.map((item) => item.id))
    for (const entry of coverage) {
      if (!fidSet.has(entry.fid)) {
        hardFailures.push(`场景映射 covers 引用了 PRD 里不存在的验收点 ${entry.fid}——映射悬空，请对齐 F-id（场景：${entry.scenarios.join('、')}）`)
      }
    }
    for (const item of p0Items) {
      const entry = coverage.find((e) => e.fid === item.id)
      if (!entry) {
        hardFailures.push(`验收点 ${item.id} 没有任何驱动场景覆盖（contract.json scenarios.covers 未含它）——每个 P0 功能项至少一个场景，否则验收语义悬空`)
      } else if (!entry.passed) {
        hardFailures.push(`验收点 ${item.id} 的覆盖场景未全绿（${entry.scenarios.join('、')}）——P0 验收点必须全部通过`)
      }
    }
    // P1 映射缺口：软观测（狗粮标定一轮后再议升硬门——与 P0-1c 同节奏）
    const p1Items = requirements.filter((item) => requirementPriority(item) === 'P1')
    for (const item of p1Items) {
      const entry = coverage.find((e) => e.fid === item.id)
      if (!entry) coverageGaps.push(`${item.id}: 无场景覆盖（P1 映射缺口）`)
    }
  } else if (coveredScenarios.length < p0Items.length) {
    // 无映射存量契约（收紧前旧项目防御路径）：沿用计数粗检
    hardFailures.push(
      `驱动场景覆盖不足：PRD 有 ${p0Items.length} 个核心（P0）功能项（${p0Items.map((i) => i.id).join('、')}），driver 只回读了 ${coveredScenarios.length} 个非 skipped 场景——每个核心功能项至少要有一个场景验证`,
    )
  }
  // ③ 入口存在（judge ③ 契约制等价物；driver 真实执行已由收口前置步骤保证）。
  // 路径口径（狗粮 f277dbf1 实证修正，2026-10-02）：entry 是应用入口的产物形态声明，
  // 桌面骨架标准布局里实现文件在 00_IMPLEMENT/ 下（骨架样例 entry:"app.py" 对应
  // 00_IMPLEMENT/app.py）——项目根直下或 00_IMPLEMENT/ 下存在都算，不写死根目录。
  // ada13257 脑测批（2026-10-02）：+00_SCAFFOLD/ 候选——scaffold 产物全部生成在
  // 00_SCAFFOLD/，任务书未规定最终布局时模型原地续接是合法理解；三候选防
  // 「布局假设未成 spec → 门禁随机撞墙」（f277dbf1 模型自己搬文件、ada13257 原地续接）。
  const rootPath = input.sandboxRoot
  if (rootPath) {
    const entryCandidates = [join(rootPath, input.entryFile), join(rootPath, '00_IMPLEMENT', input.entryFile), join(rootPath, '00_SCAFFOLD', input.entryFile)]
    if (!entryCandidates.some((candidate) => existsSync(candidate))) {
      hardFailures.push(`工程契约声明的入口文件（${input.entryFile}）在产物中不存在（项目根与 00_IMPLEMENT/ 均未找到）——没有可运行的入口，不能交付`)
    }
  }
  // 软对账（P0-1c）：P0 断言关键词在场景名中的命中率——观测不阻断。中文断言多是无
  // 分隔长句，逐词 split 会误报（实证：'添加待办后列表新增一条' vs 场景'添加待办场景'
  // 无一命中）——改 2-gram 滑窗从宽命中（漏报少；软观测只暴露完全没对上的缺口，
  // 精确口径待狗粮数据标定后再收）。
  const scenarioText = coveredScenarios.map((scenario) => scenario.name).join('\n')
  for (const item of p0Items) {
    for (const assertion of item.behavior_assertions ?? []) {
      const cleaned = assertion.replace(/[→→，。;；\s]/g, '')
      const bigrams: string[] = []
      for (let index = 0; index + 2 <= cleaned.length; index += 1) bigrams.push(cleaned.slice(index, index + 2))
      const hit = bigrams.length === 0 || bigrams.some((bigram) => scenarioText.includes(bigram))
      if (!hit) coverageGaps.push(`${item.id}: ${assertion}`)
    }
  }
  return { passed: hardFailures.length === 0, hardFailures, coverageGaps }
}

/** 宿主强制安全扫描门（P0-1 缓解，2026-10-02）：返回 null = 无项目上下文/扫描器异常，
 *  跳过（行为等同旧世界）；返回扫描结果由调用方 fail-closed 裁决。 */
function runHostSecurityGate(input: { projectId: string; sandboxRoot?: string }):
  | { passed: boolean; blocking: number; scanned: number; listing: string }
  | null {
  let rootPath = input.sandboxRoot
  if (!rootPath) {
    try {
      rootPath = findProject(input.projectId).root_path
    } catch {
      return null // 无项目上下文（测试桩/纯会话）：不阻断，留痕
    }
  }
  try {
    const result = runSecurityScan({ project_id: input.projectId, root_path: rootPath,
      ...(findProject(input.projectId).workflow_version === 'software-v1' ? { profile: 'local-software' as const } : {}) })
    const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
    return {
      passed: result.passed,
      blocking: blocking.length,
      scanned: result.scanned_files,
      listing: blocking.slice(0, 10).map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n'),
    }
  } catch (error) {
    console.error('[desktop-verify] 宿主安全扫描执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}

/**
 * 收口判定（非 verify 阶段——纯装配，I/O 全注入；desktop-verify 走 runVerifyFinalize
 * 异步完整版：驱动 spawn 是异步的）。
 * 刀1（2026-10-02）：manual 确认凭据检查已随阶段表撤 manual 门而删除——中间阶段
 * 门禁全绿即 advance，人工确认退出推进链（异常出口在编排层：拒收闭环降级转
 * blocked + 人话卡）。
 */
export function finalizeDesktopDispatch(
  node: PhaseNode,
  input: DesktopDispatchRunInput,
  collector: AssistantTurnCollector,
): DesktopFinalizeOutcome {
  const turns = collector.flush()
  const vars = { project_name: input.projectName }
  const exists = input.artifactExists ?? ((rel: string) => Boolean(input.sandboxRoot) && existsSync(join(input.sandboxRoot!, rel)))

  const advance = evaluateAdvance(turns, node.id, exists, vars)
  const reader = input.artifactRead ?? (input.sandboxRoot ? (rel: string) => {
    try { return readFileSync(join(input.sandboxRoot!, rel), 'utf8') } catch { return undefined }
  } : undefined)
  if (advance.decision === 'advance' && reader && ['desktop-arch', 'desktop-scaffold'].includes(node.id)) {
    let prd: ReturnType<typeof readPrdBackplane> | undefined
    try { prd = readPrdBackplane(input.projectId) } catch { /* pure/injected callers may omit a project */ }
    const issues = earlyArtifactIssues(node.id, reader, prd)
    if (issues.length) return { advance: { decision: 'reject', reason: 'contract-invalid', missingArtifacts: [], discardedObservations: advance.discardedObservations,
      education: `前置产物检查未通过：\n${issues.map(issue => `- ${issue}`).join('\n')}\n修好当前阶段的内容再推进，不进入后续实现。` } }
  }
  return { advance }
}

/** verify 收口（异步完整版）：契约解析 fail-closed → 驱动真实执行+覆盖聚合落盘 →
 *  routing 拒因语义保真 → 最低验证证据门 → 宿主安全门 → 裁判门 → 测试有效性反证
 *  （AST 反空+故障种子击杀）→ evaluateAdvance 三关 → 全绿时 PQ+verified checkpoint。 */
export async function runVerifyFinalize(
  node: PhaseNode,
  input: DesktopDispatchRunInput,
  collector: AssistantTurnCollector,
): Promise<DesktopFinalizeOutcome> {
  const turns = collector.flush()
  const vars = { project_name: input.projectName }

  // 刀1（2026-10-02）：确认凭据检查已删（阶段表撤 manual 门）——verify 四门
  //（证据门→安全门→裁判门→三关）全绿即 advance，终态推进链由 desktop-route 收口。
  const contractText = input.readContract?.()
  if (contractText === undefined) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [CONTRACT_PATH] }],
        discardedObservations: [],
        education: `工程契约缺失（${CONTRACT_PATH}）——驱动执行的前提不存在。请先委派补齐工程契约，再进入验证收口。`,
      },
    }
  }
  let contract
  try {
    contract = parseProjectContract(contractText)
  } catch (error) {
    return {
      advance: {
        decision: 'reject',
        reason: 'contract-invalid',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [CONTRACT_PATH] }],
        discardedObservations: [],
        education: `工程契约不合法：${error instanceof Error ? error.message : String(error)}\n驱动执行 fail-closed。请对照任务书内的最小合规样例修正字段名与类型后重试。`,
      },
    }
  }

  const report = await runContractDriver({
    contract,
    cwd: input.sandboxRoot ?? process.cwd(),
    spawn: input.driverSpawn ?? execFileDriverSpawn,
    parentEnv: process.env,
  })
  // 验收点覆盖聚合（批4 2026-10-06）：F-id → 覆盖场景与全绿判定，随报告落盘
  // （driver-report.json 佐证面）+ judge 门硬校验 + 遥测三处同一口径。
  report.acceptance_coverage = aggregateAcceptanceCoverage(contract, report.scenarios)
  input.writeReport?.(DRIVER_REPORT_PATH, JSON.stringify(report, null, 2))

  if (report.routing !== 'pass') {
    // 狗粮实证（f277dbf1）：教育带执行证据直达修复轮；批9.5 拒因语义保真（竞品 v131
    // R1 同族；本仓 4ad53aa7：超时被 artifacts-missing 伪装产物缺失误导归因）——blocked
    // 与 fail 各自独立枚举，续接不再渲染「缺失产物清单」误导补报告。
    const stderrTail = (report.stderrExcerpt ?? '').trim().split(/\r?\n/).filter(Boolean)
    const lastError = stderrTail.length > 0 ? stderrTail[stderrTail.length - 1] : ''
    const stackHint = stderrTail.find((line) => /\sFile\s"/.test(line)) ?? ''
    const evidence = lastError ? `\n执行证据：${lastError.slice(0, 160)}${stackHint ? `（首个栈帧：${stackHint.trim().slice(0, 160)}）` : ''}` : ''
    const blocked = report.routing === 'blocked'
    return {
      advance: {
        decision: 'reject',
        reason: blocked ? 'driver-blocked' : 'driver-fail',
        discardedObservations: [],
        education: blocked
          ? `驱动执行被环境阻塞（超时/取消/装配/语义源漂移——不是产物缺失，不要去补报告文件）：${report.routingReason}${evidence}\n请先解决驱动环境（预算/装配）后重新收口。`
          : `驱动断言未通过（fail）：${report.routingReason}${evidence}\n验证结论只看驱动执行回读——请按失败场景修复后重新收口。`,
      },
      driverReport: report,
    }
  }

  // 最低验证证据门（全链路审查 P1-5，2026-10-02）：零场景锚点 + 零 SUMMARY 自报的
  // 「空驱动」（exit 0 直通）不得作为验证凭据——生成方=验收方同源，零断言的 driver
  // 等于没验。要求场景锚点或 SUMMARY 行至少其一；两者皆无 → 按验证产物不足拒收。
  if (report.scenarios.length === 0 && report.summaryLine === null) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          '驱动报告没有任何验证证据（零场景锚点、零 SUMMARY 自报）——退出码 0 不能替代断言。' +
          '合法锚点形态任选其一（每场景一行）：`PASS <场景名>`、`S<编号> PASS <一句话结论>`、' +
          '`SCENARIO|<编号>|pass|<描述>`；或终行 `SUMMARY pass=<n> fail=<m>`。' +
          '请让 driver 按其中一种形态回读全部场景后重新收口。',
      },
      driverReport: report,
    }
  }

  // 宿主强制安全扫描门（全链路审查 P0-1 缓解，2026-10-02）：driver pass ≠ 安全——
  // 扫描不再依赖子会话自愿调用，收口时宿主对产物根强制扫一遍（扫描器已含 .py 硬红线），
  // 高危/严重命中 → 拒收推进（fail-closed）。无项目上下文（测试桩/纯会话场景）时跳过，
  // 行为等同旧世界（不比旧世界差）；扫描器自身异常同样跳过并留痕（安全门不做可用性单点）。
  const securityGate = runHostSecurityGate(input)
  if (!securityGate && input.sandboxRoot) {
    return { advance: { decision: 'reject', reason: 'driver-blocked', discardedObservations: [],
      education: '安全检查未执行完成，核心功能尚不能完整交付。请排查检查环境后补验，不要重写业务或伪造通过。' }, driverReport: report }
  }
  if (securityGate && !securityGate.passed) {
    return {
      advance: {
        decision: 'reject',
        // 语义化拒因（2026-10-05 256001d0 事故）：安全门误报时 reason 笼统写成
        // artifacts-missing，模型按「产物缺失」的错误线索空转三轮——拒因与教育
        // 文案对齐，归因不再绕路。
        reason: 'security-fail',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          `宿主安全扫描未通过（${securityGate.blocking} 个高危/严重问题，扫描 ${securityGate.scanned} 个文件）：\n` +
          `${securityGate.listing}\n请修复后重新收口；扫描门是硬门（fail-closed），driver 通过不能豁免。`,
      },
      driverReport: report,
    }
  }

  const exists = input.artifactExists
    ?? ((rel: string) => Boolean(input.sandboxRoot) && existsSync(join(input.sandboxRoot!, rel)))
  // 报告已落盘在 writeReport 注入位；存在性验证用「报告已产出」事实短路（谓词看不到
  // 注入桩写的路径时以 driverReport 存在为准）
  const existsWithReport = (rel: string) => (rel === DRIVER_REPORT_PATH ? true : exists(rel))

  // 裁判门（P0-1a/1c，2026-10-02）：judge-engine 确定性硬约束的桌面化（PRD 存在/驱动
  // 场景覆盖 P0/入口真实存在）——零渠道依赖 fail-closed；软对账（P0 断言关键词 ↔ 场景
  // 名命中）不阻断，进遥测供狗粮标定。无项目上下文（测试桩）跳过不阻断。
  const judgeGate = runDesktopJudgeGate({
    projectId: input.projectId,
    sandboxRoot: input.sandboxRoot,
    driverReport: report,
    entryFile: contract.entry,
    contract,
  })

  if (judgeGate && !judgeGate.passed) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          `裁判门未过（硬约束 ${judgeGate.hardFailures.length} 项）：\n${judgeGate.hardFailures.map((f) => `- ${f}`).join('\n')}\n` +
          '请补齐后重新收口；硬约束是交付底线，driver 通过不能豁免。',
      },
      driverReport: report,
      ...(judgeGate.coverageGaps.length > 0 ? { judgeCoverageGaps: judgeGate.coverageGaps } : {}),
    }
  }

  // ── 批6 测试有效性反证（2026-10-06）：「测试绿了但什么也没证明」的防线 ──
  // 6a AST 反空（永真断言/吞异常/无断言 → test-invalid）+ 6b P0 故障种子击杀
  //（survived → fault-survived）；工具不可用降级跳过如实标注（不误杀不伪装）；
  // not_applicable/not_run 呈现不阻塞（首版拍板）。实现在 test-effectiveness.ts（R7）。
  let testEffectiveness: import('./test-effectiveness').TestEffectivenessOutcome | undefined
  const verificationPolicy = input.verificationPolicy ?? (process.env.BLOMA_VERIFY_POLICY === 'strict' ? 'strict' : 'standard')
  {
    const { runVerifyEffectivenessPhase, buildTestInvalidReject, buildFaultSurvivedReject } = await import('./test-effectiveness')
    testEffectiveness = await runVerifyEffectivenessPhase({
      projectId: input.projectId,
      sandboxRoot: input.sandboxRoot,
      contract,
      driverSpawn: input.driverSpawn,
      policy: verificationPolicy,
    })
    if (testEffectiveness) {
      input.writeReport?.(FAULT_KILL_REPORT_PATH, JSON.stringify({ policy: verificationPolicy, audit: testEffectiveness.audit, faultKill: testEffectiveness.faultKill }, null, 2))
      const rejectedFindings = testEffectiveness.audit.findings.filter((f) => f.state === 'reject')
      if (verificationPolicy === 'strict' && !testEffectiveness.audit.passed && testEffectiveness.audit.error === undefined && rejectedFindings.length > 0) {
        return { advance: buildTestInvalidReject(testEffectiveness, report, DRIVER_REPORT_PATH), driverReport: report, testEffectiveness }
      }
      if (testEffectiveness.faultKill.error) {
        return { advance: { decision: 'reject', reason: 'driver-blocked', discardedObservations: [], education: testEffectiveness.faultKill.error }, driverReport: report, testEffectiveness }
      }
      if (verificationPolicy === 'strict' && testEffectiveness.faultKill.survived > 0) {
        return { advance: buildFaultSurvivedReject(testEffectiveness, FAULT_KILL_REPORT_PATH), driverReport: report, testEffectiveness }
      }
    }
  }

  const outcome = evaluateAdvance(turns, node.id, existsWithReport, vars)

  // P0-1b + 刀2（2026-10-02）：全绿收口（driver pass + 证据门 + 安全门 + 裁判门 + 阶段判定
  // 推进）落 verified 阶段存证（checkpoint 泛化 P0-1b 快照：验证结论进 desktop_checkpoint，
  // 同阶段重跑注入勿重验）；快照失败不阻断推进（仅留痕，下次收口可补）。恢复消费端
  // （latestVerifiedSnapshot 熔断回滚优先恢复）自此有生产写入方。
  let checkpoint: { stage: string } | undefined
  if (outcome.decision === 'advance' && judgeGate?.passed) {
    // 批9 工件6.3：Provider Qualification 只在全绿收口时跑（拒收/回炉轮不烧真实调用预算
    // ——幂等短路只挡 qualified=true 重跑；fail 每轮拒收都会再调 ≤2 次）。
    if (input.sandboxRoot) await runProviderQualificationIfLlm({ projectId: input.projectId, sessionId: input.sessionId, sandboxRoot: input.sandboxRoot })
    const recorded = await recordPhaseCheckpoint({
      sandboxRoot: input.sandboxRoot,
      requirementsDigest: input.requirementsDigest,
      projectId: input.projectId,
      requestId: input.requestId,
      stage: node.id,
      gates: [
        `driver-report: ${report.scenarios.filter((s) => s.outcome === 'pass').length}/${report.scenarios.length} 场景 PASS（${report.routing}）`,
        ...(securityGate ? [`security-scan: 通过（${securityGate.scanned} 文件扫描，0 高危）`] : []),
        `judge-gate: 硬约束通过${judgeGate.coverageGaps.length > 0 ? `（软对账缺口 ${judgeGate.coverageGaps.length} 项，观测不阻断）` : ''}`,
        ...(testEffectiveness
          ? [`verification-policy: ${verificationPolicy}; static-audit: ${testEffectiveness.audit.error ? 'unavailable' : testEffectiveness.audit.passed ? 'passed' : 'findings'}; mutation: killed=${testEffectiveness.faultKill.killed}, executed=${testEffectiveness.faultKill.executed}, not-run=${testEffectiveness.faultKill.notRun}`]
          : []),
        `advance-marks: 推进标记合法（→ ${outcome.target}）`,
      ],
      summary: `desktop-verify 全绿（driver ${report.scenarios.filter((s) => s.outcome === 'pass').length}/${report.scenarios.length} 场景 + 安全扫描 + 裁判硬约束）`,
      verification: 'verified',
    })
    checkpoint = recorded ?? undefined
  }

  return {
    advance: outcome,
    driverReport: report,
    ...(judgeGate && judgeGate.coverageGaps.length > 0 ? { judgeCoverageGaps: judgeGate.coverageGaps } : {}),
    ...(testEffectiveness ? { testEffectiveness } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  }
}
