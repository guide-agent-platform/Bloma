/**
 * loop 提示词构建（PR3b 拆出）：系统提示词（骨架锚定+覆盖链）、任务构建、PRD 检查点同步、UX 契约登记。
 * 纯机械搬移（零行为变化）；对外契约经 programming-orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentLoopJudgeMetadata, AgentSendMessageInput, Channel, ChannelModel, DocumentSyncResult, MessageContentBlock, Project, ProjectMode, Snapshot, SnapshotKind, TemplateType } from '../../../shared/types'
import type { ThinkingLevel } from '../../../shared/reasoning-profile'
import { getAgentSessionPath, getDocumentsDir } from '../../../storage/config-paths'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { emitAgentEvent } from '../../platform/events/agent-event-bus'
import { appendLoopLogDocument, loopLogEnabled, readLoopCheckpointDocument, readPrdBackplane, readUxContractSketch, renamePrdProject, syncDocuments, updateRequirementStatus, writeLoopCheckpointDocument, writeSecurityScanDocument, type LoopLogEntry, type LoopRepairAttemptRecord, writePlanDocument } from '../../project/document-engine'
import { appendProjectLearning } from '../../project/learnings-log'
import { runSandbox } from '../../delivery/sandbox'
import { createSnapshot } from '../../delivery/snapshots'
import { trackAnalytics } from '../../delivery/track-analytics'
import { renderPackageJson, renderStaticServer, renderSkeletonToProject, scaffoldEnabled } from '../project-scaffold'
import { runBuildGate, type BuildGateResult } from '../build-gate'
import { rebuildRealFullstackDist } from '../dist-rebuild'
import { runArtifactUiGate, uiGateEnabled, uiProbeNotes, type ArtifactUiGateResult } from '../artifact-ui-gate'
import { getCachedStaticEvidence, setCachedStaticEvidence } from '../../verification/evidence-cache'
import { runVisionAuditGate } from '../vision-audit-gate'
import { buildRepairTasks, resolveRepairBudget, runRepairLoop, repairScopeEnabled, repairNoopGuardEnabled, hasWriteEditToolCall, type RepairCheckpointContext, type RepairTask } from '../repair-loop'
import { buildIterationTask, ITERATION_MODE_SECTION, iterationBriefEnabled, resolveAgentLoopMaxTurnsLocal } from '../iteration-brief'
import { appendContextPack, buildContextPack } from '../context-pack'
import { buildChangeContractBlock, changeContractEnabled, deriveChangeContract, roundAnchorFromChangeContract } from '../change-contract'
import { buildRuleInjectionMap, deriveCapabilitiesFromBackplane, recordRuleActionObserved } from '../../experience/rule-injection'
import { appendExperienceEvent } from '../../experience/event-log'
import { recordFailureCards } from '../../experience/error-card'
import { generateLoopPlan, planLegEnabled, renderPlanInjection, renderPlanMarkdown, renderTaskChecklist, type LoopPlan } from '../../agent/loop/loop-planner'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { appendProjectMapToSystem, loadProjectMapBlock } from '../../project/project-map'
import { resolveChannelEnv } from '../../platform/llm/runtime-fallback'
import { loadRealScaffoldTemplate, loadSkeletonTemplate, realScaffoldEnabled, REAL_SCAFFOLD_TYPES, type ProjectSkeleton } from '../../project/project-templates'
import { readRealScaffoldVariant, writeRealScaffoldMarker } from '../preview-runtime'
import { buildLoopInjection, buildSkeletonMapInjection } from '../../agent/prompting/template-injection'
import { buildModuleMapInjection, loadOfficialModules, modulesEnabled, renderOfficialModulesToProject } from '../module-library'
import { listRefPatternModules, refLibraryEnabled } from '../../experience/ref-source'
import { backplaneInterfaceSpec, buildIterationRoundAnchor, buildRepairRoundAnchor, focusAnchorEnabled, gameDeriveExemptEnabled, renderBackplaneAnchor, renderRoundAnchorBlock, roundAnchorEnabled } from '../../model/prd-backplane'
import { gwtGameProbeEnabled } from '../../verification/gwt-runner'
import { renderRulesSection, rulesForTemplateType, rulesRegistryEnabled } from '../../agent/prompting/rules-registry'
import { renderExpressionSection } from '../../agent/prompting/prompt-expression'
import { captureConstraints, extractConstraints, readProjectConstraints, sanitizeConstraints } from '../../guide/constraint-extractor'
import { generateSketch, backplaneKeyTasks, requirementAssertions, requirementPriority, requirementStatusLabel, requirementStory, type GenerateSketchResult, type PrdBackplane, type SketchRequirement } from '../sketch-engine'
import { generateSketchLlm, SketchLlmError, type SketchAttemptDetail } from '../sketch-engine-llm'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../../guide/requirement-normalizer'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtFailureSummary, type GwtTestResult } from '../../verification/gwt-service'
import { renderSecurityScanMarkdown, runSecurityScan } from '../../verification/security-scan'
import { runJudge, readArtifactText, type JudgeVerdict } from '../../review/judge-engine'
import { runSemanticJudgeReview } from '../../review/judge-semantic'
import { loadPromptOverride } from '../../agent/prompting/prompt-config'
import { assertToolAllowed } from '../../agent/permissions/permission-service'
import { recordDecision } from '../../project/decision-log'
import { commitProjectState } from '../project-git'
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from '../../project/recovery-service'
import { readPrimaryIntent, recordSessionActivity } from '../../platform/sessions/session-service'
import { runAgentLoop, loopApiToolEnabled, loopCheckpointEnabled, preflightEnabled, narrationEventsEnabled, loopProgressNudgeEnabled, taskWorkflowEnabled, compactToolEnabled, type AgentLoopResult, type LoopCheckpointSnapshot } from '../../agent/loop/agent-loop'
import { browserToolsEnabled } from '../preview-browser'
import { deliveryStatusEnabled, recordDeliveryStatus, buildDeliveryPresentation, renderCircuitFailureNote, renderDeliveryBody, featureIdFromScenario } from '../delivery-status'
import { isDegenerateText } from '../output-integrity'
import { checkApiContract } from '../api-contract'
import { apiReconcileEnabled, checkMediaSourceDiscipline, reconcileApiUsage } from '../api-reconcile'
import { checkDataMigrationDiscipline, dataMigrateContractSection, dataMigrateEnabled, runMigrationDrill, type MigrationDrillResult } from '../data-migration'
import { buildAgentTools } from '../../agent/tools/agent-tools'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from '../../agent/delegation/agent-collaboration'
import { categoryTemperature, resolveGenerationMaxTokens } from '../../platform/llm/model-resolution'
import type { SDKQuery, ToolDefinition } from '../../orchestration/orchestrator'
import { resolvePrdBackplane } from '../../guide/pipeline'

// R3 迁移过渡：resolvePrdBackplane 已迁 guide/pipeline（向导群·PRD 收敛管线），
// 此处 re-export 保持既有调用方/测试 import 路径零改动（R4 群目录归位后统一收口）。
export { resolvePrdBackplane }

import { MvpTaskInput } from './sketch-task'
import { runMvpTask } from './generate'

/**
 * 背板锚定系统提示词（方案 §4.4 骨架）：PRD 背板全文常驻每轮（AutoGPT 式漂移的
 * 解药，本项目区别于 SWE-agent/Codex 的差异化锚），工作方式与终止判据显式化。
 * focus（P3 分级锚定）：未传=全量现状；传入时命中项全文、其余项一行摘要（只减细节不减锚）。
 */
