/**
 * 桌面品类调度员阶段表（批次 A 地基，2026-09-24）。
 *
 * 依据《Bloma-桌面品类迁移实施稿-20260924》第二/三节：桌面线采用调度员模式——
 * 阶段序列定义为**数据**（本文件），调度员 loop 按表推进，阶段内微决策由模型自主。
 * 本模块只含 schema、阶段表数据与纯查询函数，零 I/O、零 agent 运行时依赖；
 * web 线（13 阶段管线）不消费本表，整体由 BLOMA_DESKTOP_DISPATCH 开关控制（缺省 off）。
 *
 * AGPL 边界：借鉴的是阶段定义数据化的结构思想；schema、任务书文案、产物路径全部自写。
 *
 * 架构验证点（实施稿第五节验收 3）：新增/修改一个阶段只改本文件的阶段表数据，
 * 零代码改动——由 validateDesktopPhaseTable 保证插入节点后链完整性仍成立，
 * tests/unit/desktop/dispatcher-phases.test.ts 的「插入打包自检阶段」用例即演示项。
 */

import { MINIMAL_CONTRACT_EXAMPLE } from './contract-schema'

// =========================================================================
// Schema
// =========================================================================

/**
 * 桌面品类内置阶段标识（kebab-case；进入推进标记 PHASE_ADVANCE:<id>）。
 * 注意：这只是内置阶段的字面量提示，不是封闭枚举——PhaseNode.id 是开放 string，
 * 插入新阶段（如验收演示的 desktop-package）只加数据不改类型，这是
 * 「零代码改动」验证点的根基。
 */
export type DesktopPhaseId =
  | 'requirements'
  | 'desktop-arch'
  | 'desktop-scaffold'
  | 'desktop-implement'
  | 'desktop-verify'
  | 'delivered'

/**
 * 阶段门禁声明——推进三关之「关3 产物验证」的数据源。
 * kind 语义分批兑现：批次 A 实现 artifact（产物存在性检查）；批次 C 实现 driver
 * （工程契约驱动执行，pytest/unittest 子进程断言读回）；manual 表示用户确认门
 * （由裁决边界 IPC 决策卡收口，不属于本模块校验范围，仅作提示词渲染）。
 */
export interface PhaseGate {
  /** 门禁标识（kebab-case；进拒收教育文案与事件流 detail）。 */
  id: string
  /**
   * 门禁 kind。刀1（2026-10-02 确认协议重设计）后：manual 门已从内置阶段表全部
   * 撤除（中间阶段零人工确认，门禁全绿自动推进）——kind 保留 'manual' 枚举仅供
   * 未来不可逆动作类门禁复用（schema 开放；表校验/提示词渲染路径均已兼容）。
   */
  kind: 'artifact' | 'driver' | 'manual'
  /** 门禁描述（进提示词与拒收教育文案）。 */
  description: string
  /**
   * 产物相对路径（相对项目沙箱根，posix 风格；kind=artifact 时必填）。
   * 支持 {{project_name}} 占位符，由消费方渲染；driver/manual 门禁不使用。
   */
  artifacts?: string[]
}

/**
 * 阶段节点——调度员模式的最小完整阶段定义。
 * 设计取舍（对照竞品 PhaseNode 后自定）：
 * - 不含 channel/model：渠道选择是调度员的阶段内微决策（C1 委派渠道参数），
 *   阶段表只锁「做什么/产出什么/门禁是什么」，不锁「用哪个模型做」；
 * - next 为单值：桌面线阶段序列线性（唯一合法推进目标），不支持分叉——
 *   分叉需求出现时再扩 schema，当前唯一性是关2（目标唯一性校验）的根基；
 * - extraTools 白名单扩展只增不减基础面，且不得包含写文件族（表校验强制）。
 */
