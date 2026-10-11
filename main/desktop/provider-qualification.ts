/**
 * 平台 Provider Qualification（批9 工件6.3，2026-10-07）。
 *
 * 拍板（计划 bloma-batch9 决策速查「LLM key」行）：平台 Broker＝Bloma 渠道系统——
 * verify 收口时（背板 shape.llm_role≠none）平台**用自己的渠道**（runtime-fallback 解析，
 * key 不出平台进程、产物与子会话全程不接触）按产物声明的请求 schema 发 1~2 次真实
 * 调用，验证：认证 / HTTP 状态 / schema 合法 / 错误形态。结果双轴写入
 * 00_VERIFY/llm-qualification.json（provider_real 轴；local_replay 轴由驱动 mock 断言
 * 承担——两轴永不合并成一个绿色），mvp-confirm 报告与交付卡消费。
 *
 * 预算护栏：每单 ≤2 次真实调用（provider_smoke_calls≤2）；已 qualified 的重跑幂等
 * 短路（读上次结果直接返回，不再消耗预算）。
 *
 * 产物声明（llm-provider.json，项目根——implement 任务书在 llm_role≠none 时教写）：
 * {"schema_version":1,"provider":"openai_compatible","base_url":"(用户配置)","model":"(用户配置)",
 *  "request_sample":{"messages":[{"role":"user","content":"你好"}]},"auth":"user_config"}
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveChannelEnv } from '../platform/llm/runtime-fallback'
import type { DocumentCategory } from '../platform/llm/model-resolution'
import type { ProductShape } from '../model/prd-backplane'
import { readPrdBackplane } from '../project/document-engine'
import { verificationFingerprint } from './verification-fingerprint'
import { normalizeHttpUsage, startDirectQuery } from '../platform/llm/request-ledger'

/** 产物 LLM 声明（解析容错：结构不合法按未声明处理）。 */
export interface LlmProviderDeclaration {
  provider?: string
  base_url?: string
  model?: string
  auth?: string
  request_sample?: {
    messages?: Array<{ role?: unknown; content?: unknown }>
  }
}

/** 双轴验证的 provider_real 轴结果（local_replay 轴在 driver-report）。 */
export interface LlmQualificationOutcome {
  executed: boolean
  qualified: boolean
  /** 真实调用次数（≤2 预算护栏）。 */
  calls: number
  /** 平台渠道实测用的模型与端点 host（不泄露 key/完整 URL）。 */
  channel_model?: string
  channel_base_host?: string
  /** 产物声明回读（provider 形态；schema 合法性）。 */
  declared_provider?: string
  request_schema_valid?: boolean
  /** 问题清单（业务语言，进报告）。 */
  findings: string[]
  skipped_reason?: string
  checked_at: string
  fingerprint?: string
  reused?: boolean
}

/** 声明文件相对路径（项目根）。 */
export const LLM_PROVIDER_DECL_REL = 'llm-provider.json'
/** 结果落盘相对路径（00_VERIFY/）。 */
export const LLM_QUALIFICATION_REL = '00_VERIFY/llm-qualification.json'

/** 顶层或 request.request_sample 嵌套两路径提取 messages（parse 校验与请求构造共用；
 *  批10 2026-10-07 修复：批9.5 只修了校验侧嵌套兼容，构造侧仍只读顶层——嵌套声明
 *  校验合法但请求 messages 恒空，glm 报 1214「输入不能为空」真机实锤）。 */
function extractSampleMessages(parsed: Record<string, unknown> | undefined): Array<{ role?: unknown; content?: unknown }> {
  if (!parsed) return []
  const sample = (parsed.request_sample ?? (parsed.request as { request_sample?: unknown } | undefined)?.request_sample) as { messages?: unknown } | undefined
  return Array.isArray(sample?.messages) ? (sample.messages as Array<{ role?: unknown; content?: unknown }>) : []
}

/** 解析产物声明（容错：非对象/缺 messages 视为 schema 不合法）。
 * 批9.5 狗粮 b14861db 实证：产物合理变体把 request_sample 嵌在 request 对象内
 * （request.request_sample.messages）——兼容顶层与嵌套两路径（messages 数组结构为准）。 */
