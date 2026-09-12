import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { anthropicMessagesQuery } from '../../main/orchestrator'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { runMvpTask, runAgentLoopPostTesting, setProgrammingEventPublisher } from '../../main/coding/programming-orchestrator'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { attributeRootCause, needsRefinement } from '../../main/experience/root-cause-attributor'
import { readAllCards, updateCardAttribution } from '../../main/experience/experience-service'
import type { AgentEvent } from '../../shared/types'

/**
 * 灰度全样例 headless harness（一次性观察工具，不在 CI 目录语义内）。
 *
 * 动机：UI 驱动弹窗点击不稳（多代弹窗文案重叠），而产品主链路零 Electron 耦合
 * （safe-storage/query 均 seam 注入），故直连真实 main 链跑全样例：
 * 真实阿里云 anthropic 端点 + runMvpTask（agent loop 生成）+ GWT 终验（真预览
 * +浏览器探针，chromium 缺失自动降级静态启发式）+ 裁判 + 经验库全门控（EXP=1）。
 *
 * 前置（scripts/scheduled-grayscale.mjs 负责）：
 * - GS_KEY_FILE=已解密的渠道 key 文件（electron channel-key-reader 产物，用后即删）
 * - GS_SAMPLE_JSON=可选样本（{name, requirements:[{id, description, behavior_assertions, priority}]}
 *   或其数组）；缺省跑内置 S1 记账样本。
 * - 熔断回滚（REPAIR_CIRCUIT_SETTLED）是真实终态：harness 如实记录并让写点③④成卡，
 *   不把该路径判为测试失败——灰度要的就是失败样例的卡质量。
 */

// 渠道/模型由环境注入（GS_CHANNEL/GS_MODEL，scheduled-grayscale 从 grayscale-config.json
// 读默认值）——2026-09-12 起支持 deepseek 等任意 anthropic 兼容渠道。
const FALLBACK_BASE_URL = 'https://ws-xni6wtx9e245jevi.cn-beijing.maas.aliyuncs.com/apps/anthropic'
let BASE_URL = FALLBACK_BASE_URL
let MODEL = 'qwen3.8-flash'
/** 渠道 base → anthropic 端点：阿里云 compatible-mode 需换 /apps/anthropic；deepseek 等已是 /anthropic 原样用。 */
function normalizeAnthropicBase(base: string | undefined): string {
  if (!base) return FALLBACK_BASE_URL
  if (base.includes('/compatible-mode')) return base.replace(/\/compatible-mode\/v1\/?$/, '/apps/anthropic')
  return base.replace(/\/+$/, '')
}

let home = ''
let realKey = ''
const events: AgentEvent[] = []
const log = (...a: unknown[]) => console.log(`[gs ${new Date().toISOString().slice(11, 19)}]`, ...a)

beforeAll(() => {
  const keyFile = process.env.GS_KEY_FILE
  if (!keyFile || !existsSync(keyFile)) throw new Error('GS_KEY_FILE 缺失：先跑 electron channel-key-reader 产 key')
  const chans = JSON.parse(readFileSync(keyFile, 'utf8'))
  const wanted = process.env.GS_CHANNEL || '阿里云云工'
  const entry = chans[wanted] || chans['阿里云云工']
  if (!entry || !entry.apiKey) {
    throw new Error(`渠道 ${wanted} 无可用 key；可用渠道：${Object.keys(chans).filter((k) => !k.startsWith('id:')).join(', ')}`)
  }
  realKey = entry.apiKey
  BASE_URL = normalizeAnthropicBase(entry.baseUrl)
  MODEL = process.env.GS_MODEL || MODEL
  home = mkdtempSync(join(tmpdir(), 'gs-headless-'))
  process.env.PROMA_HOME = home
  process.env.BLOMA_EXPERIENCE = '1'
  writeFileSync(
    join(home, 'bloma-channels.json'),
    JSON.stringify({
      version: 1,
      channels: [
        {
          id: 'gs-ali',
          name: '灰度-阿里云Anthropic',
          provider_type: 'anthropic',
          base_url: BASE_URL,
          api_key: 'in-memory-fake',
          models: [{ id: MODEL, name: MODEL, enabled: true, supports_tools: true }],
          enabled: true,
        },
      ],
    }),
    'utf8',
  )
  const routing: Record<string, { channel_id: string }> = {}
  for (const c of ['guide', 'prd', 'sketch', 'mvp', 'judge', 'audit', 'summary']) routing[c] = { channel_id: 'gs-ali' }
  writeFileSync(join(home, 'category-routing.json'), JSON.stringify({ version: 1, routing }), 'utf8')
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: () => realKey,
  })
  setProgrammingEventPublisher((event) => events.push(event))
  // 标记文件：脚本侧不解析 stdout（管道缓冲会淹没实时性），home 与逐样本结果落盘交换
  if (process.env.GS_HOME_MARK) writeFileSync(process.env.GS_HOME_MARK, home, 'utf8')
  log(`headless 环境就绪 home=${home} | 渠道=${process.env.GS_CHANNEL || '阿里云云工'} | 模型=${MODEL} | base=${BASE_URL}`)
})

type GsSample = {
  name: string
  requirements: Array<{ id: string; description: string; behavior_assertions: string[]; priority: 'P0' | 'P1' | 'P2' }>
}