export function buildAgentLoopSystemPrompt(backplane: PrdBackplane, editFormat: 'diff' | 'whole', templateType?: import('../../../shared/types').TemplateType, skeletonMap?: string | null, focus?: string[], moduleMap?: string | null, realFullstack?: boolean): string {
  // 注入点⑥（周计划 §6）：tech_skeleton/目录约定/依赖白名单进背板锚定段；
  // 开关关闭/模板缺失为 null（行为=现状）。类型缺省从背板 template_meta 兜底。
  const effectiveType = templateType ?? backplane.template_meta?.type ?? 'personal_tool'
  const loopInjection = (() => {
    try {
      return buildLoopInjection(effectiveType, skeletonMap)
    } catch {
      return null
    }
  })()
  // P3 分级锚定：功能项渲染归模型层（renderBackplaneAnchor，R1 口径）；
  // focus 缺省=全量全文（与旧内联渲染逐字同源）
  const items = renderBackplaneAnchor(backplane, focus)
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  // R0.4：背板 constraints 消费端兑底清洗（存量项目如 7601e5ae 仍带宿主注入残留）
  const constraints = sanitizeConstraints(backplane.constraints).length
    ? sanitizeConstraints(backplane.constraints).map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  const arr = [
    '你是 Bloma 编程 Agent，用提供的工具亲手构建并验证一个可运行的应用。',
    '',
    '【项目锚（每轮有效，一切决策不得漂移出此范围）】',
    `产品定位：${backplane.positioning}`,
    // 2026-09-03 长文本 PRD 常驻锚（需求工程链归向导）：全文注入，细节以其为准；
    // 与下方功能项/断言冲突时以下方硬契约为准（GWT/裁判以结构化字段为唯一判定口径）。
    // 旧背板无此字段时零注入（兼容）。
    ...(backplane.prd_document
      ? [
          'PRD 全文（用户确认版）：',
          '"""',
          backplane.prd_document,
          '"""',
        ]
      : []),
    // P1-7（2026-09-04）：game 类型 GDD（玩法真相源）常驻注入——机制拆解/核心循环/数值基准，
    // 编程 Agent 不凭对话臆造机制；非 game 缺省零注入。
    ...(backplane.gdd
      ? [
          '玩法设计文档（GDD，机制真相源）：',
          `- 核心幻想：${backplane.gdd.core_fantasy}`,
          `- 设计支柱：${backplane.gdd.pillars.join('；')}`,
          `- 核心循环：${backplane.gdd.core_loop.join(' → ')}`,
          `- 数值基准：${backplane.gdd.numbers.length ? backplane.gdd.numbers.join('；') : '（无）'}`,
        ]
      : []),
    // C4（2026-09-11 拍板）：游戏探针通道契约——位移类断言经 window.__g 读游戏状态判定
    //（canvas 无 DOM 位移可探）；不实现通道则位移断言无法判定。开关 off 零注入。
    ...(gwtGameProbeEnabled() && backplane.gdd
      ? [
          '【游戏探针通道】（终验位移断言依赖，必须实现）：在游戏入口挂 window.__g 只读通道：' +
            '__g.mode 返回当前游戏阶段字符串（\'menu\'|\'playing\'|\'paused\'|\'gameover\' 等小写）；' +
            '__g.state() 返回玩家状态快照（含 x/y 数字坐标——顶层 {x,y} 或 player 子对象均可，canvas 内坐标）。' +
            '终验「按键→位移」断言会真实派发按键并经此通道读取坐标变化判定；只读暴露游戏内部状态，不含任何测试投机逻辑。' +
            '游戏初始停在菜单态时终验会自动点开始类按钮进入 playing。',
        ]
      : []),
    '功能项（P0 必须全部实现且断言为真）：',
    // P3 分级锚定提示行（仅 focus 生效时存在）：其余项断言细节已折叠但探针仍全量验证，
    // 防止「折叠=可以不做」的误读（P0 执行面不裁，D3+硬约束 4）
    ...(focus && focus.length > 0
      ? [`（本轮迭代聚焦：${focus.join('、')}——其余功能项保持现状勿重做；其断言细节已折叠，但 run_gwt_tests 仍会全量验证全部 P0 断言）`]
      : []),
    items,
    '范围外（一律不做）：',
    outOfScope,
    '用户约束：',
    constraints,
    '',
    loopInjection ?? '',
    // 官方模块库地图（2026-09-04）：独立于骨架地图注入（模块地图不影响【产物形态】判断；
    // 事实与注入同源——只有模块实际物化成功才非 null）
    ...(moduleMap ? ['', moduleMap] : []),
    '',
    // 【交付纪律】（2026-09-25 自由度批·搬 Proma-Easy ENGINEERING_CODING_GUIDE 九条验收纪律，
    // 目录结构适配本仓：08_APP/→项目根、engineering.json→背板/技术合同；同 AGPL-3.0 同源
    // 衍生互搬。这是「什么算真交付」的边界——怎么干（读什么/怎么组织/先做什么）由你自主。
    '【交付纪律】以下九条是交付边界（怎么达成由你自主决定）：',
    '1. 依据 PRD 背板与技术合同实现真实工程，禁止为方便预览把产品降为网页模拟（非 Web 形态产品尤其如此）。',
    '2. 产物按技术合同规划落盘；完成总结如实列出未验证项——不把未验证说成已验证。',
    '3. 只有架构/品类明确是静态网页时才用纯 HTML/JS 与本地存储；后端、构建、桌面壳按需求实际实现，不默认限制为 index.html。',
    '4. 草图只是视觉/交互参考，不是所有产品的运行或验收主体。',
    '5. HTML UI 的可交互元素保留 data-ai-id 标记（点选纠错依赖）。',
    '6. 所有工程文件写入项目目录内，不触碰其他项目或工作区配置；不将密钥放进交付产物或浏览器代码。',
    '7. 验证绑定实际被测产物——不写固定通过的结果，不修改验证工具来掩盖应用缺陷。',
    '8. 构建、分层测试和真实用户故事验证依照架构执行；环境安装、权限变化和外部发送须真人确认。',
    '9. 缺少执行能力时明确说明阻塞，不把人工读代码记为实测通过——需求形态超出当前品类能力（如网页项目被要求桌面部署），如实上报矛盾而不是硬凑变通。',
    '',
    '【工作方式】（2026-09-25 自由度批二：流水线顺序表述改工具清单式——实现顺序、节奏、先做什么由你按工程判断自主决定；下方只是可用验证工具与收口要求）',
    '可用验证工具：run_preview（确认可运行）/ run_gwt_tests（对照行为断言）/ read_file+grep（定位）——' +
    '验证时机与顺序由你决定；收口前须达到 ' +
    // D1（咨询 D，2026-09-09）：开关 on 时验证链补 API 契约（数据留存/接口类项目收口前必验）；
    // W3-D1/D2：BLOMA_PREFLIGHT on 时验证链收口为 run_preflight 一次跑全部验证面；off 保留原文（字节级现状）。
    (preflightEnabled()
      ? 'run_preflight 收口预检（一次跑全部验证面：GWT 全量/API 契约/产物审计/安全）。'
      : loopApiToolEnabled()
        ? 'run_api_contract_tests 验证接口契约（声明了 interface_spec 的项目）→ run_security_scan 确认无高危。'
        : 'run_security_scan 确认无高危。'),
    // P5 先读再改纪律（2026-09-04）：防凭记忆/凭 plan 推断文件现状（文件可能已被
    // 修复轮或上一迭代修改）；MVP 首跑无副作用（新文件不触发）；与 P3 plan 合同
    // 不冲突（plan 是参考，read 是事实）。
    // Phase 3 B2（2026-09-09）：开关 on 时本内联行让位给 rules-registry R-FILE-01
    // （四段式完整定义单点化，防双源）；off 保留原文（字节级现状）。
    ...(rulesRegistryEnabled()
      ? []
      : [
          '- 修改已存在于骨架或前轮产物中的文件前，先用 read_file 读该文件当前内容再编辑；' +
          '禁止凭记忆或凭 plan 推断文件现状（文件可能已被修复轮或上一迭代修改）。',
        ]),
    editFormat === 'diff'
      ? '编辑用 edit_file 的 diff 模式（old_string 必须与当前文件逐字一致且唯一）。'
      : '编辑用 edit_file 的 whole 模式（提供修改后的完整文件内容）。',
    // Phase 3 B2：操作契约注册表段（触发—必须—禁止替代—受阻四段式，R-* 单点定义）。
    ...(rulesRegistryEnabled() ? ['', renderRulesSection(rulesForTemplateType(templateType))] : []),
    '',
    // W1.4【媒体纪律】（Phase 9，2026-09-12，B 站播放器案 214397c3）：媒体能力四条硬边界。
    // 无开关直接上（纯提示词层，与术语纪律同级别；静态对账/探针层另有兜底）。
    '【媒体纪律】涉及音视频播放/录音时：' +
    '①禁止按文件扩展名宣称播放支持（mkv/avi 等容器 Chromium 不支持）——支持列表必须基于 video.canPlayType() 实测或只承诺 mp4/webm 等已验证组合，格式不符给明确提示；' +
    '②本地文件播放用 URL.createObjectURL 生成 blob: 源（CSP 已放行 media-src blob:）；' +
    '③外部音视频流（B站/YouTube 等第三方）必须经 server/routes/ 同源代理转发，禁止 video.src/audio.src 直连外链——CSP 只放同源，且第三方 CDN 有 Referer 防盗链，直连必败；' +
    '④分离流（DASH 的 m4s 等音视频分片）不能直接给 <video> src——要么后端代理选单一流（mp4/flv 直链），要么明确说明需 MSE 不在 MVP 范围。',
    '',
    // D1：开关 on 时终止条件升级为全验证面（GWT+API 契约+安全）；off 保留原文。
    // W3-D2：BLOMA_PREFLIGHT on 时收口条件=预检通过（GWT/API/产物审计/安全一次过）。
    (preflightEnabled()
      ? '【终止条件】run_preflight 收口预检全部通过（GWT 全量 + API 契约（声明了 interface_spec 的项目）+ 产物审计 + 安全扫描），才输出完成总结（含做了什么、'
      : loopApiToolEnabled()
        ? '【终止条件】全部 P0 断言通过 + API 契约验证通过（声明了 interface_spec 的项目必须 run_api_contract_tests 全过；未声明则豁免）+ 安全扫描无高危，才输出完成总结（含做了什么、'
        : '【终止条件】全部 P0 断言通过 + 安全扫描无高危，才输出完成总结（含做了什么、'),
    '未解决的低优先级项）。若技术合同规划了多文件，收口前确认目标文件已覆盖（未写的文件须在旁白说明偏离原因）。' +
    '测试未全绿不得声称完成。',
    '',
    // W5-G1（咨询 D5）：开关 on 时旁白改事件驱动五类事件版（普通工具链不逐轮播报；同构开头限制随文案
    // 移除——G2 的 A/B 对照即本开关）；off 保留原文四条（字节级现状）。
    ...(narrationEventsEnabled()
      ? [
          '【表达纪律】',
          '- 旁白与完成总结一律用中文（与任务语言一致；代码、标识符与文件内容不限语言）。',
          '- 旁白按事件发生，不逐轮播报：仅在 ①开始明显新阶段 ②影响下一步的重要发现 ③阻塞/需授权/需用户决策 ④长操作进行中说明进展 ⑤交付或失败交接 时输出；表达「已知状态＋下一动作」（如「已定位到过滤谓词；接下来改边界条件」），不写「我将仔细分析并全面修复」式空话。',
          '- 普通 grep→read→edit 连续执行不逐步播报；关键决策点（架构选择、偏离技术合同、修复策略切换）可用 1–2 句说明为什么这么做。',
          '- 不把计划/工具成功/局部测试通过说成交付完成；不编造验证结果；受阻时明确原因与恢复路径。',
        ]
      : [
          '【表达纪律】',
          '- 每轮工具调用前用一句中文旁白说明意图；关键决策点（架构选择、偏离技术合同、测试失败后的修复策略）可用 1–2 句说明「为什么这么做」；不向用户展示冗长推理过程或自我怀疑（思考与推演放在思考通道，不进旁白）。',
          '- 旁白开头不要千篇一律：「现在/继续/接下来/先」这类同构开头连续不得超过两轮，换成自然的说法（读完了什么、发现了什么、为什么这么改）。',
        ]),
    '- 测试失败先读工具返回的失败详情再行动，不要在旁白里长篇分析或复述整段代码。',
    '- 完成总结用中文、400 字以内、自然分段（不要一行流水的清单腔）：做了什么、实际效果、哪些断言未通过、遗留哪些低优先级项。代码与文件内容不限语言。',
    '',
    // P5 术语纪律（2026-09-04）：agent 间统一术语表（与裁判/Defender 同源词表，
    // 措辞按角色微调）——防多 agent 协作中的同义漂移（VibeGame glossary 借鉴）
    '【术语纪律】与其他 agent 和用户交流时使用以下规范词，禁止同义漂移（不得混用右侧同义词）：' +
    '功能项（非"需求点/feature"）、断言（非"验收点"）、场景（非"用例/test case"）、' +
    '探针（非"测试脚本/自动化测试"）、骨架（非"模板项目/脚手架"）、背板（非"PRD 文档/需求文档"）、' +
    '修复轮（非"重试/返工"）。首次向用户提及时可带一句白话解释，之后一致使用规范词。',
    '',
    '【护栏】路径限项目目录内；不 eval/Function；不写 CSP meta；前端不直接外联（CSP 仅放行同源 fetch，真实出网只能走同源 /api/llm 代理）；' +
    // 完整程序阶段 2.5（2026-09-06 计算器案）：数据留存被 localStorage 绕过——「刷新后仍在」
    // 被模型当作 localStorage 的正当理由。硬条款锁死后端持久化，堵住合理化路径。
    // Phase 3 B2：开关 on 时本内联条款让位给 rules-registry R-DATA-01（防双源）；off 保留原文。
    // C1b（2026-09-11 拍板）：game 豁免开启时轻留存允许 localStorage（重数据仍后端）。
    (rulesRegistryEnabled()
      ? ''
      : templateType === 'game' && gameDeriveExemptEnabled()
        ? '数据留存按量级分流：街机游戏轻留存（最高分/最佳成绩等单值数据）可用 localStorage；重业务数据（用户内容/多记录管理）仍须后端持久化 server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录；'
        : '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）一律用后端持久化：server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录，' +
          '禁止 localStorage/sessionStorage 存业务数据——PRD 说「刷新后仍在」不构成 localStorage 例外的理由，后端持久化同样满足且必须用后者；') +
    'out_of_scope 内的功能一律不做；编辑校验失败的错误信息要读完再改。',
    '',
    // W1（Phase 10，2026-09-16，同步 Proma Browser工具族）：预览视觉检查契约。
    // 仅 BLOMA_BROWSER_TOOLS=on 时注入（工具同步注册）；off 时零注入字节级现状。
    ...(browserToolsEnabled()
      ? [
          '【预览视觉检查】preview_* 浏览器工具可驱动真实渲染的产物页面（同源限制，仅预览源）：',
          '- UI 类修复优先「改前 preview_observe 看结构 → 改后 preview_navigate+preview_observe/preview_click 验证」，不要只凭 GWT 文本断言下结论；',
          '- 点击/输入类行为用 preview_click/preview_fill 实际走一遍（带 wait_for 等动态渲染），配套 preview_extract 取业务结果；',
          '- 页面报错优先看工具返回里的「最近控制台错误」；截图 preview_screenshot 仅存档用，文本证据优先 observe/extract；',
          '- 预览地址由 run_preview 提供；外部资源不可访问（须走 server/routes 同源代理，与 CSP 口径一致）；',
          '- 浏览器证据与 GWT 断言互补不互替：收口仍以验证面（GWT/安全/契约）为准。',
        ]
      : []),
    // W2（Phase 10，同步 Proma CompactContext）：显式压缩契约。仅 BLOMA_COMPACT_TOOL=on 时注入。
    ...(compactToolEnabled()
      ? [
          '',
          '【上下文压缩】完成一个大阶段（如某功能项全绿）或察觉历史过长时，可调用 compact_context 主动交接收缩窗口（保留近期原文与未闭环失败）；' +
            '调用后本轮结束生效，无需重复调用；未完成阶段不要滥用（交接有损）。',
        ]
      : []),
    '',
    // 产物形态（PR-2 条件化）：工程骨架（带构建门禁）→ 模块化解禁（import 可选，
    // 构建期打包校验）；无骨架 → 维持 PR-1 前现状（单文件静态产物，不用 ESM）
    skeletonMap
      ? '【产物形态】入口 index.html，交互逻辑入口 src/app.js，样式 src/styles.css；' +
        '模块化优先：按技术合同的目标文件拆分为 src/ 下多个 .js 文件用 import 组织（loop 结束后构建门禁' +
        '会打包校验模块图，import 路径错误会在构建期暴露）；仅当功能极简单、单文件已足够时才可合并，且须在旁白说明合并原因。' +
        '预览沙箱直接加载源码，前端禁止直连外网。'
      : '【产物形态】入口 index.html，纯前端静态产物（平台用静态服务器托管，无构建步骤）；' +
        '交互逻辑放 src/app.js，样式放 src/styles.css；不使用 import/ESM 模块语法。',
    // 完整程序渠道（2026-09-06 随记灵案：AI 功能被写成前端模拟，用户要的是真的）——
    // 平台在沙箱注入 BLOMA_APP_LLM_*，产物经同源 /api/llm 代理调用真实模型
    '【AI 能力接入】产品需要 AI/模型能力时必须走真实调用，禁止在前端写死模拟回复冒充 AI：' +
    "fetch('/api/llm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ messages: [{role:'user', content: 用户输入}], temperature: 0.7, max_tokens: 1024 }) })" +
    '→ 成功 200 {content: \"模型回复文本\"}；失败 非200 {error: \"...\"}（llm_not_configured=预览环境未注入模型，须有失败态）。',
    'AI 功能硬性要求：①messages 只用 user/assistant 角色；②必须实现 加载中/失败/空结果 三种界面状态，失败提示要具体；' +
    '③严禁把密钥、API 端点、模型名写进任何项目文件（平台已注入服务器进程，前端不可见）；' +
    '④页面 URL 带 mock=1 参数时，所有 /api/llm 调用自动附加 mock:true（URL 带 mock=fail 时附加 mock:\"fail\"）——平台探针与失败态自测走此通道，返回确定性应答；' +
    '⑤AI 功能的行为断言只断言界面形态（点击后出现结果区/失败提示），不断言模型输出的具体内容。',
    // 完整程序阶段 1（2026-09-06 用户拍板：终点是前后端分离的完整程序，静态单页只是里程碑）。
    // 交接面治理（2026-09-18 21:55 狗粮实锤）：本段是旧注入式路径的 CJS 挂载约定，
    // real-fullstack 项目与背板锚 Express 口径同时注入会两套约定打架（狗粮里模型确实
    // 按旧约定自建了挂载器）。分支：real-fullstack 换 Express 口径；旧路径/real-static
    // 保持原文字节不变（real-static 无留存功能，本段不触发）。
    ...(realFullstack
      ? [
          '【前后端分离·Express】凡涉及数据留存或服务端能力的功能，后端优先——禁止把 localStorage 当唯一数据源：',
          "①后端路由：在 server.js（或其 require 的 server/ 模块）用 Express 标准写法注册：app.get('/api/xxx', async (req, res) => {...})、app.post(...)；骨架 server.js 已是完整入口，不要自建挂载约定；",
          '②数据持久化用 server/db.js 的 readData(name, fallback) / writeData(name, value)（JSON 落 data/ 目录，重启不丢，原子写）；响应 res.json(obj)；请求体 req.body、查询 req.query；',
          "③前端：fetch('/api/...') 调后端，处理加载/失败态；数据持久化职责在后端 data/，前端不留权威副本；",
          '④路由内禁止出网（外部 fetch）与 require 项目目录外的模块；外部模型能力走 /api/llm（server/llm-proxy.js 已预置）；',
          '⑤后端数据的断言写「新增项出现/状态变化」，禁止写「总数等于 N」这类依赖历史状态的断言（探针重复执行会累积数据）。',
        ]
      : [
          '【前后端分离】凡涉及数据留存或服务端能力的功能，后端优先——禁止把 localStorage 当唯一数据源：',
          '①后端路由：server/routes/<资源>.js 导出 { "GET /路径": handler, "POST /路径": handler }——文件名即路由前缀（notes.js → /api/notes/*），平台启动时自动挂载，无需注册；',
          '②handler 写 async (req, res, ctx)；ctx 提供 readData(name, fallback) / writeData(name, value)（JSON 持久化到 data/ 目录，重启不丢，原子写）、sendJson(res, code, obj)、query、body、params；',
          "③前端：fetch('/api/...') 调后端，处理加载/失败态；数据持久化职责在后端 data/，前端不留权威副本；",
          '④路由内禁止出网（外部 fetch）与 require 项目目录外的模块；外部模型能力走 /api/llm；',
          '⑤后端数据的断言写「新增项出现/状态变化」，禁止写「总数等于 N」这类依赖历史状态的断言（探针重复执行会累积数据）。',
        ]),
  ]
  const base = arr.join('\n')
  // Phase 3 B5（2026-09-09）：表达适配层 append-only 注入（off=字节级现状；只改表达
  // 不改验收口径，契约层构件字节永不受本层影响——回归锁锁定 append-only）。
  const expression = renderExpressionSection()
  // Phase 10 W1-5：【数据迁移纪律】段（BLOMA_DATA_MIGRATE off='' 零注入字节级）
  const dataMigrate = dataMigrateContractSection()
  const withExpression = expression ? `${base}\n\n${expression}` : base
  return dataMigrate ? `${withExpression}\n\n${dataMigrate}` : withExpression
}

