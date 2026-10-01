import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'

// 规则引擎固定 pass（本文件只测状态回写链路）；readArtifactText 保真实实现
vi.mock('../../main/review/judge-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/review/judge-engine')>()
  return {
    ...actual,
    runJudge: vi.fn((): import('../../main/review/judge-engine').JudgeVerdict => ({
      verdict: 'pass',
      hard_constraints: [],
      soft_constraints: [],
      user_visible_summary: '规则全绿',
      repairable: false,
    })),
  }
})
vi.mock('../../main/platform/llm/runtime-fallback', () => ({
  // 类别路由固定给出可用 env（语义腿必跑，判定才会回写）
  resolveChannelEnv: vi.fn(() => ({ env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://example.com' }, channel: { id: 'ch-1' } })),
}))

import { runJudgeReview, setProgrammingEventPublisher } from '../../main/coding/programming-orchestrator'
import { syncDocuments, updateRequirementStatus, markPrdUserConfirmed } from '../../main/project/document-engine'
import { createProject, findProject, recordSketchGenerated } from '../../main/project/project-service'
import { getDocumentsDir } from '../../storage/config-paths'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'
import type { SDKQuery } from '../../main/orchestration/orchestrator'

/**
 * 活背板（2026-08-26，ralph 式 passes）：
 * - updateRequirementStatus：判定回写 prd.json（status/status_note），其余字段原样保留；
 *   空 updates / 无 prd.json / 损坏 → null 不抛错；未知 id 忽略
 * - 迭代重生成：syncPrdCheckpoints 重写 prd.json 时 status 自然清除（新产物未判定）
 * - 渲染：implemented 勾选 [x]，非 implemented 以中文标签标注
 * - wiring：evaluateOnce 拿到判定后回写——pass 与 return 路径都回写，skipped 不回写
 */

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '记录日常收支', priority: 'P0' },
  { id: 'F-002', description: '按月汇总统计', priority: 'P1' },
]

describe('updateRequirementStatus（document-engine）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function setupProject(): { projectId: string; prdPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, requirements)
    // prd.json 由 requirement_confirmed / sketch_confirmed 检查点写盘（mvp_before_generation 只写 md+GWT 骨架）
    syncDocuments({ request_id: 'req-prd', project_id: project.project_id, session_id: 'session-1', checkpoint: 'sketch_confirmed' })
    const prdPath = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    return { projectId: project.project_id, prdPath }
  }

  it('回写 status/status_note，保留需求内容与未判定项；未知 id 忽略', () => {
    const { projectId, prdPath } = setupProject()
    const before = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(before.requirements).toHaveLength(2)

    const updated = updateRequirementStatus(projectId, [
      { requirement_id: 'F-001', status: 'implemented', evidence: 'addEntry() in src/app.js' },
      { requirement_id: 'F-999', status: 'missing', evidence: '幻觉 id' },
    ])

    expect(updated).not.toBeNull()
    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.requirements.find((item) => item.id === 'F-001')).toMatchObject({
      status: 'implemented',
      status_note: 'addEntry() in src/app.js',
    })
    // 未判定项不携带 status；定位/需求内容原样保留（回写不触碰需求语义）
    expect(after.requirements.find((item) => item.id === 'F-002')?.status).toBeUndefined()
    expect(after.positioning).toBe(before.positioning)
    expect(after.requirements).toHaveLength(before.requirements.length)
  })

  it('空 updates / 无 prd.json / 损坏 prd.json → null 不抛错', () => {
    const { projectId, prdPath } = setupProject()
    expect(updateRequirementStatus(projectId, [])).toBeNull()

    writeFileSync(prdPath, '{broken json', 'utf8')
    expect(updateRequirementStatus(projectId, [{ requirement_id: 'F-001', status: 'implemented' }])).toBeNull()

    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-none-'))
    process.env.PROMA_HOME = home
    const empty = createProject({ request_id: 'req-empty', mode: 'quick' })
    expect(updateRequirementStatus(empty.project_id, [{ requirement_id: 'F-001', status: 'implemented' }])).toBeNull()
  })

  it('markPrdUserConfirmed：user_confirmed_at 落盘且其余字段原样保留；无 prd.json → null', () => {
    const { projectId, prdPath } = setupProject()
    const confirmed = markPrdUserConfirmed(projectId)

    expect(confirmed?.user_confirmed_at).toBeTruthy()
    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.user_confirmed_at).toBe(confirmed?.user_confirmed_at)
    expect(after.requirements.find((item) => item.id === 'F-001')?.description).toBe('记录日常收支')

    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-noconfirm-'))
    process.env.PROMA_HOME = home
    const empty = createProject({ request_id: 'req-empty2', mode: 'quick' })
    expect(markPrdUserConfirmed(empty.project_id)).toBeNull()
  })

  it('迭代全量重生成：syncDocuments 重写 prd.json 后 status 自然清除', () => {
    const { projectId, prdPath } = setupProject()
    updateRequirementStatus(projectId, [
      { requirement_id: 'F-001', status: 'implemented', evidence: 'done' },
      { requirement_id: 'F-002', status: 'partial', evidence: '半成品' },
    ])
    // 迭代重生成走 sketch_confirmed 检查点重写 prd.json（requirements 来自项目存储，无 status）
    syncDocuments({ request_id: 'req-iter', project_id: projectId, session_id: 'session-1', checkpoint: 'sketch_confirmed' })
    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.requirements.every((item) => item.status === undefined)).toBe(true)
  })

  it('渲染：implemented 勾选 [x]；partial 以中文标签标注', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-render-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const backplane: PrdBackplane = {
      project_id: project.project_id,
      name: project.name,
      positioning: '个人记账工具',
      requirements: [
        { ...requirements[0], status: 'implemented', status_note: '已验证' },
        { ...requirements[1], status: 'partial', status_note: '只有列表' },
      ],
      acceptance: {},
      out_of_scope: ['不做登录'],
      assumptions: [],
    }
    syncDocuments(
      { request_id: 'req-prd', project_id: project.project_id, session_id: 'session-1', checkpoint: 'sketch_confirmed' },
      backplane,
    )
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const markdown = readFileSync(join(dir, 'sketch_confirmed.md'), 'utf8')
    expect(markdown).toContain('- [x] **F-001**（P0）')
    expect(markdown).toContain('- [ ] **F-002**（P1）按月汇总统计（部分实现）')
    // 勾选态也物化进 prd.json（活背板单一真相源）
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8')) as PrdBackplane
    expect(prd.requirements[0].status).toBe('implemented')
  })
})

