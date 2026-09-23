/**
 * 领域工具面 composition（PR4c 注入反转）：run_preview / run_gwt_tests / run_security_scan /
 * run_api_contract_tests / run_preflight / repair_control 与预览浏览器工具族。
 * 工具 schema 与实现自 agent/tools 迁出——agent 运行时零领域知识，领域能力在本层（orchestration→domain 合法向）装配。
 * 调用方拼接：[...buildAgentTools(o), ...buildDomainTools(o)]（角色裁剪两边各自持半）。
 */
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { loopApiToolEnabled, preflightEnabled, toolEvidenceEnabled } from '../agent/loop/agent-loop'
import type { BuildAgentToolsOptions } from '../agent/tools/agent-tools'
import { validationStateLine, SANDBOX_LOG_TAIL_LIMIT } from '../agent/tools/agent-tools'
import { findProject, readLastSketchRequirements } from '../project/project-service'
import { readPrdBackplane } from '../project/document-engine'
import { runSandbox, getSandboxLogs } from '../delivery/sandbox'
import { rebuildRealFullstackDist } from './dist-rebuild'
import { checkApiContract } from './api-contract'
import { runArtifactUiGate } from './artifact-ui-gate'
import { planScenarios, scenarioName } from '../verification/gwt-runner'
import { runGwtScenarios } from '../verification/gwt-service'
import { runSecurityScan } from '../verification/security-scan'
import { getCachedStaticEvidence, setCachedStaticEvidence } from '../verification/evidence-cache'
import { browserToolsEnabled, buildPreviewBrowserTools } from './preview-browser'
import { readRealScaffoldVariant } from './preview-runtime'
import { scheduleProjectMapRefresh } from '../project/project-map'

