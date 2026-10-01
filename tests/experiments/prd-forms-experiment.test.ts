// @vitest-environment node
/**
 * PRD 三形态同环境对比实验（2026-08-30 组会决议 6 / 质询点 7）
 *
 * 周大成要求：孙浩原主观认为「完整 PRD 信息有用性存疑」——必须用同一需求、
 * 三种形态（一句话 / 简单 / 完整）、同等环境分别生成，对比结果差异。
 *
 * 实验设计（详见 docs/05_PROJECT_PLAN/prd-forms-experiment.md）：
 *  - 同一需求主题：学习笔记应用（胡昊老师建议的演示级用例）
 *  - 三形态仅变化「用户侧输入」与会话上下文：
 *      A 一句话：单句需求 + 单条裸功能项
 *      B 简单：几条要点 + 对应裸功能项
 *      C 完整：结构化 PRD 文本 + 带 story/行为断言/优先级/范围外的功能项
 *  - 同等环境：同一渠道同一模型（缺省 DeepSeek 官方 deepseek-v4-flash，anthropic 协议；
 *    密钥经 scripts/channel-key-reader.cjs 解密）、生产系统提示词、生产 few-shot 注入
 *    （注入点③开）、温度 0.1（prd 类别缺省）、顺序执行
 *  - 走生产代码：generatePrdLlm（main/prd-engine-llm.ts）× anthropicMessagesQuery
 *    （main/orchestrator.ts）——不复制提示词，保证与线上同构
 *
 * 度量：PRD 产出成功/时延/定位语长度/逐项验收长度/EARS 词法命中/范围外条数/
 *       假设条数/锚点保真（功能项原样回显，生产语义补全约束）
 *
 * 运行（显式开启，平时整个套件 skip）：
 *   BLOMA_EXPERIMENT=prd-forms npx vitest run tests/experiments/prd-forms-experiment.test.ts
 * 可选：BLOMA_EXPERIMENT_RUNS=3（每形态重复次数，缺省 1）
 * 输出：docs/05_PROJECT_PLAN/prd-forms-experiment-results.json（结果文档由方案文档引用）
 */