export interface PhaseNode {
  /** 阶段标识（开放 string，约定 kebab-case；内置集合见 DesktopPhaseId）。 */
  id: string
  /** 阶段角色（提示词人设 + 委派 role 提示）。 */
  role: string
  /** 用户可见标题（决策卡 / 进度展示）。 */
  title: string
  /** 任务书模板（{{project_name}} 等占位符由 dispatcher-prompt 渲染）。 */
  taskTemplate: string
  /** 本阶段产物目录（相对项目沙箱根；空串=无独立目录，产物以 gates 声明为准）。 */
  outputPath: string
  /** 阶段约束（注入系统提示词；批次 C 起同步注入委派任务书软约束）。 */
  constraints: string[]
  /** 收口是否需要用户确认。刀1（2026-10-02）语义收缩：仅保留 Intent 层确认
   *  （requirements 节点=PRD 确认，走向导管线不在调度员 loop 内）——桌面接管
   *  阶段一律 false：门禁全绿自动推进，人工只保留异常处理与不可逆动作。 */
  requiresUserConfirmation: boolean
  /** 阶段内委派失败重试上限（超限转 blocked，由观察哨/接线层执行）。 */
  retryLimit: number
  /** 唯一合法推进目标（null=终态）。 */
  next: string | null
  /** 门禁声明列表（可空——requirements 复用现有向导管线门禁）。 */
  gates: PhaseGate[]
  /** 工具白名单扩展（叠加 dispatcher-gate 基础白名单；禁止写文件族）。 */
  extraTools: string[]
  /** false=复用现有管线（向导管线），调度员不接管该阶段。 */
  dispatcherManaged: boolean
}

// =========================================================================
// 阶段表数据（批次 B 品类底稿落地后可回填调整——改数据不改代码）
// =========================================================================

/**
 * 桌面品类阶段表（Windows P1 路径先行；Android 线另立表，不在本文件）。
 * 阶段语义见实施稿第三节草案；requirements 为复用声明节点（dispatcherManaged=false）。
 */