export function parseLlmDeclaration(raw: string | undefined): { declaration?: LlmProviderDeclaration; schemaValid: boolean } {
  if (!raw) return { schemaValid: false }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const messages = extractSampleMessages(parsed)
    const schemaValid =
      messages.length > 0 &&
      messages.every(
        (m) =>
          typeof m === 'object' && m !== null &&
          typeof (m as Record<string, unknown>).role === 'string' &&
          typeof (m as Record<string, unknown>).content === 'string' &&
          ((m as Record<string, unknown>).content as string).length > 0,
      )
    return {
      declaration: parsed as LlmProviderDeclaration,
      schemaValid,
    }
  } catch {
    return { schemaValid: false }
  }
}


/** declared_provider 宽容提取（批9.5 狗粮实证：产物可能给 {type,...} 对象而非字符串）。 */
function declaredProviderOf(declaration: LlmProviderDeclaration | undefined): string | undefined {
  const provider = declaration?.provider as unknown
  if (typeof provider === 'string') return provider
  if (provider && typeof provider === 'object' && typeof (provider as { type?: unknown }).type === 'string') {
    return (provider as { type: string }).type
  }
  return undefined
}

/** 从 base_url 提取 host（报告呈现不泄露完整 URL 与 key）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.slice(0, 40)
  }
}

/** anthropic 协议端点 versioned 拼接（陷阱 12：带路径 base 无 /v1 → 200 包 404 空流事故）。 */
function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(trimmed)) return trimmed
  if (/\/v1$/.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

/** openai 兼容端点拼接。 */
function openaiChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

/**
 * 执行 Provider Qualification（verify 收口挂点；I/O 全注入可测）。
 * 任何内部异常都收敛为如实 outcome（fail-open：真实验证失败不阻断交付链，
 * 由交付卡双轴呈现+core 角色语义标注阻塞正式交付）。
 */
export async function runProviderQualification(options: {
  projectId: string
  sessionId: string
  sandboxRoot: string
  llmRole: ProductShape['llm_role']
  /** LLM 类别路由（缺省 mvp——实现类渠道）。 */
  category?: DocumentCategory
  signal?: AbortSignal
  /** 测试注入：fetch 实现。 */
  fetchImpl?: typeof fetch
  /** 测试注入：声明读取（缺省 sandboxRoot/llm-provider.json）。 */
  readDeclaration?: () => string | undefined
  /** 测试注入：上次结果读取（幂等短路；缺省 sandboxRoot/00_VERIFY/llm-qualification.json）。 */
  readPriorResult?: () => string | undefined
  /** 测试注入：结果写盘。 */
  writeResult?: (relativePath: string, content: string) => void
  timeoutMs?: number
}): Promise<LlmQualificationOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = () => new Date().toISOString()
  const readDeclaration =
    options.readDeclaration ?? (() => {
      const path = join(options.sandboxRoot, LLM_PROVIDER_DECL_REL)
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    })
  const readPriorResult =
    options.readPriorResult ??
    (() => {
      const path = join(options.sandboxRoot, LLM_QUALIFICATION_REL)
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    })
  const writeResult =
    options.writeResult ??
    ((relativePath, content) => {
      writeFileSync(join(options.sandboxRoot, relativePath), content, 'utf8')
    })

  if (options.llmRole === 'none' || !options.llmRole) {
    return { executed: false, qualified: false, calls: 0, findings: [], skipped_reason: 'llm_role=none（无 LLM，无需真实验证）', checked_at: now() }
  }

  const findings: string[] = []
  const declarationRaw = readDeclaration()
  const { declaration, schemaValid } = parseLlmDeclaration(declarationRaw)
  if (!declaration || !schemaValid) {
    const outcome: LlmQualificationOutcome = {
      executed: true,
      qualified: false,
      calls: 0,
      declared_provider: declaredProviderOf(declaration),
      request_schema_valid: false,
      findings: [
        '产物未按任务书声明 LLM 调用形态（llm-provider.json 缺失或 request_sample.messages 结构不合法）——真实可用性无法代验，本地集成验证不代表真实 Provider 验证',
      ],
      checked_at: now(),
    }
    try {
      writeResult(LLM_QUALIFICATION_REL, JSON.stringify(outcome, null, 2))
    } catch {
      // 落盘失败不阻断
    }
    return outcome
  }

  // 平台渠道解析（key 不出平台进程：env 只在本函数作用域内用于构造请求头）
  const resolution = resolveChannelEnv({
    category: options.category ?? 'mvp',
    projectId: options.projectId,
    sessionId: options.sessionId,
  })
  if (!resolution.env || !resolution.channel) {
    const outcome: LlmQualificationOutcome = {
      executed: false,
      qualified: false,
      calls: 0,
      declared_provider: declaredProviderOf(declaration),
      request_schema_valid: true,
      findings: ['平台渠道不可用——本轮未做真实 Provider 验证（本地集成验证 ≠ 真实可用）'],
      skipped_reason: `渠道不可用（${resolution.unusableReason ?? 'unknown'}）`,
      checked_at: now(),
    }
    try {
      writeResult(LLM_QUALIFICATION_REL, JSON.stringify(outcome, null, 2))
    } catch {
      // 落盘失败不阻断
    }
    return outcome
  }

  const baseUrl = resolution.env.ANTHROPIC_BASE_URL ?? ''
  const apiKey = resolution.env.ANTHROPIC_AUTH_TOKEN ?? ''
  const model = resolution.env.ANTHROPIC_MODEL ?? ''
  const providerType = resolution.env.ANTHROPIC_PROVIDER_TYPE ?? 'anthropic'
  // The key participates only in the digest; never persist its plaintext.
  const fingerprint = verificationFingerprint(options.sandboxRoot, {
    declaration: declarationRaw, role: options.llmRole, baseUrl, model, providerType, apiKey,
  })
  try {
    const prior = JSON.parse(readPriorResult() ?? 'null') as LlmQualificationOutcome | null
    const age = Date.now() - Date.parse(prior?.checked_at ?? '')
    if (fingerprint && prior?.qualified === true && prior.fingerprint === fingerprint && age >= 0 && age < 24 * 60 * 60 * 1000) return { ...prior, calls: 0, reused: true }
  } catch { /* corrupt/legacy evidence requires a new verification */ }
  const isOpenAi = providerType === 'openai'
  const url = isOpenAi ? openaiChatUrl(baseUrl) : anthropicMessagesUrl(baseUrl)
  const sampleMessages = extractSampleMessages(declaration as unknown as Record<string, unknown>).map((m) => ({
    role: String((m as Record<string, unknown>).role),
    content: String((m as Record<string, unknown>).content),
  }))
  // 批9.5 审核修正：openai 惯例的 system 首条在 anthropic 端点会被拒（messages 不许
  // role=system）——anthropic 型渠道剥出为顶层 system 字段（协议语义等价）。
  const systemMessages = sampleMessages.filter((m) => m.role === 'system')
  const chatMessages = sampleMessages.filter((m) => m.role !== 'system')
  const body = isOpenAi
    ? JSON.stringify({ model, messages: sampleMessages, max_tokens: 256 })
    : JSON.stringify({
        model,
        max_tokens: 256,
        ...(systemMessages.length > 0 ? { system: systemMessages.map((m) => m.content).join('\n') } : {}),
        messages: chatMessages.length > 0 ? chatMessages : sampleMessages,
      })
  const headers: Record<string, string> = isOpenAi
    ? { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
    : {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      }

  let calls = 0
  let lastError = ''
  const accounting = startDirectQuery({ projectId: options.projectId, sessionId: options.sessionId, role: 'provider_qualification', model, endpointHost: hostOf(baseUrl) })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    calls += 1
    try {
      accounting.startAttempt()
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        accounting.failAttempt()
        lastError = `HTTP ${response.status}：${text.slice(0, 200)}`
        // 4xx（认证/参数）重试同结果无意义；5xx/429 可重试一次
        if (response.status < 500 && response.status !== 429) break
        continue
      }
      const parsed = JSON.parse(text) as Record<string, unknown>
      const contentOk = isOpenAi
        ? Boolean(
            Array.isArray(parsed.choices) &&
              parsed.choices[0] &&
              typeof (parsed.choices[0] as Record<string, unknown>).message === 'object',
          )
        : Boolean(Array.isArray(parsed.content) && parsed.content.length > 0)
      const outcome: LlmQualificationOutcome = contentOk
        ? {
            executed: true,
            qualified: true,
            calls,
            channel_model: model,
            channel_base_host: hostOf(baseUrl),
            declared_provider: declaredProviderOf(declaration),
            request_schema_valid: true,
            findings: [],
            checked_at: now(),
          }
        : {
            executed: true,
            qualified: false,
            calls,
            channel_model: model,
            channel_base_host: hostOf(baseUrl),
            declared_provider: declaredProviderOf(declaration),
            request_schema_valid: true,
            findings: [`端点返回 2xx 但响应结构不含内容块（${text.slice(0, 160)}）——产物请求 schema 与真实端点可能不匹配`],
            checked_at: now(),
          }
      outcome.fingerprint = fingerprint
      accounting.finish(normalizeHttpUsage(parsed.usage, isOpenAi), contentOk ? 'completed' : 'error')
      try {
        writeResult(LLM_QUALIFICATION_REL, JSON.stringify(outcome, null, 2))
      } catch {
        // 落盘失败不阻断
      }
      return outcome
    } catch (error) {
      accounting.failAttempt()
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      // 网络异常/超时重试一次
      continue
    }
  }

  const outcome: LlmQualificationOutcome = {
    executed: true,
    qualified: false,
    calls,
    channel_model: model,
    channel_base_host: hostOf(baseUrl),
    declared_provider: declaredProviderOf(declaration),
    request_schema_valid: true,
    findings: [`平台渠道真实调用未通过（${lastError}）——这验证的是「该请求 schema 在真实端点上的行为」，产物按同 schema 配置真实 key 后的可用性需用户自验`],
    checked_at: now(),
    fingerprint,
  }
  accounting.finish(undefined, options.signal?.aborted ? 'cancelled' : 'error')
  try {
    writeResult(LLM_QUALIFICATION_REL, JSON.stringify(outcome, null, 2))
  } catch {
    // 落盘失败不阻断
  }
  return outcome
}

