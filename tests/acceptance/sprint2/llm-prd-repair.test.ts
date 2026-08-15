import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generatePrdLlm } from '../../../main/prd-engine-llm'
import { generateMvpLlm } from '../../../main/mvp-engine-llm'
import { buildPrdBackplane } from '../../../main/document-engine'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import { createProject, findProject, recordSketchGenerated } from '../../../main/project-service'
import type { SDKMessage } from '../../../shared/types'
import type { SDKQuery } from '../../../main/orchestrator'

/**
 * Sprint 2 补充验收 · PRD 从对话提取（PRD §7.1）+ 修复分析错误原因（self-healing @S2-JUDGE-001）。
 *
 * 文档依据：
 * - sprint-plan.md §5 / PRD §7.1：草图确认后「从对话提取并生成 PRD 初稿」
 * - self-healing-judge.feature @S2-JUDGE-001：编程 Agent 自动分析错误原因
 *
 * 此处只验证 LLM 提取路径的契约（从对话提炼定位/验收/范围外），确定性模板兜底
 * 已由 S2-PROJECT-001 / S2-JUDGE-001 覆盖。修复 LLM 复用 mvp-engine-llm 的 repairContext
 * 注入，由下方测试验证「错误原因进入生成 prompt」。
 */
describe('Sprint 2 LLM PRD extraction + repair cause analysis', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) {
      const { rmSync } = require('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
  })

  function queryReturning(text: string): SDKQuery {
    return async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
      yield { type: 'result', subtype: 'success' }
    }
  }

  function setup(prefix: string): string {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 's2-prd', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
    ])
    return project.project_id
  }

  it('[PRD-LLM] 从对话历史提取 PRD 背板（定位/验收/范围外）', async () => {
    const projectId = setup('bloma-s2-prd-llm-')
    // 模拟澄清阶段的会话历史（用户提出需求 + 助手确认）
    appendJsonLine(getAgentSessionPath('s2-session'), {
      role: 'user',
      content: [{ type: 'text', text: '我想做一个家庭记账本，能记收入和支出，月底看结余' }],
      timestamp: Date.now(),
    })
    appendJsonLine(getAgentSessionPath('s2-session'), {
      role: 'assistant',
      content: [{ type: 'text', text: '好的，我帮你整理成家庭记账本。' }],
      timestamp: Date.now(),
    })

    const prdJson = JSON.stringify({
      positioning: '家庭记账本：记录收支并展示结余',
      acceptance: {
        'F-001': '能新增一笔收入或支出并保存',
        'F-002': '按自然月汇总并显示结余金额',
      },
      out_of_scope: ['多用户协作', '银行账户对接'],
      assumptions: ['金额单位统一为人民币'],
    })

    const backplane = await generatePrdLlm({
      project_id: projectId,
      session_id: 's2-session',
      requirements: [
        { id: 'F-001', description: '记录收入与支出' },
        { id: 'F-002', description: '展示本月结余' },
      ],
      query: queryReturning(prdJson),
      env: { PATH: 'x' },
    })

    expect(backplane).not.toBeNull()
    expect(backplane?.positioning).toBe('家庭记账本：记录收支并展示结余')
    expect(backplane?.acceptance['F-001']).toBe('能新增一笔收入或支出并保存')
    expect(backplane?.out_of_scope).toEqual(['多用户协作', '银行账户对接'])
    // 功能项保持冻结清单不变（F-001 主题锚点不被 LLM 改写）
    expect(backplane?.requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
  })

  it('[PRD-LLM] 无对话历史时返回 null（交由模板兜底）', async () => {
    const projectId = setup('bloma-s2-prd-fallback-')
    const backplane = await generatePrdLlm({
      project_id: projectId,
      session_id: 's2-session-empty',
      requirements: [{ id: 'F-001', description: '记录收入与支出' }],
      query: queryReturning('{}'),
      env: { PATH: 'x' },
    })
    expect(backplane).toBeNull()
  })

  it('[PRD-LLM] 模型返回非 PRD JSON 时优雅降级为默认验收', async () => {
    const projectId = setup('bloma-s2-prd-degrade-')
    appendJsonLine(getAgentSessionPath('s2-session-bad'), {
      role: 'user',
      content: [{ type: 'text', text: '做一个记账工具' }],
      timestamp: Date.now(),
    })
    // 模型吐了 MVP 形态的 JSON（字段不匹配），应回退到默认验收而非抛错
    const backplane = await generatePrdLlm({
      project_id: projectId,
      session_id: 's2-session-bad',
      requirements: [{ id: 'F-001', description: '记录收入与支出' }],
      query: queryReturning(JSON.stringify({ files: [], run_command: 'npm start' })),
      env: { PATH: 'x' },
    })
    expect(backplane).not.toBeNull()
    expect(backplane?.positioning).toBe('记录收入与支出')
    expect(backplane?.acceptance['F-001']).toContain('核心路径可交互')
  })

  it('[REPAIR-LLM] 修复上下文（错误原因）注入生成 prompt，供模型分析修复', async () => {
    const projectId = setup('bloma-s2-repair-llm-')
    const project = findProject(projectId)
    const requirements = [{ id: 'F-001', description: '记录收入与支出' }]
    const backplane = buildPrdBackplane(project, requirements, 'mvp_before_generation')

    let capturedPrompt = ''
    const query: SDKQuery = async function* (prompt: string) {
      capturedPrompt = prompt
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                files: [{ path: 'index.html', content: '<html></html>' }],
                run_command: 'npm start',
                assumptions: [],
                risks: [],
              }),
            },
          ],
        },
      }
      yield { type: 'result', subtype: 'success' }
    }

    await generateMvpLlm({
      project_id: projectId,
      backplane,
      query,
      env: { PATH: 'x' },
      sessionId: 's2-session',
      repairContext: { category: 'runtime_error', error: 'ReferenceError: foo is not defined' },
    })

    expect(capturedPrompt).toContain('修复上下文')
    expect(capturedPrompt).toContain('runtime_error')
    expect(capturedPrompt).toContain('ReferenceError: foo is not defined')
  })
})