export const DESKTOP_PHASES: Record<DesktopPhaseId, PhaseNode> = {
  requirements: {
    id: 'requirements',
    role: '向导',
    title: '需求确认',
    taskTemplate:
      '本阶段由平台既有向导管线完成：澄清 → PRD 六维审查 → 用户确认。' +
      '调度员不接管本阶段；PRD 背板确认后桌面线从 desktop-arch 阶段接入。',
    outputPath: '',
    constraints: [
      'PRD 背板为唯一需求真相源，桌面阶段不得改写已确认需求',
    ],
    requiresUserConfirmation: true,
    retryLimit: 0,
    next: 'desktop-arch',
    gates: [],
    extraTools: [],
    dispatcherManaged: false,
  },
  'desktop-arch': {
    id: 'desktop-arch',
    role: '桌面架构师',
    title: '桌面选型与架构',
    taskTemplate:
      '委派架构师完成桌面技术选型，产出三件：\n' +
      '1. 选型结论（P1=Python 快速验证 / P2=Tauri 原生路线，给出理由与放弃项）；\n' +
      '2. 组件环境清单（env-checklist，标注每项组件的来源：模版已有 / 坑库 [实证] / 待 Spike）；\n' +
      '3. Spike 记录——知识缺口（模版与坑库均无 [实证]）∧ 影响选型或验收 ∧ 可时间盒（≤30 分钟）' +
      '时必须派 Spike 子会话实测，产物落 00_SPIKES/。\n' +
      'Windows 优先：本阶段所有结论默认以 Windows 11 为目标环境。',
    outputPath: '00_ARCH',
    constraints: [
      '选型结论必须给出放弃项理由，不允许只写胜出方案',
      '环境清单中每一项都要标注证据等级：[实证]（本机实测）/ [推断]（文档或社区结论）/ 待 Spike',
      'Spike 子会话时间盒 ≤30 分钟，超时中止并如实记录未完成',
    ],
    // 刀1（2026-10-02）：requiresUserConfirmation 收缩为 false + 撤 arch-confirm
    // manual 门——中间阶段零人工确认，门禁全绿自动推进（人工只保留 Intent 层与异常处理）。
    requiresUserConfirmation: false,
    retryLimit: 2,
    next: 'desktop-scaffold',
    gates: [
      {
        id: 'arch-decision',
        kind: 'artifact',
        description: '选型结论文档存在且可读（00_ARCH/architecture.md）',
        artifacts: ['00_ARCH/architecture.md'],
      },
      {
        id: 'env-checklist',
        kind: 'artifact',
        description: '组件环境清单存在且为合法 JSON（00_ARCH/env-checklist.json）',
        artifacts: ['00_ARCH/env-checklist.json'],
      },
    ],
    extraTools: [],
    dispatcherManaged: true,
  },
  'desktop-scaffold': {
    id: 'desktop-scaffold',
    role: '桌面全栈',
    title: '最小骨架',
    taskTemplate:
      '按选型结论搭建最小骨架（不实现业务功能）：\n' +
      '1. Python 最小骨架（托盘/全局快捷键/录音等组件按环境清单结论接入，未确认组件不引入）；\n' +
      '2. driver-skeleton.py——驱动断言骨架（每个 GWT 场景一个可执行断言，先写断言后写实现）；\n' +
      '3. 工程契约 contract.json——**必须严格采用以下形态（平台 schema fail-closed 校验，字段名/类型一字不差；schema_version 是数字 1 不是 "1.0"，入口字段名是 entry 不是 entrypoints，driver 是对象不是路径字符串）：**\n' + MINIMAL_CONTRACT_EXAMPLE + '\n' +
      '（components 按实际使用的 GUI/系统能力填；其余字段可自行扩展但上述必填面不得改名。）',
    outputPath: '00_SCAFFOLD',
    constraints: [
      '骨架只做结构不做业务：任何业务逻辑实现都属于 desktop-implement 阶段',
      '工程契约必须先于实现声明（驱动先行）',
    ],
    requiresUserConfirmation: false,
    retryLimit: 2,
    next: 'desktop-implement',
    gates: [
      {
        id: 'scaffold-contract',
        kind: 'artifact',
        description: '工程契约存在且可解析（00_SCAFFOLD/contract.json）',
        artifacts: ['00_SCAFFOLD/contract.json'],
      },
      {
        id: 'driver-skeleton',
        kind: 'artifact',
        description: '驱动断言骨架存在（00_SCAFFOLD/driver-skeleton.py）',
        artifacts: ['00_SCAFFOLD/driver-skeleton.py'],
      },
    ],
    extraTools: [],
    dispatcherManaged: true,
  },
  'desktop-implement': {
    id: 'desktop-implement',
    role: '桌面全栈',
    title: '实现与交付说明',
    taskTemplate:
      '续接骨架委派实现真实桌面程序：\n' +
      '1. 按 PRD 背板功能清单实现，驱动断言与实现静态自洽（断言先行、真实调用被测代码、禁止平凡通过）；\n' +
      '2. 真实红绿反馈：收口前用 run_project_driver（平台收口 spawn，本阶段唯一执行通道——子会话无 shell 是设计而非故障）跑一次驱动，失败清单交同一委派线修复后复跑；不要因「无法执行驱动」阻塞、编造或向用户索要本机运行；\n' +
      '3. 产出 DELIVERY.md 到项目根（不是 00_SCAFFOLD/ 内——门禁按项目根检查）——运行方式 / 依赖安装 / 已知限制 / 驱动执行入口；契约 driver.command 相对项目根解析，指向 00_SCAFFOLD/ 内文件须带目录前缀（如 00_SCAFFOLD/driver.py）。',
    outputPath: '',
    constraints: [
      '每实现一个功能必须先有对应驱动断言（禁止无断言的实现）',
      '实现与骨架同一委派线续接（上下文不换人）',
    ],
    // 刀1（2026-10-02）：撤 implement-confirm manual 门（同上语义收缩）。
    requiresUserConfirmation: false,
    retryLimit: 2,
    next: 'desktop-verify',
    gates: [
      {
        id: 'delivery-doc',
        kind: 'artifact',
        description: '交付说明存在（DELIVERY.md）',
        artifacts: ['DELIVERY.md'],
      },
    ],
    extraTools: ['run_project_driver'],
    dispatcherManaged: true,
  },
  'desktop-verify': {
    id: 'desktop-verify',
    role: '桌面测试工程师',
    title: '驱动验收',
    taskTemplate:
      '委派测试工程师（异渠道）执行驱动验收：\n' +
      '1. GWT 场景补全（driver.py 每场景一个可执行断言，断言先行）；\n' +
      '2. **驱动执行由平台收口时执行**（spawn python 跑 contract.json 的 driver.command，退出码/stdout 回读）——你不需要也无法自行执行驱动，不要花轮次尝试执行或写「无执行通道」的替代报告；\n' +
      '3. 你的验收职责 = contract.json 合法（必填形态一字不差：schema_version 数字 1 / entry / driver 对象含 command、timeout_ms、exit_code_semantics 三键、assert_readback / env_whitelist / components——形态见下）+ driver.py 断言齐备：\n' + MINIMAL_CONTRACT_EXAMPLE + '\n' +
      '4. 产出驱动执行报告（通过/失败/阻塞三分类，失败路由进修复轮）；\n' +
      '5. 裁决边界：裁判+攻防审查（C3）对交付物做最终判定。',
    outputPath: '00_VERIFY',
    constraints: [
      '测试工程师与实现者必须异渠道（C1 跨渠道委派）',
      '验证结论只看驱动执行回读，不采信模型自述',
    ],
    // 刀1（2026-10-02）：撤 deliver-confirm manual 门——verify 四门全绿自动落
    // delivered + 发交付通知卡（通知≠确认，不阻塞不等待；用户回复修改意见走迭代）。
    requiresUserConfirmation: false,
    retryLimit: 2,
    next: 'delivered',
    gates: [
      {
        id: 'driver-report',
        kind: 'driver',
        description: '工程契约驱动执行报告存在（00_VERIFY/driver-report.json，批次 C 兑现执行）',
        artifacts: ['00_VERIFY/driver-report.json'],
      },
    ],
    extraTools: [],
    dispatcherManaged: true,
  },
  delivered: {
    id: 'delivered',
    role: '',
    title: '已交付',
    taskTemplate: '终态。桌面线交付完成，后续迭代走既有 iterating 管线。',
    outputPath: '',
    constraints: [],
    requiresUserConfirmation: false,
    retryLimit: 0,
    next: null,
    gates: [],
    extraTools: [],
    dispatcherManaged: false,
  },
}

