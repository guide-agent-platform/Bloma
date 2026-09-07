import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { anthropicMessagesQuery } from '../../main/orchestrator'
import { createProject, recordSketchGenerated, findProject } from '../../main/project-service'
import { runMvpTask, runAgentLoopPostTesting, setProgrammingEventPublisher } from '../../main/coding/programming-orchestrator'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import type { AgentEvent } from '../../shared/types'

/**
 * 灰度全样例 headless harness（一次性，不入库不进 CI——tests/experiments 目录）。
 *
 * 动机：UI 驱动弹窗点击不稳（多代弹窗文案重叠），而产品主链路零 Electron 耦合
 * （safe-storage/query 均 seam 注入），故直连真实 main 链跑全样例：
 * 真实阿里云 anthropic 端点 + runMvpTask（agent loop 生成）+ GWT 终验（真预览
 * +浏览器探针，chromium 缺失自动降级静态启发式）+ 裁判 + 经验库全门控（EXP=1）。
 *
 * 前置（run 脚本负责）：GS_KEY_FILE=已解密的阿里云云工 key 文件（用后即删）。
 */

const BASE_URL = 'https://ws-xni6wtx9e245jevi.cn-beijing.maas.aliyuncs.com/apps/anthropic'
const MODEL = 'qwen3.8-flash'

let home = ''
const events: AgentEvent[] = []
const log = (...a: unknown[]) => console.log(`[gs ${new Date().toISOString().slice(11, 19)}]`, ...a)

beforeAll(() => {
  const keyFile = process.env.GS_KEY_FILE
  if (!keyFile || !existsSync(keyFile)) throw new Error('GS_KEY_FILE 缺失：先跑 electron channel-key-reader 产 key')
  const realKey = JSON.parse(readFileSync(keyFile, 'utf8'))['阿里云云工'].apiKey
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
  log('headless 环境就绪 home=', home)
})

describe('灰度全样例（headless 真链）', () => {
  it(
    'S1 记账小工具：生成→GWT 终验→裁判→经验库',
    { timeout: 48 * 60_000 },
    async () => {
      const project = createProject({ request_id: 'req-gs-s1', mode: 'quick' })
      const projectId = project.project_id
      recordSketchGenerated(projectId, [
        { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击添加后，新记录立即出现在列表中'], priority: 'P0' },
        { id: 'F-002', description: '按关键字搜索历史记录', behavior_assertions: ['在搜索框输入关键字时，列表只显示包含该关键字的记录'], priority: 'P0' },
      ])
      log('S1 开始生成', projectId)
      const mvp = await runMvpTask({
        request_id: 'req-gs-s1',
        session_id: 's-gs-s1',
        project_id: projectId,
        mode: 'quick',
        query: anthropicMessagesQuery,
        channel_id: 'gs-ali',
      })
      log('MVP 完成:', { preview: mvp.preview_url.slice(0, 30), via_loop: mvp.via_agent_loop, loop_status: mvp.loop_result?.status, build: mvp.build_gate?.status })
      const p = findProject(projectId)
      const post = await runAgentLoopPostTesting({
        request_id: 'req-gs-s1',
        session_id: 's-gs-s1',
        project_id: projectId,
        mode: 'quick',
        preview_url: mvp.preview_url,
        ...(mvp.loop_result ? { loop: { status: mvp.loop_result.status, turns: mvp.loop_result.turns, finalText: mvp.loop_result.finalText, toolCalls: mvp.loop_result.toolCalls } } : {}),
        query: anthropicMessagesQuery,
        channel_id: 'gs-ali',
      })
      log('终验结果:', post.verdict, JSON.stringify(post.test_result ?? {}).slice(0, 220))
      // 经验库增量
      const ledgerPath = join(home, 'bloma-experience.jsonl')
      if (existsSync(ledgerPath)) {
        for (const line of readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
          const c = JSON.parse(line)
          log('账本卡:', c.kind, c.status, c.tag, 'r=' + c.recurrence, '|', String(c.body?.symptom ?? c.body?.capability ?? '').slice(0, 80))
        }
      } else {
        log('账本无新卡（正常路径=零写卡，成立即负样例）')
      }
      log('事件类型分布:', JSON.stringify([...new Set(events.map((e) => e.type))].slice(0, 20)))
      void p
      expect(post.verdict).toBeTruthy()
    },
  )
})
