/**
 * 形状模板数据表（批9 工件2，2026-10-07）。
 *
 * 设计拍板（计划 bloma-batch9 决策速查表）：形状模板是**纯数据不是骨架**——骨架 v2
 * 保持唯一，模板只承载「必备状态集/规则分级/必备测试/禁实现/UI 拼装指引」，由
 * dispatcher-prompt 渲染进任务书（{{shape_brief}} 占位符，本模块 renderShapeBrief
 * 按项目 shape 拼接——任务书模板不内联全文，防 dispatcher-phases 膨胀）。
 *
 * 规则五分类（分级语义见 mvp-confirm 形状段/verify 教学消费）：
 * - invariant：平台硬门，用户不可取消（长任务不阻塞 UI/破坏性操作有保护/启动即崩拦）；
 * - conditional：条件命中即硬门（求值器 evalShapeCondition 按 shape 字段确定性求值）；
 * - default：任务书要求+软观测（PRD 用户契约可覆盖；未采用项进报告形状段）；
 * - forbidden：禁实现（硬门）；
 * - PRD 用户契约（确认即硬门）不在本表——它在背板 acceptance 里。
 *
 * 组合测试（拍板：首期不做组合编译器）：组合场景清单降维为 composition_notes 数据，
 * 进 verify 场景教学由驱动/探索执行；组合编译器挂账能力包 v2。
 *
 * 纯数据+纯函数零 I/O（对齐 dispatcher-phases 风格）；消费面：dispatcher-prompt
 * （implement/verify 任务书注入）、mvp-confirm（报告形状段）、scaffold 场景教学。
 */

import type { ProductShape, ShapeHostTemplate } from '../model/prd-backplane'

// =========================================================================
// Schema
// =========================================================================

/** 规则分级（invariant/conditional=default 之外的硬门；default 软观测）。 */
export type ShapeRuleKind = 'invariant' | 'conditional' | 'default' | 'forbidden'

/** 形状模板规则。conditional 必填 condition（表校验强制）；test_clause 是 verify 侧断言口径。 */
export interface ShapeRule {
  kind: ShapeRuleKind
  /** 条件表达式（仅 conditional；求值语法见 evalShapeCondition）。 */
  condition?: string
  /** 规则正文（任务书语言）。 */
  requirement: string
  /** 断言口径（进 verify 场景教学；缺省取 requirement）。 */
  test_clause?: string
}

/** 形状模板（首批四模板；data_workspace 等五个后续模板挂账批10+）。 */
export interface ShapeTemplate {
  id: ShapeHostTemplate
  title: string
  /** 适用场景（进 arch/scaffold 提示）。 */
  fits: string[]
  /** 排除+分流（「需长期筛选编辑数据→data_workspace 二期」）。 */
  excludes: string[]
  /** 必备状态集（UX 九态子集；与 prd-backplane UxStateId 同源）。 */
  states: string[]
  rules: ShapeRule[]
  /** 必备测试清单（进 verify 场景映射教学——子会话登记场景时对齐）。 */
  required_tests: string[]
  /** 组合场景清单（降维数据，进 verify 场景教学）。 */
  composition_notes: string[]
  /** PATTERNS.md 拼装指引（引用现有组件，不新造）。 */
  ui_pattern: string
}

// =========================================================================
// 阶段表数据
// =========================================================================