/** 阶段表数据（数组形态，保持声明序；插阶段只在此数组加数据）。 */
export const DESKTOP_PHASE_TABLE: readonly DesktopPhaseId[] = [
  'requirements',
  'desktop-arch',
  'desktop-scaffold',
  'desktop-implement',
  'desktop-verify',
  'delivered',
]

// =========================================================================
// 查询函数（纯）
// =========================================================================

/** 按 id 取阶段节点；未知 id 返回 undefined（防御性——调用方决定兜底语义）。 */
export function getDesktopPhase(id: string): PhaseNode | undefined {
  return DESKTOP_PHASES[id as DesktopPhaseId]
}

/** 唯一合法推进目标（关2 目标唯一性校验的数据源）；终态返回 null；未知 id 同样返回 null。 */
export function getNextDesktopPhase(id: string): string | null {
  return DESKTOP_PHASES[id as DesktopPhaseId]?.next ?? null
}

/** 按声明序列出全部阶段节点（进度展示/提示词构建用）。 */
export function listDesktopPhases(): PhaseNode[] {
  return DESKTOP_PHASE_TABLE.map((id) => DESKTOP_PHASES[id])
}

/** 调度员接管的阶段（dispatcherManaged=true，接线层决定从哪个节点起跑）。 */
export function listDispatcherManagedPhases(): PhaseNode[] {
  return listDesktopPhases().filter((node) => node.dispatcherManaged)
}

// =========================================================================
// 表完整性校验（纯；测试锁定 + 运行时接线前自检共用）
// =========================================================================

/** 表校验结果：violations 为空即通过。 */
export interface PhaseTableValidation {
  valid: boolean
  violations: string[]
}