export function buildDomainTools(options: BuildAgentToolsOptions): AgentLoopTool[] {
  const { projectId } = options
  // 与 buildAgentTools 同款缺省：role 未传 = parent（否则 undefined 落进子分支，parent 专属工具族丢失）
  const role = options.role ?? 'parent'
  // PR4c：变体判定由调用方注入（与 buildAgentTools 的 realFullstackVariant 同源）
  const realVariant = options.realFullstackVariant ?? false


  const run_preview: AgentLoopTool = {
    name: 'run_preview',
    description: '启动/重启项目预览并做健康探活。成功返回 preview_url；失败返回错误分类与服务器日志尾部（用于定位修复）。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      const sandbox = await runSandbox({ request_id: ctx.requestId, project_id: projectId })
      if (sandbox.status === 'running' && sandbox.preview_url) {
        ctx.state.preview_url = sandbox.preview_url
        // D2：预览就绪只证明服务可访问，未验证行为——附一行证据边界防「预览绿=可交付」误读
        const evidence = toolEvidenceEnabled() ? '\n（预览就绪仅证明服务可访问；行为断言/ API 契约/安全均未验证。）' : ''
        // W2：成功态也回流最近服务日志（真实服务器下运行期堆栈/路由错误是一手调试证据，
        // 不等失败才可见；静态旧路径日志安静时零增加）
        const tail = getSandboxLogs(projectId).trim().slice(-1200)
        const logSection = tail ? `\n最近服务日志：\n${tail}` : ''
        return { output: `预览已启动：${sandbox.preview_url}${evidence}${logSection}`, detail: { preview_url: sandbox.preview_url } }
      }
      const logs = getSandboxLogs(projectId).slice(-SANDBOX_LOG_TAIL_LIMIT)
      return {
        output:
          `预览启动失败（${sandbox.error_summary?.category ?? 'unknown'}）：` +
          `${sandbox.error_summary?.user_visible_summary ?? '未知原因'}。\n服务器日志尾部：\n${logs || '（无输出）'}`,
        isError: true,
        detail: { category: sandbox.error_summary?.category },
      }
    },
  }

  const run_gwt_tests: AgentLoopTool = {
    name: 'run_gwt_tests',
    description: '执行行为断言测试（GWT 场景），返回通过/失败计数与每个失败场景的原因。需要先 run_preview 拿到可用预览。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再运行测试。', isError: true }
      }
      // R0.1（2026-09-19 狗粮 7601e5ae）：模型侧测试与平台终验同口径——测试前确保
      // dist 是 src 最新构建（防「改完 src 测旧 bundle」的假红反馈回路；非 fullstack no-op）
      await rebuildRealFullstackDist({ projectId, sessionId: ctx.sessionId })
      const result = await runGwtScenarios({ project_id: projectId, session_id: ctx.sessionId, preview_url: ctx.state.preview_url })
      // W2-F4：执行计数无条件更新（终验 source 分类的确定性判据，与展示开关解耦）
      ctx.state.gwt_runs = (ctx.state.gwt_runs ?? 0) + 1
      if (result.failed_count > 0) {
        // 修复预算口径：每次失败运行 = 一个新修复回合（对应旧 test_repair_count +1）
        ctx.state.test_failed = true
        ctx.state.gwt_all_passed = false
        ctx.state.repair_round += 1
        options.onRepairRound?.(ctx.state.repair_round)
        // D3 轻量：对比上轮失败集标 [新增]/[持续]（防重复修同一失败），跑后更新快照。
        // W2-F4：快照更新改无条件（终验 source 分类需要；展示仍由开关控制）。
        const prev = new Set(ctx.state.last_gwt_failures ?? [])
        const failures = result.failure_summary
          .map((failure) => {
            const tag = toolEvidenceEnabled() ? (prev.has(failure.scenario) ? '[持续] ' : '[新增] ') : ''
            return `- ${tag}${failure.scenario}：${failure.reason}`
          })
          .join('\n')
        // W2-F4 修复比较（D4 稿：修 A 挂 B 可见，升级计数不靠模型自己数）：
        // resolved=上轮失败本轮已过 / persistent=两轮都挂 / new=本轮新挂。开关 on 才展示。
        const current = result.failure_summary.map((f) => f.scenario)
        const persistent = current.filter((s) => prev.has(s))
        const fresh = current.filter((s) => !prev.has(s))
        const resolved = [...prev].filter((s) => !current.includes(s))
        const comparison = toolEvidenceEnabled()
          ? `\n较上次：修复 ${resolved.length}${resolved.length > 0 ? `（${resolved.join('、')}）` : ''}｜持续 ${persistent.length}｜新增 ${fresh.length}${fresh.length > 0 ? '（修一处坏一处，先查共享影响）' : ''}`
          : ''
        ctx.state.last_gwt_failures = current
        const evidence = validationStateLine(ctx.state)
        return {
          output: `共 ${result.total_count} 个场景：通过 ${result.passed_count}、失败 ${result.failed_count}。\n失败场景：\n${failures}${comparison}${evidence}`,
          detail: { failed_count: result.failed_count, total_count: result.total_count },
        }
      }
      // 全过显式列出场景名（ACI：空结果显式反馈 + 可核对的通过清单）。
      // M-11：同时清零失败粘性——测试全过后 test_failed/edits_after_test_failure 复位，
      // 否则后续安全修复的 edit 仍计入旧测试失败的预算，连续 2 轮撞限即 budget_exhausted
      // 终止，高危漏洞未修进交付。
      ctx.state.gwt_all_passed = true
      ctx.state.test_failed = false
      ctx.state.edits_after_test_failure = 0
      // W2-F4：快照复位无条件（口径同上轮更新）
      ctx.state.last_gwt_failures = []
      const scenarioNames = planScenarios(readLastSketchRequirements(projectId)).map((scenario) =>
        scenarioName(scenario.item.id, scenario.assertion),
      )
      const nameList = scenarioNames.length > 0 ? `\n通过场景：${scenarioNames.join('、')}` : ''
      // D2：删旧「可以继续…或输出完成总结」收口暗示，换宿主维护的验证状态行
      // （单次 GWT 全绿不等于可交付——API 契约/安全可能未验）。off 分支保留原句（字节级现状）。
      const tail = toolEvidenceEnabled()
        ? validationStateLine(ctx.state)
        : '\n测试通过，可以继续 run_security_scan 或输出完成总结。'
      return {
        output: `全部通过（${result.passed_count}/${result.total_count} 个场景）。${nameList}${tail}`,
        detail: { passed_count: result.passed_count, total_count: result.total_count },
      }
    },
  }

  const run_security_scan: AgentLoopTool = {
    name: 'run_security_scan',
    description: '对项目产物做安全静态扫描。通过时明确说明；发现高危/严重问题时列出 file:line 与修复建议。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      const project = findProject(projectId)
      const result = runSecurityScan({ project_id: projectId, root_path: project.root_path })
      const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
      if (result.passed) {
        ctx.state.security_all_passed = true
        const minor = result.issues.length - blocking.length
        // D2：通过返回附验证状态行（尚缺项由宿主维护）
        const evidence = validationStateLine(ctx.state)
        return {
          output: `安全扫描通过：无高危/严重问题（扫描 ${result.scanned_files} 个文件${minor > 0 ? `，另有 ${minor} 个低/中危提示` : ''}）。${evidence}`,
          detail: { passed: true, scanned_files: result.scanned_files },
        }
      }
      ctx.state.security_all_passed = false
      const listing = blocking.map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n')
      return {
        output: `安全扫描未通过（${blocking.length} 个高危/严重问题，扫描 ${result.scanned_files} 个文件）：\n${listing}\n请修复后重新扫描。`,
        detail: { passed: false, blocking: blocking.length },
      }
    },
  }

  // D1（咨询 D，2026-09-09）：API 契约验证进 loop——复用终验同款 checkApiContract，
  // 不新建判断标准；外部终验仍独立执行（共享实现 ≠ 共享判定权）。仅 BLOMA_API_TOOL=on 注册。
  const run_api_contract_tests: AgentLoopTool = {
    name: 'run_api_contract_tests',
    parallelSafe: true,
    description:
      '验证 PRD 接口契约（interface_spec）声明的后端 API 端点是否存活并应答（无参 GET 端点逐一探测；无参 POST 端点发空 JSON 体探挂载——404=未挂载计失活，400/422=校验拒绝不算失败；GET 5xx/超时=契约失活）。用途：收口前证明前后端契约真实生效；不验证业务逻辑正确性（那属于行为断言）。前置：需先 run_preview。无接口契约的项目返回豁免说明。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再验证 API 契约。', isError: true }
      }
      const endpoints = readPrdBackplane(projectId)?.interface_spec ?? []
      // W2-F4：执行计数（有契约才计；豁免分支不算「验过」）
      if (endpoints.length > 0) ctx.state.api_contract_runs = (ctx.state.api_contract_runs ?? 0) + 1
      if (endpoints.length === 0) {
        ctx.state.api_all_passed = true
        return {
          output: '本项目无接口契约（interface_spec 为空，纯静态产物），API 契约验证豁免通过。',
          detail: { exempt: true, endpoints: 0 },
        }
      }
      const failures = await checkApiContract(ctx.state.preview_url, endpoints)
      ctx.state.api_all_passed = failures.length === 0
      if (failures.length === 0) {
        const listing = endpoints.map((ep) => `- ${ep.method ?? 'GET'} ${ep.endpoint}`).join('\n')
        const evidence = validationStateLine(ctx.state)
        return {
          output: `API 契约验证通过：${endpoints.length} 个声明端点全部应答正常。\n${listing}${evidence}`,
          detail: { passed: true, endpoints: endpoints.length },
        }
      }
      const listing = failures.map((f) => `- API 契约端点：${f.scenario} — ${f.reason}`).join('\n')
      const evidence = validationStateLine(ctx.state)
      // W3：失败输出附预览地址与服务日志尾部（真实服务器下运行期堆栈是一手证据；
      // 修复指引按变体分流——Express 项目指 server.js，旧路径指 server/routes/）
      const fixGuide = realVariant
        ? '请对照 server.js / server/ 下的路由实现修复后重验（Express：app.get/post 注册）。'
        : '请对照 server/routes/ 的路由实现修复后重验。'
      const logTail = getSandboxLogs(projectId).trim().slice(-SANDBOX_LOG_TAIL_LIMIT)
      const logSection = logTail ? `\n服务日志尾部：\n${logTail}` : ''
      return {
        output: `API 契约验证未通过（${failures.length}/${endpoints.length} 个端点失败；预览 ${ctx.state.preview_url}）：\n${listing}\n${fixGuide}${logSection}${evidence}`,
        detail: { passed: false, failed: failures.length, endpoints: endpoints.length, preview_url: ctx.state.preview_url },
      }
    },
  }

  // W3-D1（咨询 D2《验证分层与收口预检》）：收口预检宿主工具——一次调用按依赖顺序跑全部
  // 验证面（GWT 全量 → API 契约（有声明才验）→ 产物 UI 审计 → 安全扫描）。复用终验
  // 同款实现（规则同源、执行独立：终验仍对冻结候选独立取证）；构建门禁不在 v0 预检面
  // （需 skeleton 上下文，终验门禁保留）。收口判定消费 preflight_passed（agent-loop
  // wrapUp）；失败留在 loop 内修（D5）——不退出重建修复卡。仅 BLOMA_PREFLIGHT=on 注册。
  const run_preflight: AgentLoopTool = {
    name: 'run_preflight',
    description:
      '收口预检：一次调用按依赖顺序跑全部验证面（GWT 行为断言全量 → API 契约（声明了才验）→ 产物 UI 审计 → 安全扫描），给出收口判定与逐阶段失败清单。收口（输出完成总结）前必须通过本预检；失败就留在当前循环内修复后重跑，不要带病宣布完成。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再运行收口预检。', isError: true }
      }
      const lines: string[] = []
      let allPassed = true

      // 阶段 1：GWT 全量（与 run_gwt_tests 同源；同步维护修复预算/失败快照口径）
      const gwt = await runGwtScenarios({ project_id: projectId, session_id: ctx.sessionId, preview_url: ctx.state.preview_url })
      ctx.state.gwt_runs = (ctx.state.gwt_runs ?? 0) + 1
      if (gwt.failed_count > 0) {
        ctx.state.test_failed = true
        ctx.state.gwt_all_passed = false
        ctx.state.repair_round += 1
        options.onRepairRound?.(ctx.state.repair_round)
        ctx.state.last_gwt_failures = gwt.failure_summary.map((f) => f.scenario)
        allPassed = false
        lines.push(`① GWT 行为断言：失败（${gwt.failed_count}/${gwt.total_count}）`)
        for (const failure of gwt.failure_summary.slice(0, 10)) lines.push(`  - ${failure.scenario}：${failure.reason}`)
      } else {
        ctx.state.gwt_all_passed = true
        ctx.state.test_failed = false
        ctx.state.edits_after_test_failure = 0
        ctx.state.last_gwt_failures = []
        lines.push(`① GWT 行为断言：通过（${gwt.passed_count}/${gwt.total_count}）`)
      }

      // 阶段 2：API 契约（无声明豁免；同 run_api_contract_tests 口径）
      const endpoints = readPrdBackplane(projectId)?.interface_spec ?? []
      if (endpoints.length === 0) {
        ctx.state.api_all_passed = true
        lines.push('② API 契约：豁免（interface_spec 为空）')
      } else {
        ctx.state.api_contract_runs = (ctx.state.api_contract_runs ?? 0) + 1
        const apiFailures = await checkApiContract(ctx.state.preview_url, endpoints)
        ctx.state.api_all_passed = apiFailures.length === 0
        if (apiFailures.length > 0) {
          allPassed = false
          lines.push(`② API 契约：失败（${apiFailures.length}/${endpoints.length}）`)
          for (const failure of apiFailures) lines.push(`  - ${failure.scenario}：${failure.reason}`)
        } else {
          lines.push(`② API 契约：通过（${endpoints.length} 个端点）`)
        }
      }

      // 阶段 3：产物 UI 审计（L0 探针；探针不可用不判败只留痕——终验 L1 视觉审计仍独立）
      try {
        const gate = await runArtifactUiGate({ previewUrl: ctx.state.preview_url })
        if (gate.failures.length > 0) {
          allPassed = false
          lines.push(`③ 产物 UI 审计：失败（${gate.failures.length}）`)
          for (const failure of gate.failures.slice(0, 10)) lines.push(`  - ${failure.scenario}：${failure.reason}`)
        } else if (gate.status === 'unavailable') {
          lines.push(`③ 产物 UI 审计：未执行（${gate.note ?? '探针失败'}）——终验仍会独立探测`)
        } else {
          lines.push('③ 产物 UI 审计：通过')
        }
      } catch {
        lines.push('③ 产物 UI 审计：未执行（探针异常）——终验仍会独立探测')
      }

      // 阶段 4：安全扫描（静态；同 run_security_scan；W6-D6 按产物指纹缓存复用，终验共享）
      const project = findProject(projectId)
      const cachedSecurity = getCachedStaticEvidence<ReturnType<typeof runSecurityScan>>(projectId, project.root_path, 'security-scan')
      const security = cachedSecurity ?? runSecurityScan({ project_id: projectId, root_path: project.root_path })
      if (!cachedSecurity) setCachedStaticEvidence(projectId, project.root_path, 'security-scan', security)
      ctx.state.security_all_passed = security.passed
      if (!security.passed) {
        allPassed = false
        lines.push(`④ 安全扫描：失败（${security.issues.length} 处命中）`)
        for (const issue of security.issues.slice(0, 10)) lines.push(`  - ${issue.severity} ${issue.file}:${issue.line}——${issue.user_visible_summary}`)
      } else {
        lines.push('④ 安全扫描：通过')
      }

      ctx.state.preflight_passed = allPassed
      const verdict = allPassed
        ? '收口预检通过：全部验证面通过，可以输出完成总结（外部终验仍会独立复核）。'
        : '收口预检未通过：留在当前循环内修复上述失败，修复后重新 run_preflight；不要带病宣布完成。'
      return {
        output: `【收口预检】\n${lines.join('\n')}\n${verdict}`,
        detail: { preflight_passed: allPassed, gwt_failed: gwt.failed_count, security_passed: security.passed },
      }
    },
  }

  // W4-F3（咨询 D4）：修复控制窄入口——判别联合四字段，宿主裁决（确定性规则，零 LLM）。
  // 「已申请≠已授权」：request_scope_expansion 返回 approved 才算扩权；受保护路径与
  // 全项目申请一律拒。仅修复轮传入 writeScope 时注册（主 loop 无此工具，面最小化）。
  const repair_control: AgentLoopTool = {
    name: 'repair_control',
    description:
      '修复控制窄入口（仅修复轮）：①action=request_scope_expansion——根因在授权外文件时申请扩大修改授权（必填 issue_id/requested_paths/reason/change_intent；申请绑定具体失败与文件，不能申请全项目可写）；②action=report_blocker——证据缺失/环境异常/授权不足时如实报告受阻。已申请≠已授权，以返回的裁决为准。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['request_scope_expansion', 'report_blocker'] },
        issue_id: { type: 'string', description: '关联失败场景/断言 id（request_scope_expansion 必填）' },
        requested_paths: { type: 'array', items: { type: 'string' }, description: '申请扩大的项目内相对路径（request_scope_expansion 必填）' },
        reason: { type: 'string', description: '根因证据：为什么根因在这些文件（request_scope_expansion 必填）' },
        change_intent: { type: 'string', description: '改动意图：打算怎么改（request_scope_expansion 必填）' },
        blocker_reason: { type: 'string', description: 'report_blocker：受阻原因' },
        evidence: { type: 'string', description: 'report_blocker：证据引用（日志/断言原文/请求记录）' },
      },
      required: ['action'],
    },
    execute: async (toolInput) => {
      const scope = options.writeScope!
      const now = new Date().toISOString()
      if (toolInput.action === 'request_scope_expansion') {
        const issueId = typeof toolInput.issue_id === 'string' ? toolInput.issue_id : ''
        const reason = typeof toolInput.reason === 'string' ? toolInput.reason : ''
        const intent = typeof toolInput.change_intent === 'string' ? toolInput.change_intent : ''
        const paths = Array.isArray(toolInput.requested_paths) ? toolInput.requested_paths.filter((p): p is string => typeof p === 'string') : []
        if (!issueId || !reason || !intent || paths.length === 0) {
          return { output: '申请缺少必填字段（issue_id/requested_paths/reason/change_intent），补齐后重新申请。', isError: true }
        }
        // 裁决规则（D4 §三）：普通实现文件→自动批准；受保护/全项目/超量→拒
        if (paths.length > 8 || paths.some((p) => p.includes('*'))) {
          scope.expansions.push({ issue_id: issueId, paths, reason, at: now, decision: 'denied', note: 'wildcard-or-over-quota' })
          return { output: '拒绝：不能申请全项目可写（含通配符或单次超过 8 个路径）。申请必须绑定具体失败与具体文件。', isError: true }
        }
        const normalized = paths.map((p) => p.replace(/\\/g, '/'))
        const protectedHit = normalized.filter((p) => scope.protectedPaths.has(p))
        if (protectedHit.length > 0) {
          scope.expansions.push({ issue_id: issueId, paths: normalized, reason, at: now, decision: 'denied', note: 'protected-path' })
          return { output: `拒绝：${protectedHit.join('、')} 是受保护文件（权威契约/宿主产物），不因修复需求开放修改。若失败源于它们，请 report_blocker 说明。`, isError: true }
        }
        for (const p of normalized) scope.authorized.add(p)
        scope.expansions.push({ issue_id: issueId, paths: normalized, reason, at: now, decision: 'approved' })
        return {
          output:
            `已批准：${normalized.join('、')} 加入本轮修改授权（issue=${issueId}）。` +
            '继续前先 read_file 核对现状与文件版本；修复完成后必须完整重验（run_gwt_tests 或 run_preflight），不得凭旧证据交差。',
        }
      }
      if (toolInput.action === 'report_blocker') {
        const blockerReason = typeof toolInput.blocker_reason === 'string' ? toolInput.blocker_reason : ''
        if (!blockerReason) return { output: 'report_blocker 缺少 blocker_reason。', isError: true }
        const evidence = typeof toolInput.evidence === 'string' ? toolInput.evidence : undefined
        scope.blockers.push({ reason: blockerReason, ...(evidence ? { evidence } : {}), at: now })
        return {
          output:
            '受阻已记录（原因/证据进宿主账本，升级或让渡由宿主决定）。建议：①证据缺失先做区分性检查（能区分两种候选根因的那种）；' +
            '②测试环境异常如实标注，不硬判产品缺陷；③需要独立定位可 delegate_agent(role=research 只读) 诊断。',
        }
      }
      return { output: `未知 action：${String(toolInput.action)}。`, isError: true }
    },
  }

  // D1：API 契约验证工具按开关注册（off=工具面与现状字节级一致）
  const apiTools = loopApiToolEnabled() ? [run_api_contract_tests] : []
  // W3-D1：收口预检按开关注册（主/实现角色；审查角色不收口不注入）
  const preflightTools = preflightEnabled() ? [run_preflight] : []
  // W4-F3：修复控制窄入口——仅修复轮传入 writeScope 时注册（主 loop 无此工具）
  const repairControlTools = options.writeScope ? [repair_control] : []
  // W1（Phase 10，预览浏览器工具族）：仅主 loop 注册（BLOMA_BROWSER_TOOLS 缺省 off）
  const browserTools = browserToolsEnabled() ? buildPreviewBrowserTools(projectId) : []

  if (role === 'explore' || role === 'research') {
    // 只读角色：领域验证/预览工具不注入（探索/调研只读+ask）
    return []
  }
  if (role === 'review') {
    // 审查角色：可跑预览/测试/扫描验证怀疑点，但不改产物（apiTools 供契约核查；无 preflight/repairControl）
    return [run_preview, run_gwt_tests, run_security_scan, ...apiTools]
  }
  if (role !== 'parent') {
    // 子 agent（implement/custom）：领域验证面 + 收口预检；无 repairControl（无 writeScope）
    return [run_preview, run_gwt_tests, run_security_scan, ...apiTools, ...preflightTools]
  }
  // parent：全领域面 + 修复控制窄入口 + 预览浏览器工具族
  return [run_preview, run_gwt_tests, run_security_scan, ...apiTools, ...preflightTools, ...repairControlTools, ...browserTools]
}

/** 调用方便利（PR4c 行为保持）：补全变体判定与产物落盘地图刷新——等价于拆分前 buildAgentTools 内部的直连行为。 */
export function domainToolOptionsDefaults(projectId: string): Pick<BuildAgentToolsOptions, 'realFullstackVariant' | 'onProjectFilesChanged'> {
  let workspaceSlug: string | undefined
  let rootPath: string | undefined
  try {
    const project = findProject(projectId)
    workspaceSlug = project.workspace_slug
    rootPath = project.root_path
  } catch {
    /* 项目索引缺失：变体 false + 不刷新，与旧路径行为一致 */
  }
  let realFullstackVariant = false
  if (rootPath) {
    try {
      realFullstackVariant = readRealScaffoldVariant(rootPath) !== null
    } catch {
      realFullstackVariant = false
    }
  }
  return {
    realFullstackVariant,
    onProjectFilesChanged: workspaceSlug
      ? (root) => {
          try {
            scheduleProjectMapRefresh(workspaceSlug as string, projectId, root)
          } catch {
            /* 静默：地图刷新失败不影响写盘 */
          }
        }
      : undefined,
  }
}