export const SHAPE_TEMPLATES: Record<ShapeHostTemplate, ShapeTemplate> = {
  instant_utility: {
    id: 'instant_utility',
    title: '即时工具（输入→结果→复制）',
    fits: ['单次输入→计算/转换/生成→立即看结果', '用完即走，结果复制或重置是自然出口', '无数据留存主循环'],
    excludes: ['需要历史记录/多次输入累积 → record_manager', '批量文件处理 → file_pipeline'],
    states: ['empty', 'ready_input', 'failed', 'success'],
    rules: [
      { kind: 'invariant', requirement: '输入必须先校验再处理：空输入/非法输入给行内错误提示，不产出错误结果', test_clause: '空输入触发校验拒绝（不进入计算路径）；非法输入显示行内错误' },
      { kind: 'invariant', requirement: '结果可复制（或等价导出）且可重置（清空再来一次）——两个出口都必须真实可用', test_clause: '产出结果后复制得到结果内容；重置后回到待输入态' },
      { kind: 'conditional', condition: 'task_duration != instant', requirement: '执行超过 1 秒的处理必须有进度反馈且不阻塞 UI（Python 侧线程+evaluate_js 推送）' },
      { kind: 'default', requirement: '记忆上次输入值（重开时回填），用户无需重复输入常用参数（PRD 可覆盖）' },
      { kind: 'forbidden', requirement: '禁无输入路径的纯展示实现（页面只显示固定示例结果、无真实输入→计算链路）' },
      { kind: 'forbidden', requirement: '禁未校验直接输出「看似正确」的结果（NaN/空串拼接成结果文本）' },
    ],
    required_tests: [
      '空输入：校验拒绝且不产出结果',
      '非法输入：行内错误+不清空已填内容',
      '正常输入：结果立即可见且内容正确',
      '结果出口：复制可用/重置回到待输入',
    ],
    composition_notes: ['一次贴多行批量处理：逐行处理+部分成功清单（若成为主要形态应在 PRD 判 file_pipeline）'],
    ui_pattern: '表单字段（行内校验）+ 结果摘要 w-summary（给结果数字/文本）+ 徽章按钮（复制/重置）；参考 PATTERNS.md「表单字段」「结果摘要」',
  },
  record_manager: {
    id: 'record_manager',
    title: '记录管理（表单+列表+留存）',
    fits: ['表单录入+列表查看的记录型应用（通讯录/记账/健身记录）', '编辑/删除已有记录', '数据关掉重开不丢'],
    excludes: ['长期筛选/透视/跨表分析为主 → data_workspace（二期，本期不做，需求如实进 out_of_scope）', '批量文件处理 → file_pipeline'],
    states: ['empty', 'ready_input', 'success', 'failed'],
    rules: [
      { kind: 'invariant', requirement: '新增/编辑/删除后列表与留存同步——行为口径「关掉重新打开数据仍在」必须真实成立', test_clause: '新增一条记录后读取列表可见；重新初始化后记录仍在' },
      { kind: 'invariant', requirement: '必填/类型校验失败不落盘：行内提示错误、保留已填内容，不弹窗不静默清空', test_clause: '空必填字段提交→提示错误且记录数不变' },
      { kind: 'invariant', requirement: '删除等破坏性操作必须有确认步骤（destructive_ops 非空时逐项兑现）', test_clause: '触发删除先出确认；取消确认后记录仍在' },
      { kind: 'conditional', condition: 'task_duration != instant', requirement: '保存类操作超过 1 秒须进度反馈且不阻塞 UI' },
      { kind: 'default', requirement: '重复记录给明确提示（允许覆盖保存或拒绝，按 PRD 口径；缺省拒绝并高亮重复项）' },
      { kind: 'default', requirement: '表单有未保存修改时关闭/切换给确认（防静默丢弃）' },
      { kind: 'forbidden', requirement: '禁静默丢弃未保存修改（关闭即丢失用户已填内容且无提示）' },
      { kind: 'forbidden', requirement: '禁无确认的不可逆删除（删除即消失、无任何确认步骤）' },
    ],
    required_tests: [
      '新增一条记录：列表立即可见',
      '编辑记录：修改后列表与留存同步',
      '删除记录：确认后移除',
      '空必填字段：拒绝保存+行内提示',
      '重复记录：按 PRD 口径提示或拒绝',
      '保存反馈：成功给数量（如「已保存 3 条」）',
      '重启读取：重新打开后记录仍在（持久化真实成立）',
      '未保存关闭：有确认或保留（不静默丢弃）',
    ],
    composition_notes: ['导入导出+备份恢复：导出后可再导入还原（同格式往返一致）', '含自动定时任务时看 job_runner 组合规则（本期挂账，不做自动触发）'],
    ui_pattern: '表单字段（行内校验）+ App.renderList（空态自动）+ 结果摘要（计数）；参考 PATTERNS.md「列表」「表单字段」',
  },
  file_pipeline: {
    id: 'file_pipeline',
    title: '文件管线（批量处理→逐个产出）',
    fits: ['选一批文件→批量转换/改名/处理→逐个产出', '部分成功是常态（个别文件失败不废整批）', '输出到明确目录'],
    excludes: ['单文件即时预览转换 → instant_utility', '文件夹自动监听触发 → 本期不做（挂账），首期手动选择'],
    states: ['empty', 'running', 'partial', 'success', 'failed'],
    rules: [
      { kind: 'invariant', requirement: '破坏性操作（覆盖原文件等 destructive_ops 项）必须先确认或先备份，二者至少其一', test_clause: 'destructive_ops 非空时：触发覆盖类操作前出现确认或自动备份' },
      { kind: 'invariant', requirement: '部分成功逐文件报告：成功 X/失败 Y+每个失败的原因，不因单文件失败中断整批（PRD 声明 fail-fast 除外）', test_clause: '混入一个坏文件：整批处理完，成功/失败分别计数且失败带原因' },
      { kind: 'invariant', requirement: '输出位置明确可见（用户能找到产出在哪：界面展示路径或结果清单）' },
      { kind: 'conditional', condition: 'task_duration != instant', requirement: '批量处理必须有进度反馈（已完成/总数）且不阻塞 UI（线程+evaluate_js 推送）' },
      { kind: 'default', requirement: '同名输出冲突策略明确（跳过/覆盖/加后缀，按 PRD；缺省加后缀不动原文件）' },
      { kind: 'forbidden', requirement: '禁无备份/无确认直接覆盖原文件' },
      { kind: 'forbidden', requirement: '禁失败后留下半截损坏输出且不提示（写出前先完整处理，失败清残骸）' },
    ],
    required_tests: [
      '空选择：拒绝开始+提示',
      '正常批：逐个处理产出且输出位置可见',
      '混入坏文件：部分成功分别计数+失败原因',
      '（覆盖类）原文件保护：确认或备份先行',
    ],
    composition_notes: ['重复事件不重复处理（同名幂等）', '处理中关闭窗口：完成任务或安全中止，不留半截状态', '失败后重跑：已成功项不重复处理', '输出已存在：冲突策略生效（不静默覆盖）'],
    ui_pattern: '文件选择行+进度徽章（running+已完成/总数）+结果摘要 w-summary（成功/跳过计数）；参考 PATTERNS.md「表单字段」「结果摘要」',
  },
  job_runner: {
    id: 'job_runner',
    title: '任务执行器（长任务监控）',
    fits: ['发起长任务→监控进度→完成/失败管理（下载/渲染/批量执行）', '任务分钟级运行，用户期间做别的', '完成/失败都要有交代'],
    excludes: ['秒级操作 → instant_utility', '任务本体是文件批处理 → file_pipeline（job_runner 规则仍适用于其执行语义）'],
    states: ['ready_input', 'running', 'success', 'failed'],
    rules: [
      { kind: 'invariant', requirement: '执行中状态可见（进度或活动指示）且 UI 可响应（不阻塞主线程）', test_clause: '任务运行期间读取状态为执行中；UI 动作可完成' },
      { kind: 'invariant', requirement: '完成与失败都有明确终态反馈：成功给结果位置/数量，失败给原因与下一步' },
      { kind: 'invariant', requirement: '异常退出后数据可解释：重新打开能看到上次任务的状态/产物，不静默丢失' },
      { kind: 'conditional', condition: 'job_policy.cancellable == true', requirement: '执行中可取消且取消生效：状态转入已取消、无残留半截任务', test_clause: '执行中触发取消→状态变为已取消且后续无结果落盘' },
      { kind: 'conditional', condition: 'job_policy.cancellable == false', requirement: '关闭窗口按 close_policy 执行（等待完成或确认告知），不静默杀任务不告知' },
      { kind: 'conditional', condition: 'task_duration == long_running', requirement: '长任务必须有进度反馈（阶段/百分比/计数至少其一）' },
      { kind: 'default', requirement: '失败后可重试（一键重跑失败任务，不重做已成功部分）' },
      { kind: 'default', requirement: '任务参数记忆（重开时回填上次配置）' },
      { kind: 'forbidden', requirement: '禁假取消（取消按钮存在但任务照跑/状态永不变化）' },
      { kind: 'forbidden', requirement: '禁失败后假装成功（任务失败但界面显示完成）' },
    ],
    required_tests: [
      '发起任务：执行中状态可见',
      '任务完成：终态反馈+结果可定位',
      '任务失败：失败反馈+原因与下一步',
      '（cancellable=true）取消生效：状态转入已取消',
      '（close_policy）处理中关闭：按策略等待或确认',
    ],
    composition_notes: ['任务队列（多任务并行/排队）本期不做——单任务串行为主（挂账）'],
    ui_pattern: '发起表单+进度徽章（running）+终态结果摘要 w-summary；取消按钮复用 w-btn--ghost/危险形态；参考 PATTERNS.md「表单字段」「结果摘要」',
  },
}

