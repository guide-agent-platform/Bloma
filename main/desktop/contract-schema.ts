/**
 * 桌面工程契约 schema 校验器（批次 C，2026-09-24）。
 *
 * 契约是驱动执行的安全边界核心（实施稿第六节：契约声明制——驱动必须在
 * contract.json 注册才可被执行器 spawn）。本模块 fail-closed：任何校验不过，
 * 执行器拒绝执行（缺字段/类型错/命令形态违规都不可执行）。
 *
 * 对齐批次 B 骨架 main/templates/skeletons/desktop-python/contract.json 样例。
 * 纯函数零 I/O；JSON 解析由调用方完成（执行器收对象）。
 */

// =========================================================================
// 契约类型（schema 的 TS 面）
// =========================================================================

/** 驱动命令声明（数组形态——首元素为命令，余为参数）。 */
export interface ContractDriver {
  command: string[]
  timeout_ms: number
  exit_code_semantics: Record<string, string>
  assert_readback: string
}

/** 自检命令声明（打包冒烟共用）。 */
export interface ContractSelfCheck {
  command: string[]
  expect_exit: number
  expect_stdout_contains?: string
}

/** 打包声明。 */
export interface ContractPackaging {
  tool: string
  args: string[]
  smoke: { command: string[]; expect_exit: number }
}

/** 工程契约（解析后形态）。 */
export interface ProjectContract {
  schema_version: number
  description?: string
  entry: string
  driver: ContractDriver
  self_check?: ContractSelfCheck
  env_whitelist: string[]
  components: string[]
  /** 场景映射（批4 2026-10-06 验收语义冻结）：driver 场景名 → 覆盖的 PRD 验收点 F-id——
 *  验收点映射完整性的数据源（每个 P0 F-id 至少一个 pass 场景，否则收口拒收）。 */
  scenarios: ContractScenario[]
  packaging?: ContractPackaging
  notes?: string[]
}

/** 场景映射条目：name 与 driver stdout 锚点场景名一致；covers = 覆盖的 F-id 列表。 */
export interface ContractScenario {
  name: string
  covers: string[]
}

/** 校验结果。 */
export interface ContractValidation {
  valid: boolean
  errors: string[]
}

// =========================================================================
// 命令安全边界（黑名单——schema 校验的二道防线）
// =========================================================================

/**
 * 命令黑名单模式：注册表/系统目录/破坏性命令（实施稿第六节风险清单）。
 * 命中即拒绝——无论出现在 driver.command / self_check.command / packaging 哪个面。
 */
const COMMAND_BLACKLIST: readonly RegExp[] = [
  /\breg(?:edit|exe)?\b/i,
  /\bpowershell\b/i,
  /\bcmd\b/i,
  /\bformat\b/i,
  /\bdel\b|\berase\b/i,
  /\brmdir\b|\brm\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\btaskkill\b/i,
  /\bnet\s+(?:user|localgroup|stop|start)\b/i,
  /\bsc\b|\bschtasks\b/i,
  /\bmsiexec\b/i,
  /\bbcdedit\b/i,
  /\bvssadmin\b/i,
  /[\\/](?:Windows|System32|SysWOW64)[\\/]/i,
]

/** 命令黑名单校验：数组内任一 token 命中即违规。 */
export function violatesCommandBlacklist(command: readonly string[]): string | null {
  const joined = command.join(' ')
  for (const pattern of COMMAND_BLACKLIST) {
    if (pattern.test(joined)) return `命令命中黑名单模式 ${pattern}：「${joined}」`
  }
  return null
}

// =========================================================================
// 校验主体
// =========================================================================

const CURRENT_SCHEMA_VERSION = 1

/** 最小合规契约样例（狗粮 7bc4eeff 实证：模型凭空写契约会发明方言——schema_version
 * "1.0"/entrypoints/路径字符串 driver 三错全犯；scaffold 与 verify 任务书内嵌本样例，
 * 模型照写即过校验。本样例自身必须 parse 通过（contract-schema 测试自洽锁）。 */
// ada13257 脑测批（2026-10-02）：command 相对项目根解析——scaffold 产物在
// 00_SCAFFOLD/ 下，命令必须带目录前缀；样例即教学法，防下一个项目再撞 not-found。
export const MINIMAL_CONTRACT_EXAMPLE = `{
  "schema_version": 1,
  "entry": "app.py",
  "driver": {
    "command": ["python", "00_SCAFFOLD/driver.py"],
    "timeout_ms": 60000,
    "exit_code_semantics": { "0": "全部断言通过", "1": "存在断言失败", "2": "环境阻塞" },
    "assert_readback": "逐场景断言结果从 stdout 读回"
  },
  "env_whitelist": [],
  "components": ["tkinter"],
  "scenarios": [
    { "name": "S1 新增记录成功", "covers": ["F-001"] },
    { "name": "S2 空输入拦截", "covers": ["F-001", "F-002"] }
  ]
}`