/**
 * 背板锚定系统提示词 + 用户追加规则（D4 追加模式）：`loop-system` 覆盖文件内容追加在
 * 动态 system prompt 之后（背板锚定段不可覆盖）。无覆盖文件返回 base 本身。
 * focus（P3 分级锚定）：未传=全量现状（字节级等价，回归锁锁定）；修复轮不传（修复卡即 mini-plan）。
 */
export function buildLoopSystemWithOverride(backplane: PrdBackplane, editFormat: 'diff' | 'whole', projectId?: string, skeletonMap?: string | null, focus?: string[], moduleMap?: string | null): string {
  // 交接面治理（2026-09-18）：按产物变体标记分支【前后端分离】段口径（real-fullstack
  // 与背板锚 Express 口径同源；无标记/旧路径=null 走原文，字节级不变）
  let realFullstack = false
  if (projectId) {
    try {
      realFullstack = readRealScaffoldVariant(findProject(projectId).root_path) === 'real-fullstack'
    } catch {
      realFullstack = false
    }
  }
  const base = buildAgentLoopSystemPrompt(backplane, editFormat, undefined, skeletonMap, focus, moduleMap, realFullstack)
  // 历史经验段已于 2026-09-12 迁出 system prompt（记忆栈审计裁定 §5，D0）：改由 agent-loop
  // 任务头注入 <untrusted-memory source="learnings">——system 是**常驻指令面**，而记忆是模型
  // 输出派生（可能受用户贴的第三方内容影响），不应享有指令面权重。
  // 迁移路径：待 §11 统一出口契约 renderMemory() 落地后接管（本处为临时补丁）。
  const override = loadPromptOverride('loop-system')
  // project-map（Graft 模式，r69）：代码结构语义地图注入 system 尾部——定位代码优先按锚点
  // read_file，避免每轮 grep 漫游（冷会话重探索问题）；地图缺失/项目读取失败静默不注入。
  const withOverride = [base, override ? `【用户自定义规则】\n${override}` : ''].filter(Boolean).join('\n\n')
  if (!projectId) return withOverride
  try {
    const project = findProject(projectId)
    return appendProjectMapToSystem(withOverride, loadProjectMapBlock(projectId, project.workspace_slug))
  } catch {
    return withOverride
  }
}