/** 模板标题速查（标签渲染用；与 requirement-digest SHAPE_HOST_LABELS 语义一致但更短）。 */
export const SHAPE_TEMPLATE_LABELS: Record<ShapeHostTemplate, string> = {
  instant_utility: '即时工具型',
  record_manager: '记录管理型',
  file_pipeline: '文件批处理型',
  job_runner: '长任务执行型',
}

// =========================================================================
// 条件求值（纯；语法白名单：字段 ==/!= 字面量）
// =========================================================================

/**
 * 条件表达式确定性求值（conditional 规则命中判定）。
 * 支持语法（白名单，求值失败=不命中——保守）：
 *   task_duration == instant|short|long_running
 *   task_duration != instant|short|long_running
 *   job_policy.cancellable == true|false
 *   llm_role != none / == none|core|optional|preview|user_config
 *   destructive_ops != empty
 */
export function evalShapeCondition(condition: string, shape: ProductShape): boolean {
  const match = condition.match(/^(\w+(?:\.\w+)?)\s*(==|!=)\s*(\w+)$/)
  if (!match) return false
  const [, field, op, literal] = match
  let actual: string
  if (field === 'task_duration') actual = shape.task_duration
  else if (field === 'llm_role') actual = shape.llm_role
  else if (field === 'job_policy.cancellable') actual = String(shape.job_policy.cancellable)
  else if (field === 'destructive_ops') actual = shape.destructive_ops.length > 0 ? 'nonempty' : 'empty'
  else return false
  if (literal === 'true' || literal === 'false') {
    return op === '==' ? actual === literal : actual !== literal
  }
  if (field === 'destructive_ops') {
    // literal 应为 empty（白名单外保守不命中）
    return op === '!=' ? actual === 'nonempty' : actual === literal
  }
  return op === '==' ? actual === literal : actual !== literal
}