import { describe, expect, it, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ENABLED = process.env.BLOMA_EXPERIMENT === 'prd-forms'
const RUNS = Math.max(1, Number(process.env.BLOMA_EXPERIMENT_RUNS ?? '1') || 1)

const describeExperiment = ENABLED ? describe : describe.skip

// ── 渠道解析（同等环境：固定一渠道一模型）────────────────────────
// 2026-09-02 实测校准：Bloma 真实渠道在 ~/.proma/bloma-channels.json（非 Proma 共享
// channels.json）；密钥经 safeStorage 加密，userData = AppData/Roaming/bloma（app name）；
// 解密结果结构 { name: { provider, baseUrl, apiKey } }（非 { name: token }）；
// 请求模型名用 models[].name（id 是内部标识会 400）。
interface DecryptedKey { provider?: string; baseUrl?: string; apiKey?: string; error?: string }
interface ChannelSpec { channelName: string; model: string; baseUrl: string }

function resolveChannelSpec(): ChannelSpec {
  const channelsPath = process.env.BLOMA_CHANNELS || join(homedir(), '.proma', 'bloma-channels.json')
  if (!existsSync(channelsPath)) throw new Error('bloma-channels.json 不存在：' + channelsPath)
  const raw = JSON.parse(readFileSync(channelsPath, 'utf-8')) as {
    channels: Array<{ name: string; base_url?: string; baseUrl?: string; enabled?: boolean; models?: Array<{ id: string; name?: string; enabled?: boolean }> }>
  }
  const ch = raw.channels.find((c) => c.enabled !== false)
  if (!ch) throw new Error('无启用渠道')
  const modelEntry = ch.models?.find((m) => m.enabled !== false)
  const model = modelEntry?.name ?? modelEntry?.id ?? ''
  const baseUrl = ch.base_url ?? ch.baseUrl ?? ''
  if (!model || !baseUrl) throw new Error('渠道缺 model/base_url')
  return { channelName: ch.name, model, baseUrl }
}

function readDecryptedKeys(): Record<string, DecryptedKey> {
  const root = process.env.BLOMA_ROOT ?? process.cwd()
  const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const keyReader = join(root, 'scripts', 'channel-key-reader.cjs')
  const channelsPath = process.env.BLOMA_CHANNELS || join(homedir(), '.proma', 'bloma-channels.json')
  const userData = process.env.BLOMA_USER_DATA || join(homedir(), 'AppData', 'Roaming', 'bloma')
  const out = join(process.env.TEMP ?? '/tmp', `bloma-exp-keys-${Date.now()}.json`)
  try {
    execFileSync(electronBin, [keyReader, channelsPath, out, userData], { stdio: 'pipe', windowsHide: true, timeout: 60_000 })
    return JSON.parse(readFileSync(out, 'utf-8')) as Record<string, DecryptedKey>
  } catch (error) {
    throw new Error('无法解密渠道密钥（Electron key-reader 失败）：' + String(error))
  }
}

// ── 三形态定义（同一需求：学习笔记）────────────────────────────
type FormSpec = {
  form: 'A-oneliner' | 'B-simple' | 'C-full'
  label: string
  conversation: string[]
  requirements: Array<Record<string, unknown>>
}

const FORMS: FormSpec[] = [
  {
    form: 'A-oneliner',
    label: '一句话',
    conversation: ['帮我做一个学习笔记应用。'],
    requirements: [{ id: 'F-001', description: '做一个学习笔记应用' }],
  },
  {
    form: 'B-simple',
    label: '简单（要点几条）',
    conversation: [
      '帮我做一个学习笔记应用，大概这样：',
      '- 能创建和编辑笔记，支持 markdown',
      '- 笔记能按分类整理',
      '- 能搜索笔记内容',
      '- 标记重点笔记方便复习',
    ],
    requirements: [
      { id: 'F-001', description: '创建和编辑笔记，支持 markdown' },
      { id: 'F-002', description: '笔记按分类整理' },
      { id: 'F-003', description: '搜索笔记内容' },
      { id: 'F-004', description: '标记重点笔记方便复习' },
    ],
  },
  {
    form: 'C-full',
    label: '完整（结构化 PRD）',
    conversation: [
      '需求：个人学习笔记应用（本地优先）。完整说明如下：',
      '【定位】给一个人用的本地学习笔记，记录课程/读书笔记并能高效复习。',
      '【功能与验收】',
      'F-001 创建与编辑笔记：作为学习者，我想新建笔记并用 markdown 编辑，以便结构化记录；验收——新建笔记后出现在列表顶部；编辑保存后内容即生效；空标题不允许保存。',
      'F-002 分类整理：作为学习者，我想把笔记归入分类，以便按科目查找；验收——分类可增删；笔记可归属一个分类；按分类筛选只显示该分类笔记。',
      'F-003 搜索：作为学习者，我想按关键词搜索笔记标题与正文，以便快速定位；验收——输入关键词后列表即时过滤；无结果时显示明确空态；搜索不区分大小写。',
      'F-004 复习标记：作为学习者，我想把笔记标记为重点，以便复习时优先看；验收——标记后笔记带重点标识；可按「只看重点」过滤；取消标记标识消失。',
      '【范围外】不做账号登录、不做多端同步、不做分享协作。',
      '【约束】数据只存本地；界面中文；无需安装即可使用。',
    ],
    requirements: [
      { id: 'F-001', description: '创建和编辑笔记，支持 markdown', story: '作为学习者，我想新建笔记并用 markdown 编辑，以便结构化记录', behavior_assertions: ['新建笔记后出现在列表顶部', '编辑保存后内容即生效', '空标题不允许保存'], priority: 'P0' },
      { id: 'F-002', description: '笔记按分类整理', story: '作为学习者，我想把笔记归入分类，以便按科目查找', behavior_assertions: ['分类可增删', '笔记可归属一个分类', '按分类筛选只显示该分类笔记'], priority: 'P1', scope_notes: '不做多级子分类' },
      { id: 'F-003', description: '搜索笔记内容', story: '作为学习者，我想按关键词搜索笔记标题与正文，以便快速定位', behavior_assertions: ['输入关键词后列表即时过滤', '无结果时显示明确空态', '搜索不区分大小写'], priority: 'P1' },
      { id: 'F-004', description: '标记重点笔记方便复习', story: '作为学习者，我想把笔记标记为重点，以便复习时优先看', behavior_assertions: ['标记后笔记带重点标识', '可按「只看重点」过滤', '取消标记标识消失'], priority: 'P2' },
    ],
  },
]

// EARS 词法命中（中英）：条件/事件/状态词 + 可度量量化词
const EARS_PATTERN = /(当|如果|若|一旦|之后|在.{0,12}时|when|if|once|after|while|至少|不超过|不超过|必须|禁止|无法|空|为空|超过|小于|大于|最多|最少|\d+\s*(条|个|次|秒|分钟))/gi

const writtenSessionIds: string[] = []
const resultRows: Array<Record<string, unknown>> = []

describeExperiment('PRD 三形态同环境对比实验（决议 6）', { timeout: 600_000 }, () => {
  afterAll(() => {
    // 清理会话文件（~/.proma/agent-sessions 下实验专用 id）
    for (const sessionId of writtenSessionIds) {
      try { rmSync(join(homedir(), '.proma', 'agent-sessions', `${sessionId}.jsonl`), { force: true }) } catch { /* 尽力清理 */ }
    }
    if (resultRows.length > 0) {
      const outPath = join(process.cwd(), 'docs', '05_PROJECT_PLAN', 'prd-forms-experiment-results.json')
      mkdirSync(join(process.cwd(), 'docs', '05_PROJECT_PLAN'), { recursive: true })
      writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs: RUNS, rows: resultRows }, null, 2), 'utf-8')
      console.log(`[prd-forms-experiment] 结果已写入 ${outPath}`)
      console.table(resultRows.map((r) => ({ 形态: r.label, 成功: r.prd_ok, ms: r.ms, 定位语字数: r.positioning_chars, 验收总字数: r.acceptance_chars, EARS命中: r.ears_hits, 范围外: r.out_of_scope, 假设: r.assumptions, 锚点保真: r.anchor_fidelity })))
    }
  })

  it('三形态 × 同渠道同模型 → generatePrdLlm 产物度量', async () => {
    const { generatePrdLlm } = await import('../../main/guide/prd-engine-llm')
    const { anthropicMessagesQueryViaProviders } = await import('../../main/platform/upstream/providers/loop-query')

    const spec = resolveChannelSpec()
    const keys = readDecryptedKeys()
    const entry = keys[spec.channelName]
    const token = entry?.apiKey
    const baseUrl = entry?.baseUrl || spec.baseUrl
    if (!token || !baseUrl) throw new Error(`渠道 ${spec.channelName} 密钥解密失败（可用：${Object.keys(keys).join('、')}，error=${entry?.error ?? '-'}）`)
    const env = {
      PATH: process.env.PATH ?? process.env.Path ?? '',
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: spec.model,
    }
    console.log(`[prd-forms-experiment] 同等环境：${spec.channelName} / ${spec.model}`)

    const sessionsDir = join(homedir(), '.proma', 'agent-sessions')
    mkdirSync(sessionsDir, { recursive: true })

    for (const form of FORMS) {
      for (let run = 1; run <= RUNS; run += 1) {
        const sessionId = `exp-prd-forms-${form.form}-${Date.now()}-${run}`
        const sessionPath = join(sessionsDir, `${sessionId}.jsonl`)
        // 会话内容 = 用户侧输入形态（实验唯一变量；助手行最小化保持三形态一致）
        const lines = [
          ...form.conversation.map((text) => JSON.stringify({ role: 'user', content: [{ type: 'text', text }], created_at: new Date().toISOString() })),
          JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '好的，我理解了，下面进入需求确认与 PRD 整理。' }], created_at: new Date().toISOString() }),
        ]
        writeFileSync(sessionPath, lines.join('\n') + '\n', 'utf-8')
        writtenSessionIds.push(sessionId)

        const started = Date.now()
        const backplane = await generatePrdLlm({
          project_id: `exp-prd-forms-${form.form}`,
          session_id: sessionId,
          requirements: form.requirements as never,
          template_type: 'personal_tool',
          query: anthropicMessagesQueryViaProviders,
          env,
        })
        const ms = Date.now() - started

        if (!backplane) {
          resultRows.push({ form: form.form, label: form.label, run, prd_ok: false, ms, error: 'generatePrdLlm 返回 null' })
          continue
        }

        const acceptanceText = Object.values(backplane.acceptance).join('\n')
        const anchorFidelity = form.requirements.every((req, index) => {
          const echoed = backplane.requirements[index] as { id: string; description: string } | undefined
          return echoed != null && echoed.id === (req as { id: string }).id && echoed.description === (req as { description: string }).description
        })
        const earsHits = (acceptanceText.match(EARS_PATTERN) ?? []).length

        resultRows.push({
          form: form.form,
          label: `${form.label}${RUNS > 1 ? ` #${run}` : ''}`,
          channel: `${spec.channelName}/${spec.model}`,
          prd_ok: true,
          ms,
          positioning_chars: backplane.positioning.length,
          acceptance_chars: acceptanceText.length,
          acceptance_items: Object.keys(backplane.acceptance).length,
          ears_hits: earsHits,
          out_of_scope: backplane.out_of_scope.length,
          assumptions: backplane.assumptions.length,
          anchor_fidelity: anchorFidelity,
        })
      }
    }

    expect(resultRows.length).toBe(FORMS.length * RUNS)
    // 至少两种形态产出了可比较的 PRD（全部失败=环境问题，不算实验完成）
    expect(resultRows.filter((r) => r.prd_ok).length).toBeGreaterThanOrEqual(Math.min(2, FORMS.length))
  })
})