/** 读上次 qualification 结果（mvp-confirm 报告/交付卡消费；缺失返回 undefined）。 */
export function readLlmQualification(sandboxRoot: string): LlmQualificationOutcome | undefined {
  try {
    const path = join(sandboxRoot, LLM_QUALIFICATION_REL)
    if (!existsSync(path)) return undefined
    // 类型清洗（批10.5 审查C P2-1）：磁盘 JSON 无运行时校验，布尔/数字字段归一后
    // 供报告插值——防篡改的 llm-qualification.json 把任意字符串插进 mvp-review.html。
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return {
      executed: raw.executed === true,
      qualified: raw.qualified === true,
      calls: Number.isFinite(Number(raw.calls)) ? Number(raw.calls) : 0,
      findings: Array.isArray(raw.findings) ? raw.findings.filter((f): f is string => typeof f === 'string') : [],
      ...(typeof raw.channel_model === 'string' ? { channel_model: raw.channel_model } : {}),
      ...(typeof raw.channel_base_host === 'string' ? { channel_base_host: raw.channel_base_host } : {}),
      ...(typeof raw.declared_provider === 'string' ? { declared_provider: raw.declared_provider } : {}),
      ...(raw.request_schema_valid === true ? { request_schema_valid: true } : {}),
      ...(typeof raw.skipped_reason === 'string' ? { skipped_reason: raw.skipped_reason } : {}),
      ...(typeof raw.checked_at === 'string' ? { checked_at: raw.checked_at } : { checked_at: new Date().toISOString() }),
      ...(typeof raw.fingerprint === 'string' ? { fingerprint: raw.fingerprint } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * verify 收口便捷入口（批9 工件6.3 挂点，R7 拆分）：读背板 shape，llm_role≠none 时
 * 执行真实验证（内部含幂等短路与 fail-open）；llm_role=none 或背板异常均为 no-op。
 * dispatcher-loop 的 runVerifyFinalize 只调本函数（挂接块不留在 loop 文件里）。
 */
export async function runProviderQualificationIfLlm(options: {
  projectId: string
  sessionId: string
  sandboxRoot: string
}): Promise<void> {
  try {
    const shape = readPrdBackplane(options.projectId).shape
    if (shape && shape.llm_role !== 'none') {
      await runProviderQualification({
        projectId: options.projectId,
        sessionId: options.sessionId,
        sandboxRoot: options.sandboxRoot,
        llmRole: shape.llm_role,
      })
    }
  } catch {
    // fail-open：真实验证链路异常如实降级（未写结果文件=报告呈现「未验证」）
  }
}