// =========================================================================
// 渲染（任务书注入位；数据拼接，任务书模板不内联全文）
// =========================================================================

/** 规则分级标签（渲染用）。 */
const RULE_KIND_LABELS: Record<ShapeRuleKind, string> = {
  invariant: '硬门（不可省，用户不可取消）',
  conditional: '条件硬门（条件命中即必须满足）',
  default: '缺省做法（PRD 已明确口径时以其为准；未采用须在 DELIVERY.md 注明依据）',
  forbidden: '禁实现（出现即拒收）',
}

/**
 * 渲染形状纪律段（implement/scaffold 任务书 {{shape_brief}} 注入位）。
 * conditional 规则按 shape 求值——未命中的不渲染（如 cancellable=false 时不要求取消态）；
 * llm_role≠none 时追加 LLM 交付语义一行（Provider Qualification 与分层断言口径）。
 * shape 缺省返回 undefined（无形状增强——任务书不注入，行为等同批8）。
 */
export function renderShapeBrief(shape: ProductShape | undefined): string | undefined {
  if (!shape) return undefined
  const template = SHAPE_TEMPLATES[shape.host_template]
  const lines = [`【形状纪律（${SHAPE_TEMPLATE_LABELS[shape.host_template]}——按形状模板注入，PRD 冻结字段）】`]
  lines.push(`主循环：${shape.primary_loop}；事实来源：${shape.fact_source}`)
  if (shape.destructive_ops.length > 0) {
    lines.push(`破坏性操作清单：${shape.destructive_ops.join('；')}（对应规则必须逐项兑现）`)
  }
  for (const rule of template.rules) {
    if (rule.kind === 'conditional') {
      if (!rule.condition || !evalShapeCondition(rule.condition, shape)) continue
      lines.push(`- [条件硬门·${rule.condition}] ${rule.requirement}`)
    } else {
      lines.push(`- [${RULE_KIND_LABELS[rule.kind]}] ${rule.requirement}`)
    }
  }
  lines.push(`UI 拼装：${template.ui_pattern}`)
  if (shape.llm_role !== 'none') {
    const llmLine: Record<ProductShape['llm_role'], string> = {
      core: 'AI 角色为 core：真模型调用是产品成立条件——实现须真实调用可配置的 LLM 端点（禁模板假实现），平台会用自有渠道对请求 schema 做真实验证（Provider Qualification）；产出项目根 llm-provider.json 声明（{"schema_version":1,"provider":"openai_compatible","base_url":"（用户配置）","model":"（用户配置）","request_sample":{"messages":[{"role":"user","content":"你好"}]},"auth":"user_config"}——request_sample.messages 写你实际请求的 messages 结构）；本地测试走 mock 模式（LLM_PROVIDER=mock 切固定响应），断言分层：请求合法性/错误处理严格断言，生成内容断言质量指标。',
      optional: 'AI 角色为 optional：AI 功能可降级——无 key 或调用失败时核心功能可用，降级如实标注（不假装 AI 可用）；产出项目根 llm-provider.json 声明（request_sample.messages 写你实际请求的 messages 结构，供平台真实验证）。',
      preview: 'AI 角色为 preview：生成内容仅预览示意——界面如实标注「预览」，不冒充完整能力；产出项目根 llm-provider.json 声明（同上）。',
      user_config: 'AI 角色为 user_config：交付时用户自配 key——必须实现待配置态（unconfigured）：无 key 时显示引导界面（说明文案+设置入口，ui/PATTERNS.md「待配置态」样例），配置后功能可用；密钥只存本地不进产物代码/文档；产出项目根 llm-provider.json 声明（request_sample.messages 写你实际请求的 messages 结构，供平台真实验证）。',
      none: '',
    }
    lines.push(llmLine[shape.llm_role])
  }
  return lines.join('\n')
}

