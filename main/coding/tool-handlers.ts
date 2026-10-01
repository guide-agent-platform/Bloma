/**
 * 领域工具面 composition（PR4c 注入反转）：run_preview / run_gwt_tests / run_security_scan /
 * run_api_contract_tests / run_preflight / repair_control 与预览浏览器工具族。
 * 工具 schema 与实现自 agent/tools 迁出——agent 运行时零领域知识，领域能力在本层（orchestration→domain 合法向）装配。
 * 调用方拼接：[...buildAgentTools(o), ...buildDomainTools(o)]（角色裁剪两边各自持半）。
 */
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { hasProjectRootOverride } from '../../shared/project-root-override'
import { preflightEnabled, toolEvidenceEnabled } from '../agent/loop/agent-loop'
import type { BuildAgentToolsOptions } from '../agent/tools/agent-tools'
import { validationStateLine, SANDBOX_LOG_TAIL_LIMIT } from '../agent/tools/agent-tools'
import { findProject, readLastSketchRequirements } from '../project/project-service'
import { readPrdBackplane } from '../project/document-engine'
import { runSandbox, getSandboxLogs } from '../delivery/sandbox'
import { rebuildRealFullstackDist } from './dist-rebuild'
import { checkApiContract } from './api-contract'
import { runArtifactUiGate } from './artifact-ui-gate'
import { isPlaceholderAssertion } from './sketch-engine'
import { runSecurityScan } from '../verification/security-scan'
import { browserToolsEnabled, buildPreviewBrowserTools } from './preview-browser'
import { readRealScaffoldVariant } from './preview-runtime'
import { scheduleProjectMapRefresh } from '../project/project-map'

export function buildDomainTools(options: BuildAgentToolsOptions): AgentLoopTool[] {
  const { projectId } = options
  // P1-06 收尾：worktree 隔离模式（子会话根被覆盖）下不提供领域验证工具——预览/GWT/
  // 安全/契约/预检都绑「项目根」，在隔离工作树上跑会得到与主目录不一致的结论（假验证）；
  // 审计口径：验证绑定同一稳定候选版本——隔离实现的验证统一由父会话在合并后执行。
  if (hasProjectRootOverride()) return []
  // 与 buildAgentTools 同款缺省：role 未传 = parent（否则 undefined 落进子分支，parent 专属工具族丢失）
  const role = options.role ?? 'parent'
  // PR4c：变体判定由调用方注入（与 buildAgentTools 的 realFullstackVariant 同源）
  const realVariant = options.realFullstackVariant ?? false


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
  const apiTools = [run_api_contract_tests]
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
    return [run_security_scan, ...apiTools]
  }
  if (role !== 'parent') {
    // 子 agent（implement/custom）：领域验证面 + 收口预检；无 repairControl（无 writeScope）
    return [run_security_scan, ...apiTools]
  }
  // parent：全领域面 + 修复控制窄入口 + 预览浏览器工具族
  return [run_security_scan, ...apiTools, ...repairControlTools, ...browserTools]
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
