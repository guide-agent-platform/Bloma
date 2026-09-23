/**
 * D2 DSML 传输事故恢复（2026-09-11 狗粮 dd6ba98d「纵版打飞机」三连死根因）。
 *
 * ds/deepseek-flash 渠道在长工具循环中会把工具调用以内部协议原文漏进正文
 * （`<｜｜DSML｜｜ calls>` 整段，工具调用从未作为 tool_use 送达）。当晚三次
 * loop 死亡全部源于此（不是轮数耗尽）：生成轮 38、修复轮 11、二次生成收尾轮。
 * 泛化「传输事故反馈」重试一次仍脏（模型陷在 DSML 盆地里），loop 如实 turn_limit。
 *
 * 恢复策略（按安全性分级）：
 * - **只读调用直接执行**：read_file/grep/list_files/run_* 类调用的意图与参数在
 *   DSML 原文里完整无损（当晚实测：path/offset/pattern 全部完好），且只读面
 *   零副作用——解析回 tool_use 后按正常轮执行，loop 存活；
 * - **写类调用不盲执行**：write_file 的 content 参数值经 DSML 序列化疑似丢换行
 *   （当晚 line146 实锤：`speed: 300, // 像素/秒 radius: 11,`——注释吞掉本该换行的
 *   属性），盲执行会写坏代码——改为**定向反馈**重试（把解析出的调用意图明确告诉
 *   模型，要求以标准 tool use 重发），比泛化反馈更可能逃出退化盆地。
 *
 * 开关 BLOMA_DSML_RECOVERY：'0'=关（现状：一律泛化反馈重试一次后 turn_limit）；
 * '1'/未设=开。缺省 on 拍板理由：只读恢复零副作用、写类不盲执行，风险面收窄；
 * 当晚 3/3 loop 死于此，属渠道兼容垫片而非行为实验。
 */

/** 可直接恢复执行的工具面（只读/验证类；写类与委派类一律走定向反馈）。 */
export const DSML_RECOVERABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'grep',
  'run_preview',
  'run_gwt_tests',
  'run_security_scan',
  'run_api_contract_tests',
  'run_preflight',
])

/** 单参数值长度上限：超出视为信道损坏/病态载荷，降级定向反馈。 */
const DSML_PARAM_MAX_CHARS = 1024
/** 单轮最多恢复的 invoke 数（与正常并行工具调用量级对齐）。 */
const DSML_MAX_INVOKES = 8

export interface DsmlInvoke {
  name: string
  input: Record<string, unknown>
}

export interface DsmlParseResult {
  invokes: DsmlInvoke[]
  /** 协议块之前的合法旁白（正常叙述，非退化部分）。 */
  prose: string
}

const INVOKE_RE = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>/g
const PARAM_RE = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"\s+string="([^"]*)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/g
const CALLS_OPEN_RE = /<｜｜DSML｜｜\s*calls\s*>/i

/** 解析正文里的 DSML invoke 块；无 invoke 或结构破损返回 null（调用方走泛化反馈）。 */
export function parseDsmlInvokes(text: string): DsmlParseResult | null {
  const invokes: DsmlInvoke[] = []
  for (const match of text.matchAll(INVOKE_RE)) {
    const name = (match[1] ?? '').trim()
    if (!name) return null
    const input: Record<string, unknown> = {}
    for (const param of (match[2] ?? '').matchAll(PARAM_RE)) {
      const key = (param[1] ?? '').trim()
      if (!key) return null
      const raw = param[3] ?? ''
      if (raw.length > DSML_PARAM_MAX_CHARS) return null
      if (param[2] === 'false') {
        const num = Number(raw.trim())
        input[key] = Number.isFinite(num) ? num : raw.trim()
      } else {
        input[key] = raw
      }
    }
    invokes.push({ name, input })
    if (invokes.length > DSML_MAX_INVOKES) return null
  }
  if (invokes.length === 0) return null
  const openIndex = text.search(CALLS_OPEN_RE)
  const prose = (openIndex > 0 ? text.slice(0, openIndex) : '').trim()
  return { invokes, prose }
}

/** 恢复分级：execute=全部只读且工具在册，可直接执行；feedback=含写类/未知工具/超限。 */
export function classifyDsmlRecovery(parsed: DsmlParseResult, knownTools: Set<string>): 'execute' | 'feedback' {
  if (parsed.invokes.length === 0 || parsed.invokes.length > DSML_MAX_INVOKES) return 'feedback'
  return parsed.invokes.every((invoke) => DSML_RECOVERABLE_TOOLS.has(invoke.name) && knownTools.has(invoke.name))
    ? 'execute'
    : 'feedback'
}

/** 定向反馈文本：列出解析出的调用意图，要求以标准 tool use 重发（替代泛化措辞）。 */
export function buildTargetedDegenerateFeedback(parsed: DsmlParseResult | null): string {
  if (!parsed || parsed.invokes.length === 0) {
    return '【传输事故反馈】你上一轮的回复没有携带任何工具调用，且正文混入了工具调用协议原文或退行性重复文本，被平台判为无效输出。请重新输出这一轮：任务未完成就正常调用工具继续；确实已完成就输出干净的完成总结。不要复述无效文本。'
  }
  const lines = parsed.invokes.slice(0, 8).map((invoke) => {
    const args = Object.entries(invoke.input)
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join('、')
    return `- ${invoke.name}(${args})`
  })
  return [
    '【传输事故反馈】你上一轮的工具调用以协议原文形式漏进了正文，从未作为工具调用送达（平台已解析出你的调用意图）：',
    ...lines,
    '请直接以标准工具调用（tool use）重新发起上述调用，不要把调用写在正文里；若还有叙述需要，正文与工具调用可以并存。',
  ].join('\n')
}

/** 开关（'0'=关；'1'/未设=开——缺省 on 拍板项，逃生口保留）。 */
export function dsmlRecoveryEnabled(): boolean {
  const raw = (process.env.BLOMA_DSML_RECOVERY ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  return true
}