/**
 * 渲染 verify 形状教学段（{{shape_verify_brief}} 注入位）：必备测试清单（场景映射对齐）+
 * 组合场景教学 + llm_role≠none 时的分层断言教学。
 * shape 缺省返回 undefined。
 */
export function renderShapeVerifyBrief(shape: ProductShape | undefined): string | undefined {
  if (!shape) return undefined
  const template = SHAPE_TEMPLATES[shape.host_template]
  const lines = [`【形状验收教学（${SHAPE_TEMPLATE_LABELS[shape.host_template]}——场景登记对齐清单）】`]
  lines.push('本形状必备测试（contract.json 场景映射时逐项对齐，缺项按覆盖缺口拒收）：')
  for (const test of template.required_tests) {
    const applicable = test.startsWith('（') ? evalParenthesizedCondition(test, shape) : true
    if (applicable) lines.push(`- ${stripParenPrefix(test)}`)
  }
  if (template.composition_notes.length > 0) {
    lines.push('组合场景教学（按需登记为额外场景，探索子会话会对照）：')
    for (const note of template.composition_notes) lines.push(`- ${note}`)
  }
  if (shape.llm_role !== 'none') {
    lines.push(
      'LLM 分层断言（llm_role≠none 时验收口径）：确定性层严格断言（请求 schema/错误码映射/状态转换——同串断言）；生成层断言质量指标而非精确文本（关键词覆盖/长度范围/结构 schema——固定阈值可判定）。禁止「输出包含某词即通过」的单薄断言，也禁止要求生成内容逐字等于样例（真模型随机性是预期行为，逐字断言=逼实现方造假）。',
    )
  }
  return lines.join('\n')
}