describe('runJudgeReview wiring：判定回写活背板', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  let project: ReturnType<typeof createProject>
  let prdPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-req-status-judge-'))
    process.env.PROMA_HOME = home
    project = createProject({ request_id: 'req-project', mode: 'quick' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><button id="add">记一笔</button></body></html>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), 'function addEntry(){}\n', 'utf8')
    recordSketchGenerated(project.project_id, requirements)
    syncDocuments({ request_id: 'req-prd', project_id: project.project_id, session_id: 'session-st', checkpoint: 'requirement_confirmed' })
    prdPath = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    setProgrammingEventPublisher(() => undefined)
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setProgrammingEventPublisher(() => undefined)
    vi.restoreAllMocks()
  })

  function scriptedQuery(response: string): SDKQuery {
    return async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: response }] } }
      yield { type: 'result', subtype: 'success' }
    }
  }

  it('语义全绿 → ready 且判定回写 prd.json', async () => {
    const query = scriptedQuery(
      JSON.stringify({
        findings: requirements.map((item) => ({ requirement_id: item.id, status: 'implemented', evidence: 'ok' })),
      }),
    )
    const result = await runJudgeReview({
      request_id: 'req-j1',
      session_id: 'session-st',
      project_id: project.project_id,
      repairInternalized: true,
      query,
      channel_id: 'ch-1',
    })

    expect(result.outcome).toBe('ready')
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(prd.requirements.every((item) => item.status === 'implemented')).toBe(true)
  })

  it('语义失败 → return/blocked，判定依然回写（partial 状态用户可见）', async () => {
    const query = scriptedQuery(
      JSON.stringify({
        findings: [
          { requirement_id: 'F-001', status: 'implemented', evidence: 'addEntry()' },
          { requirement_id: 'F-002', status: 'partial', evidence: '只有列表无汇总' },
        ],
      }),
    )
    const result = await runJudgeReview({
      request_id: 'req-j2',
      session_id: 'session-st',
      project_id: project.project_id,
      loop: { status: 'completed', turns: 5, finalText: '', toolCalls: [] },
      repairInternalized: true,
      query,
      channel_id: 'ch-1',
    })

    // P1 partial → major → return；loop 路径首败让渡 blocked
    expect(result.outcome).toBe('blocked')
    expect(findProject(project.project_id).judge_return_count).toBe(1)
    // 判定回写发生在裁决分支之前，退回路径同样落盘
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(prd.requirements.find((item) => item.id === 'F-002')).toMatchObject({ status: 'partial' })
    expect(prd.requirements.find((item) => item.id === 'F-001')).toMatchObject({ status: 'implemented' })
  })

  it('skipped（LLM 失败）→ 不回写，prd.json 状态保持未判定', async () => {
    const failing: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      throw new Error('CHANNEL_DOWN')
    }
    const result = await runJudgeReview({
      request_id: 'req-j3',
      session_id: 'session-st',
      project_id: project.project_id,
      repairInternalized: true,
      query: failing,
      channel_id: 'ch-1',
    })

    expect(result.outcome).toBe('ready')
    const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(prd.requirements.every((item) => item.status === undefined)).toBe(true)
    expect(existsSync(prdPath)).toBe(true)
  })
})