/** 初始 user 消息：任务指令（背板细节在 system，这里只给行动指令）。 */
export function buildAgentLoopTask(backplane: PrdBackplane, mode: ProjectMode, input?: MvpTaskInput): string {
  // W5-4（Phase 8.5，2026-09-12 狗粮 dd6ba98d）：任务清单工作法升级——逐项推进/
  // 定位后读/即验证/不重写（对齐正常 agent 工作流）；开关关或缺省关=字节级现状全量任务书
  if (input && taskWorkflowEnabled()) {
    return [
      `目标：实现「${backplane.name}」的可运行 MVP（${mode === 'quick' ? '快速模式' : '长期模式'}）。`,
      '按系统提示里的实施清单逐项推进：每项先定位（grep / 地图锚点 → read 只读命中段），再实现，',
      '有验证手段时立即验证（run_preview 可随时拉起）；完成一项勾选进入下一项。',
      '禁止先全读再全写；已完成项不重读、不重写，微调用 edit_file。',
      '收尾：run_gwt_tests 全部 P0 断言通过 + run_security_scan 无高危后输出完成总结（说明各项完成情况）。',
    ].join('\n')
  }
  return [
    `目标：实现「${backplane.name}」的可运行 MVP（${mode === 'quick' ? '快速模式' : '长期模式'}）。`,
    '按系统提示里的项目锚逐功能项实现，用工具自测（run_preview + run_gwt_tests + run_security_scan），' +
      '全部 P0 断言通过且无高危后输出完成总结。',
  ].join('\n')
}