const DEFAULT_SAMPLE: GsSample = {
  name: 'S1-记账小工具',
  requirements: [
    { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击添加后，新记录立即出现在列表中'], priority: 'P0' },
    { id: 'F-002', description: '按关键字搜索历史记录', behavior_assertions: ['在搜索框输入关键字时，列表只显示包含该关键字的记录'], priority: 'P0' },
  ],
}

function readSamples(): GsSample[] {
  const raw = process.env.GS_SAMPLE_JSON
  if (!raw) return [DEFAULT_SAMPLE]
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [DEFAULT_SAMPLE]
  } catch {
    return [DEFAULT_SAMPLE]
  }
}

/** 真 LLM 单轮补全（归因 seam 驱动）：收集 assistant 消息 text 块。 */
async function llmOnce(prompt: string): Promise<string> {
  let out = ''
  const stream = anthropicMessagesQuery(prompt, {
    // 产品 query 读 ANTHROPIC_AUTH_TOKEN 且要求 PATH 在场（ANTHROPIC_API_KEY 仅兼容旧路径）
    env: { ...process.env, ANTHROPIC_AUTH_TOKEN: realKey, ANTHROPIC_API_KEY: realKey, ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_MODEL: MODEL } as Record<string, string>,
    signal: new AbortController().signal,
    sessionId: `gs-attr-${Date.now().toString(36)}`,
  })
  for await (const msg of stream) {
    if (msg.type === 'assistant' && msg.message) {
      for (const block of msg.message.content) {
        if (block.type === 'text') out += block.text
      }
    }
  }
  return out
}

/**
 * V1.1 attribution-seam：对规则层拿不准（confidence 0 + stage unknown，灰度实测即
 * outcome 类卡占 40%）的候选卡跑真实 LLM 归因——attributeRootCause 内部强制
 * clamp ≤ LLM_ATTRIBUTION_MAX_CONFIDENCE(0.5)，reasoning 随 root_cause 落盘（
 * updateCardAttribution 追加快照行）。开关 off / 等值幂等由服务层既有纪律保证。
 */
async function runAttributionPass(): Promise<number> {
  let refinedCount = 0
  for (const card of readAllCards()) {
    if (!needsRefinement(card)) continue
    try {
      const refined = await attributeRootCause(card, { llmCall: llmOnce })
      if (await updateCardAttribution(card.id, refined)) refinedCount++
    } catch (e) {
      log('归因失败（保留规则层结果不阻塞）:', card.tag, String(e).slice(0, 80))
    }
  }
  return refinedCount
}

describe('灰度全样例（headless 真链）', () => {
  for (const sample of readSamples()) {
    it(
      `${sample.name}：生成→GWT 终验→裁判→经验库`,
      { timeout: 48 * 60_000 },
      async () => {
        const rid = `req-gs-${Date.now().toString(36)}`
        const project = createProject({ request_id: rid, mode: 'quick' })
        const projectId = project.project_id
        recordSketchGenerated(projectId, sample.requirements)
        log(`${sample.name} 开始生成`, projectId)
        const mvp = await runMvpTask({
          request_id: rid,
          session_id: `s-${rid}`,
          project_id: projectId,
          mode: 'quick',
          query: anthropicMessagesQuery,
          channel_id: 'gs-ali',
        })
        log('MVP 完成:', mvp.preview_url.slice(0, 30), 'via_loop=' + mvp.via_agent_loop, 'loop=' + mvp.loop_result?.status, 'build=' + mvp.build_gate?.status)
        let verdict = 'unknown'
        try {
          const post = await runAgentLoopPostTesting({
            request_id: rid,
            session_id: `s-${rid}`,
            project_id: projectId,
            mode: 'quick',
            preview_url: mvp.preview_url,
            ...(mvp.loop_result
              ? { loop: { status: mvp.loop_result.status, turns: mvp.loop_result.turns, finalText: mvp.loop_result.finalText, toolCalls: mvp.loop_result.toolCalls } }
              : {}),
            query: anthropicMessagesQuery,
            channel_id: 'gs-ali',
          })
          verdict = post.verdict
          log('终验结果:', post.verdict, JSON.stringify(post.test_result ?? {}).slice(0, 220))
        } catch (e) {
          // 熔断回滚=真实终态（灰度要的就是它），卡已由写点③④落账，不判 harness 失败
          verdict = 'circuit_break_settled'
          log('终验以熔断收束（预期内的失败样例路径）:', String(e).slice(0, 80))
        }
        const ledgerPath = join(home, 'bloma-experience.jsonl')
        let cardCount = 0
        if (existsSync(ledgerPath)) {
          for (const line of readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
            cardCount++
            const c = JSON.parse(line)
            log('账本卡:', c.kind, c.status, c.tag, 'r=' + c.recurrence, '|', String(c.body?.symptom ?? c.body?.capability ?? '').slice(0, 80))
          }
        }
        const attrN = await runAttributionPass()
        log(`attribution-seam：本轮精化 ${attrN} 张 unknown 卡（clamp≤0.5，reasoning 落盘）`)
        log(`样本收束 name=${sample.name} verdict=${verdict} cards=${cardCount}`)
        if (process.env.GS_RESULT_MARK) {
          const { appendFileSync } = await import('node:fs')
          appendFileSync(process.env.GS_RESULT_MARK, JSON.stringify({ name: sample.name, verdict, cards: cardCount, projectId }) + '\n', 'utf8')
        }
        expect(verdict).toBeTruthy()
      },
    )
  }
})