/** required_tests 前缀条件求值（「（cancellable=true）」式前缀；无前缀恒适用）。 */
function evalParenthesizedCondition(test: string, shape: ProductShape): boolean {
  const match = test.match(/^（([^）]+)）/)
  if (!match) return true
  const inner = match[1]
  if (inner.includes('cancellable=true')) return shape.job_policy.cancellable === true
  if (inner.includes('close_policy')) return true // close_policy 恒适用（策略值不同文案同适用）
  return true
}

/** 去掉前缀条件括号（渲染为可读清单行）。 */
function stripParenPrefix(test: string): string {
  return test.replace(/^（[^）]+）/, '').trim()
}

/**
 * 形状规则采用面（mvp-confirm/狗粮报告「形状段」数据源）：模板 default 规则全量
 * 返回（「未采用项+依据」由报告侧对照产物/DELIVERY 呈现——首期不做自动检测，
 * 如实呈现模板要求与交付声明）。
 */
export function listShapeDefaults(hostTemplate: ShapeHostTemplate): ShapeRule[] {
  return SHAPE_TEMPLATES[hostTemplate].rules.filter((rule) => rule.kind === 'default')
}

// =========================================================================
// 表完整性校验（纯；测试锁定——对齐 validateDesktopPhaseTable 风格）
// =========================================================================

/** 表校验结果：violations 为空即通过。 */
export interface ShapeTemplateValidation {
  valid: boolean
  violations: string[]
}

/**
 * 形状模板表完整性校验：
 * - 四模板键集齐全（Record 键=四白名单）；
 * - conditional 规则必须带 condition 且求值语法合法（白名单字段）；
 * - invariant/forbidden/default 不得带 condition；
 * - required_tests 非空；states 引用九态白名单；
 * - 每模板至少一条 invariant 与一条 forbidden（形状纪律的最小骨架）。
 */
export function validateShapeTemplateTable(
  templates: Record<string, ShapeTemplate> = SHAPE_TEMPLATES,
): ShapeTemplateValidation {
  const violations: string[] = []
  const expected = ['instant_utility', 'record_manager', 'file_pipeline', 'job_runner']
  const keys = Object.keys(templates)
  for (const id of expected) {
    if (!keys.includes(id)) violations.push(`coverage: 缺模板 ${id}`)
  }
  const uxStates = new Set(['empty', 'ready_input', 'validating', 'running', 'success', 'partial', 'failed', 'cancelled', 'unconfigured'])
  const conditionFields = /^(\w+(?:\.\w+)?)\s*(==|!=)\s*(\w+)$/
  for (const id of keys) {
    const template = templates[id]
    if (!template) continue
    if (template.id !== id) violations.push(`self: 模板 ${id} 的 id 字段为 ${template.id}`)
    let hasInvariant = false
    let hasForbidden = false
    for (const rule of template.rules) {
      if (!rule.requirement.trim()) violations.push(`rule: 模板 ${id} 存在空 requirement`)
      if (rule.kind === 'conditional') {
        if (!rule.condition || !conditionFields.test(rule.condition)) {
          violations.push(`rule: 模板 ${id} conditional 规则缺 condition 或语法非法：「${rule.condition ?? ''}」`)
        }
      } else if (rule.condition) {
        violations.push(`rule: 模板 ${id} 的 ${rule.kind} 规则不应带 condition`)
      }
      if (rule.kind === 'invariant') hasInvariant = true
      if (rule.kind === 'forbidden') hasForbidden = true
    }
    if (!hasInvariant) violations.push(`rule: 模板 ${id} 无 invariant 规则`)
    if (!hasForbidden) violations.push(`rule: 模板 ${id} 无 forbidden 规则`)
    if (template.required_tests.length === 0) violations.push(`tests: 模板 ${id} required_tests 为空`)
    for (const state of template.states) {
      if (!uxStates.has(state)) violations.push(`states: 模板 ${id} 状态 ${state} 不在九态白名单`)
    }
  }
  return { valid: violations.length === 0, violations }
}