/**
 * 阶段表完整性校验——「插阶段只改数据零代码改动」的安全网：
 * - 覆盖性：DESKTOP_PHASE_TABLE 与 DESKTOP_PHASES 键集一致（无孤儿节点/无漏登记）；
 * - 链完整：从 requirements 沿 next 可达 delivered，无断链、无环；
 * - 唯一起点/唯一终态；
 * - next 指向存在的节点；
 * - artifact 门禁必须声明 artifacts 且非空；driver 门禁同（批次 C 执行器依赖）；
 * - 每个非终态的接管节点（dispatcherManaged）至少一条门禁（产物或确认），
 *   防「空门禁直通」；复用节点的门禁在既有管线内，不重复声明。
 * 插入新阶段（如验收演示的 desktop-package）后重跑本校验即知数据是否自洽。
 */
export function validateDesktopPhaseTable(
  phases: Record<string, PhaseNode> = DESKTOP_PHASES,
  table: readonly string[] = DESKTOP_PHASE_TABLE,
): PhaseTableValidation {
  const violations: string[] = []

  // 覆盖性：表数组与记录键集精确一致
  const tableSet = new Set(table)
  const recordKeys = new Set(Object.keys(phases))
  for (const id of tableSet) {
    if (!recordKeys.has(id)) violations.push(`coverage: 表数组含 ${id} 但 DESKTOP_PHASES 无该节点`)
  }
  for (const key of recordKeys) {
    if (!tableSet.has(key)) violations.push(`coverage: DESKTOP_PHASES 含 ${key} 但未登记进表数组`)
  }

  for (const id of table) {
    const node = phases[id]
    if (!node) continue // 覆盖性已记
    // 节点自洽
    if (node.id !== id) violations.push(`self: 节点 ${id} 的 id 字段为 ${node.id}（键与 id 不一致）`)
    if (node.retryLimit < 0) violations.push(`self: 节点 ${id} retryLimit 为负`)
    // next 指向存在节点
    if (node.next !== null && !phases[node.next]) {
      violations.push(`next: 节点 ${id} 的 next=${String(node.next)} 不存在`)
    }
    // 门禁形态
    for (const gate of node.gates) {
      if (gate.kind === 'artifact' || gate.kind === 'driver') {
        if (!gate.artifacts || gate.artifacts.length === 0) {
          violations.push(`gate: 节点 ${id} 的门禁 ${gate.id}（${gate.kind}）未声明 artifacts`)
        }
      }
    }
    // 非终态至少一条门禁（产物或确认），防空门禁直通——限定调度员接管节点；
    // 复用节点（dispatcherManaged=false，如 requirements）门禁在既有管线内，不重复声明
    if (node.dispatcherManaged && node.next !== null && node.gates.length === 0) {
      violations.push(`gate: 非终态接管节点 ${id} 无任何门禁（产物/确认至少其一）`)
    }
  }

  // 唯一起点/终态
  const noIncoming = table.filter((id) => !table.some((other) => phases[other]?.next === id))
  if (noIncoming.length !== 1 || noIncoming[0] !== 'requirements') {
    violations.push(`chain: 起点不唯一或非 requirements（无入边节点：${noIncoming.join(',')}）`)
  }
  const terminals = table.filter((id) => phases[id]?.next === null)
  if (terminals.length !== 1 || terminals[0] !== 'delivered') {
    violations.push(`chain: 终态不唯一或非 delivered（终态：${terminals.join(',')}）`)
  }

  // 链完整：从 requirements 沿 next 走到 delivered，无环且覆盖全部节点
  const visited: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = 'requirements'
  if (phases['requirements']) {
    while (cursor !== null) {
      if (seen.has(cursor)) {
        violations.push(`chain: 检测到环（回到 ${cursor}）`)
        break
      }
      seen.add(cursor)
      visited.push(cursor)
      cursor = phases[cursor]?.next ?? null
    }
  }
  if (!seen.has('delivered')) violations.push('chain: 从 requirements 沿 next 不可达 delivered')
  for (const id of table) {
    if (!seen.has(id) && !violations.some((v) => v.includes('环'))) {
      violations.push(`chain: 节点 ${id} 不在主链上（断链或旁支）`)
    }
  }

  return { valid: violations.length === 0, violations }
}