/**
 * 工程契约校验（fail-closed）。
 *
 * 校验面：
 * - 结构：必填字段存在且类型正确（schema_version/entry/driver 全要素/
 *   env_whitelist/components 数组）；
 * - 语义：schema_version 精确匹配当前版本（跨版本契约不可执行，防隐性漂移）；
 *   driver.command 非空数组且首元素为可执行名；timeout_ms 有界（1s-10min）；
 *   exit_code_semantics 必须覆盖 0/1/2 三分类键；
 * - 安全：三处命令面全部过黑名单；env_whitelist 变量名形态合法
 *   （^[A-Z_][A-Z0-9_]*$，防注入参数/值）。
 */
export function validateProjectContract(input: unknown): ContractValidation {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['契约必须是 JSON 对象'] }
  }
  const c = input as Record<string, unknown>

  // ── 结构与类型 ──
  if (c.schema_version !== CURRENT_SCHEMA_VERSION) {
    errors.push(`schema_version 必须为 ${CURRENT_SCHEMA_VERSION}（实际：${String(c.schema_version)}）`)
  }
  if (typeof c.entry !== 'string' || c.entry.length === 0) {
    errors.push('entry 必须为非空字符串（主程序入口文件）')
  }
  const driver = c.driver
  if (typeof driver !== 'object' || driver === null) {
    errors.push('driver 必须为对象')
    return { valid: false, errors }
  }
  const d = driver as Record<string, unknown>
  if (!Array.isArray(d.command) || d.command.length === 0 || d.command.some((t) => typeof t !== 'string' || t.length === 0)) {
    errors.push('driver.command 必须为非空字符串数组（首元素=命令，余=参数）')
  }
  if (typeof d.timeout_ms !== 'number' || !Number.isFinite(d.timeout_ms) || d.timeout_ms < 1000 || d.timeout_ms > 600_000) {
    errors.push('driver.timeout_ms 必须为 1000-600000 的数值（1s-10min）')
  }
  const semantics = d.exit_code_semantics
  if (typeof semantics !== 'object' || semantics === null) {
    errors.push('driver.exit_code_semantics 必须为对象')
  } else {
    for (const key of ['0', '1', '2']) {
      if (typeof (semantics as Record<string, unknown>)[key] !== 'string') {
        errors.push(`driver.exit_code_semantics 缺「${key}」键（三分类退出码语义必须齐备）`)
      }
    }
  }
  if (typeof d.assert_readback !== 'string' || d.assert_readback.length === 0) {
    errors.push('driver.assert_readback 必须为非空字符串（断言读回口径声明）')
  }
  for (const key of ['env_whitelist', 'components']) {
    if (!Array.isArray(c[key]) || (c[key] as unknown[]).some((v) => typeof v !== 'string')) {
      errors.push(`${key} 必须为字符串数组`)
    }
  }

  // ── 场景映射（批4 2026-10-06 验收语义冻结：验收点映射完整性，必填收紧不留兼容）──
  if (!Array.isArray(c.scenarios) || c.scenarios.length === 0) {
    errors.push('scenarios 必须为非空数组（每场景一项 {name, covers:[F-id]}——驱动场景与 PRD 验收点的映射；缺映射=验收语义悬空，收口会拒收）')
  } else {
    const seenNames = new Set<string>()
    for (const scenario of c.scenarios as unknown[]) {
      const s = (typeof scenario === 'object' && scenario !== null ? scenario : {}) as Record<string, unknown>
      const name = typeof s.name === 'string' ? s.name : ''
      if (name.length === 0) {
        errors.push('scenarios[].name 必须为非空字符串（与 driver stdout 锚点场景名一致）')
      } else if (seenNames.has(name)) {
        errors.push(`scenarios[].name 重复：「${name}」`) 
      } else {
        seenNames.add(name)
      }
      if (!Array.isArray(s.covers) || s.covers.length === 0 || (s.covers as unknown[]).some((v) => typeof v !== 'string' || v.length === 0)) {
        errors.push(`scenarios[].covers 必须为非空字符串数组（场景「${name || '?'}」未声明覆盖的 PRD 验收点 F-id）`)
      }
    }
  }

  // ── 自检（可选面）──
  if (c.self_check !== undefined) {
    const sc = c.self_check as Record<string, unknown>
    if (typeof sc !== 'object' || sc === null
      || !Array.isArray(sc.command) || sc.command.length === 0 || sc.command.some((t) => typeof t !== 'string')
      || typeof sc.expect_exit !== 'number') {
      errors.push('self_check 形态不合法（command 字符串数组 + expect_exit 数值）')
    }
  }

  // ── 打包（可选面）──
  if (c.packaging !== undefined) {
    const p = c.packaging as Record<string, unknown>
    if (typeof p !== 'object' || p === null
      || typeof p.tool !== 'string' || !Array.isArray(p.args)
      || typeof (p.smoke as Record<string, unknown> | undefined)?.command !== 'object' && !Array.isArray((p.smoke as Record<string, unknown> | undefined)?.command)) {
      errors.push('packaging 形态不合法（tool 字符串 + args 数组 + smoke.command 数组）')
    }
  }

  // ── 安全：命令黑名单三处全覆盖 ──
  if (Array.isArray(d.command)) {
    const hit = violatesCommandBlacklist(d.command as string[])
    if (hit) errors.push(`driver.${hit}`)
  }
  const sc = c.self_check as Record<string, unknown> | undefined
  if (sc && Array.isArray(sc.command)) {
    const hit = violatesCommandBlacklist(sc.command as string[])
    if (hit) errors.push(`self_check.${hit}`)
  }
  const p = c.packaging as Record<string, unknown> | undefined
  const smoke = p?.smoke as Record<string, unknown> | undefined
  if (smoke && Array.isArray(smoke.command)) {
    const hit = violatesCommandBlacklist(smoke.command as string[])
    if (hit) errors.push(`packaging.smoke.${hit}`)
  }

  // ── 安全：env 白名单变量名形态 ──
  if (Array.isArray(c.env_whitelist)) {
    for (const name of c.env_whitelist) {
      if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        errors.push(`env_whitelist 变量名形态不合法：「${String(name)}」（须 ^[A-Z_][A-Z0-9_]*$）`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 验收点覆盖聚合（批4 2026-10-06）：F-id → 覆盖它的场景名与全绿判定（一 F 多场景，
 * 全 pass 才算该验收点过；场景名不在回读结果里按非 pass 处理——映射声明了但没跑=没过）。
 * 纯函数：judge 门硬校验、driver-report 佐证、遥测三处共用同一口径。
 */
export interface AcceptanceCoverageEntry {
  fid: string
  scenarios: string[]
  passed: boolean
}
export function aggregateAcceptanceCoverage(
  contract: Pick<ProjectContract, 'scenarios'>,
  outcomes: ReadonlyArray<{ name: string; outcome: string }>,
): AcceptanceCoverageEntry[] {
  const outcomeByName = new Map(outcomes.map((o) => [o.name, o.outcome] as const))
  // 场景名口径兼容（2026-10-06 两单实锤）：contract 按批4 教学声明全名（「S1 新增
  // 记录成功」），driver stdout 锚点按任务书约定写裸 S<n>（「S1 PASS 结论」→ 解析名
  // 「S1」）——精确匹配全落空会把全绿场景误判成「声明未跑=未过」。精确失败时按
  // S 编号前缀双向匹配（词边界防 S1 串 S10）；仍无匹配保持 fail-closed。
  // 序号对位兑底（批8 下半狗粮实锤，2026-10-07）：contract 声明语义名
  // （create.persona-success）而 driver 锚点打裸 S<n> 时前缀也落空——裸 S<n> 按
  // 序号对位 contract 第 n 个场景（S1→第 1 个，driver 按 SCENARIOS 声明序逐行输出，
  // 契约场景也同源同序）；仅在前缀也失败时启用，越界/非 S 形态保持 fail-closed。
  const outcomeFor = (declared: string, declaredIndex: number): string | undefined => {
    const exact = outcomeByName.get(declared)
    if (exact !== undefined) return exact
    for (const [name, outcome] of outcomeByName) {
      if (name.length === 0 || declared.length === 0) continue
      const longer = declared.length >= name.length ? declared : name
      const shorter = longer === declared ? name : declared
      if (!longer.startsWith(shorter)) continue
      const rest = longer.slice(shorter.length)
      if (rest.length === 0 || /^[\s（(，,：:·-]/.test(rest)) return outcome
    }
    // 序号对位兑底：声明的场景无精确/前缀命中，而 driver 锚点是裸 S<n> 时，
    // S<n> 的 n 对位 contract 声明序（S1→第 1 个；driver 按 SCENARIOS 声明序逐行输出，
    // 契约场景同源同序）。仅当声明名不是 S<数字> 前缀形态时启用——契约自己用 S 编号
    // 命名空间时（'S10 边界'）序号对位会引入串位，那个空间归前缀匹配管。
    if (declaredIndex >= 0 && !/^S\d/.test(declared)) {
      const ordinalOutcome = outcomeByName.get(`S${declaredIndex + 1}`)
      if (ordinalOutcome !== undefined) return ordinalOutcome
    }
    return undefined
  }
  const byFid = new Map<string, { scenarios: string[]; passed: boolean }>()
  let scenarioIndex = -1
  for (const scenario of contract.scenarios ?? []) {
    scenarioIndex += 1
    for (const fid of scenario.covers) {
      const entry = byFid.get(fid) ?? { scenarios: [], passed: true }
      entry.scenarios.push(scenario.name)
      if (outcomeFor(scenario.name, scenarioIndex) !== 'pass') entry.passed = false
      byFid.set(fid, entry)
    }
  }
  return Array.from(byFid.entries(), ([fid, value]) => ({ fid, ...value }))
}

/**
 * 解析并校验契约（一步式便捷入口）：不合法返回 undefined + 错误清单由调用方留档。
 * （返回 null 语义易与可选混淆，这里用抛错——执行器侧 fail-closed 直接中断）
 */
export function parseProjectContract(jsonText: string): ProjectContract {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`CONTRACT_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  }
  const validation = validateProjectContract(parsed)
  if (!validation.valid) {
    throw new Error(`CONTRACT_INVALID: ${validation.errors.join('；')}`)
  }
  return parsed as ProjectContract
}