/**
 * 在 sketch_confirmed / mvp_before_generation 两个检查点写 PRD 文档（PRD §7.1「从对话提取」）。
 *
 * 优先用 LLM 从对话历史提取 PRD 背板（定位/验收/范围外/假设），失败/无渠道回退
 * `buildPrdBackplane` 确定性模板。功能项始终使用已冻结清单（F-001 主题锚点不变式）。
 */
export async function syncPrdCheckpoints(input: MvpTaskInput, requirements: SketchRequirement[]): Promise<void> {
  const backplane = registerUxContract(input, await resolvePrdBackplane(input, requirements))
  syncDocuments(
    { request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'sketch_confirmed' },
    backplane,
  )
  syncDocuments(
    { request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_before_generation' },
    { ...backplane, frozen_at: new Date().toISOString() },
  )
}

/**
 * UX 契约登记（§4.2 草图升格为 UX 契约）：仅在 sketch_confirmed 检查点执行。
 *
 * 质量门 = ①用户确认（runMvpTask 只在 confirmSketch accepted 后进入，检查点本身即确认）
 * + ②非模板回退（project.sketch_source === 'llm'）。通过 → 把当前草图（磁盘 index.html，
 * 此刻 MVP 尚未生成、仍是草图本体）复制进 documents 冻结为 sketch.html 契约；未通过 →
 * ux_contract 为空，MVP 退回 PRD-only（模板草图不承载用户确认的视觉意图）。
 *
 * 刷新判定：草图重新生成（sketch_generated_at 更新）且 LLM 产物 → 重新登记覆盖旧契约；
 * 草图未再生成（迭代重跑 runMvpTask）→ 沿用既有契约（此时磁盘 index.html 已是 MVP，
 * 不能当草图复制）；新一轮草图是模板回退 → 契约作废（质量门未过）。
 */
export function registerUxContract(input: MvpTaskInput, backplane: PrdBackplane): PrdBackplane {
  const project = findProject(input.project_id)
  // 输出契约由本函数显式决定：先剥离入参携带的旧契约（入参可能是读盘背板），
  // 再按质量门判定登记/沿用/作废，消除对「入参必须是新鲜背板」的隐含假设
  const { ux_contract: _staleFromInput, ...fresh } = backplane
  const previous = readPrdBackplane(input.project_id).ux_contract
  const generatedAt = project.sketch_generated_at

  if (previous && generatedAt && new Date(previous.confirmed_at) >= new Date(generatedAt)) {
    return { ...fresh, ux_contract: previous }
  }
  if (project.sketch_source === 'llm') {
    const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    const sketchAbsolute = join(project.root_path, 'index.html')
    if (existsSync(sketchAbsolute)) {
      mkdirSync(documentsDir, { recursive: true })
      copyFileSync(sketchAbsolute, join(documentsDir, UX_CONTRACT_SKETCH_FILE))
      return {
        ...fresh,
        ux_contract: { sketch_rel_path: UX_CONTRACT_SKETCH_FILE, confirmed_at: new Date().toISOString() },
      }
    }
  }
  return fresh
}

/** UX 契约草图在 documents 目录下的固定文件名。 */
export const UX_CONTRACT_SKETCH_FILE = 'sketch.html'

