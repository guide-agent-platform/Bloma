import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  distillProjectMemory,
  isMemoryDistillEnabled,
  readProjectMemory,
  setMemoryDistillEnabledForTests,
} from '../../main/memory-distiller'
import { createChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { createProject, findProject } from '../../main/project-service'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'
import type { SDKMessage } from '../../shared/types'

/**
 * T4-L3 蒸馏层（兜底，2026-08-18 修订版设计）。
 *
 * 锁定行为：
 * - 默认关闭（线上实测 L1/L2 有漏才启用）；
 * - 触发失败三类注入点（报错/超时/产物不合 schema）任一 → 不阻塞主流程、
 *   如实落 T2 决策日志、退回 L2（验收②）；
 * - 蒸馏产物与背板重叠/冲突的条目确定性丢弃，背板为准（验收③）；
 * - memory.json 只存背板装不下的对话性记忆，注入 MVP 提示词为提示级参考。
 */

const originalPromaHome = process.env.PROMA_HOME

function useTempHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'bloma-distill-'))
  process.env.PROMA_HOME = home
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
  createChannel({
    name: 'test-channel',
    provider_type: 'anthropic',
    base_url: 'https://example.test',
    api_key: 'key',
    models: [{ id: 'm1', name: 'model-a', enabled: true }],
  })
}

function seedSession(sessionId: string): void {
  const path = getAgentSessionPath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  const lines = [
    { role: 'user', content: [{ type: 'text', text: '帮我做一个记账应用，不含登录' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: '好的，先确认方向。' }], timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: '上次那种月历视图我不喜欢，界面简单点，数据别上传云端' }], timestamp: 3 },
  ]
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

function memoryPath(projectId: string): string {
  const project = findProject(projectId)
  return join(getDocumentsDir(project.workspace_slug, project.project_id), 'memory.json')
}

function decisionLines(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.includes('memory_distilled'))
}

const VALID_DISTILLED = JSON.stringify({
  rejected_ideas: ['月历视图已被否决'],
  verbal_preferences: ['界面简单点'],
  non_functional_notes: ['数据不上传云端'],
})

describe('T4-L3 蒸馏层 · 开关与成功路径', () => {
  beforeEach(() => {
    useTempHome()
    setMemoryDistillEnabledForTests(true)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setMemoryDistillEnabledForTests(false)
  })

  it('默认关闭：不发起任何模型调用，不产出 memory.json', async () => {
    setMemoryDistillEnabledForTests(false)
    expect(isMemoryDistillEnabled()).toBe(false)
    const project = createProject({ request_id: 'req-off', mode: 'quick', initial_message: '记账本' })
    let queryCalled = false
    const result = await distillProjectMemory({
      project_id: project.project_id,
      session_id: 'session-off',
      query: async function* (): AsyncGenerator<SDKMessage> {
        queryCalled = true
        yield { type: 'result', subtype: 'success' }
      },
    })
    expect(result).toBe(false)
    expect(queryCalled).toBe(false)
    expect(readProjectMemory(project.project_id)).toBeUndefined()
  })

  it('成功：全量 JSONL 蒸馏为 memory.json（三类对话性记忆）', async () => {
    const project = createProject({ request_id: 'req-ok', mode: 'quick', initial_message: '记账应用' })
    seedSession('session-ok')
    const prompts: string[] = []
    const result = await distillProjectMemory({
      project_id: project.project_id,
      session_id: 'session-ok',
      query: async function* (prompt: string): AsyncGenerator<SDKMessage> {
        prompts.push(prompt)
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: VALID_DISTILLED }] } }
        yield { type: 'result', subtype: 'success' }
      },
    })
    expect(result).toBe(true)
    // 蒸馏输入是全量会话（含第 1 轮约束原话），不是窗口历史
    expect(prompts[0]).toContain('不含登录')
    expect(prompts[0]).toContain('月历视图')
    const memory = readProjectMemory(project.project_id)
    expect(memory?.verbal_preferences).toEqual(['界面简单点'])
    expect(memory?.non_functional_notes).toEqual(['数据不上传云端'])
    expect(existsSync(memoryPath(project.project_id))).toBe(true)
  })
})

describe('T4-L3 蒸馏层 · 失败降级（验收②：三类注入点）', () => {
  beforeEach(() => {
    useTempHome()
    setMemoryDistillEnabledForTests(true)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setMemoryDistillEnabledForTests(false)
  })

  it('注入点①报错：不抛出、不产文件、决策日志如实记录', async () => {
    const project = createProject({ request_id: 'req-err', mode: 'quick', initial_message: '记账本' })
    seedSession('session-err')
    await expect(
      distillProjectMemory({
        project_id: project.project_id,
        session_id: 'session-err',
        query: async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('model network error')
        },
      }),
    ).resolves.toBe(false)
    expect(readProjectMemory(project.project_id)).toBeUndefined()
    const lines = decisionLines('session-err')
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('memory_distilled')
    expect(lines[0]).toContain('报错')
  })

  it('注入点②超时：判失败降级并如实记录', async () => {
    const project = createProject({ request_id: 'req-to', mode: 'quick', initial_message: '记账本' })
    seedSession('session-to')
    await expect(
      distillProjectMemory({
        project_id: project.project_id,
        session_id: 'session-to',
        timeoutMs: 20,
        query: async function* (_prompt: string, options): AsyncGenerator<SDKMessage> {
          // 挂起直到 abort：以 AbortError 拒绝，模拟被蒸馏超时掐断的模型调用
          await new Promise<never>((_, reject) => {
            const abortError = (): Error => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              return error
            }
            if (options.signal.aborted) throw abortError()
            options.signal.addEventListener('abort', () => reject(abortError()), { once: true })
          })
          yield { type: 'result', subtype: 'success' }
        },
      }),
    ).resolves.toBe(false)
    expect(readProjectMemory(project.project_id)).toBeUndefined()
    expect(decisionLines('session-to').some((line) => line.includes('超时'))).toBe(true)
  })

  it('注入点③产物不合 schema：判失败降级并如实记录', async () => {
    const project = createProject({ request_id: 'req-schema', mode: 'quick', initial_message: '记账本' })
    seedSession('session-schema')
    await expect(
      distillProjectMemory({
        project_id: project.project_id,
        session_id: 'session-schema',
        query: async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '这不是 JSON' }] } }
          yield { type: 'result', subtype: 'success' }
        },
      }),
    ).resolves.toBe(false)
    expect(readProjectMemory(project.project_id)).toBeUndefined()
    expect(decisionLines('session-schema').some((line) => line.includes('schema'))).toBe(true)
  })

  it('渠道无模型：不启用 L3（不报错、不落失败决策）', async () => {
    // 单渠道无 enabled 模型
    const home = mkdtempSync(join(tmpdir(), 'bloma-distill-nomodel-'))
    process.env.PROMA_HOME = home
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    createChannel({
      name: 'empty-channel',
      provider_type: 'anthropic',
      base_url: 'https://example.test',
      api_key: 'key',
      models: [],
    })
    const project = createProject({ request_id: 'req-nomodel', mode: 'quick', initial_message: '记账本' })
    seedSession('session-nomodel')
    let queryCalled = false
    await expect(
      distillProjectMemory({
        project_id: project.project_id,
        session_id: 'session-nomodel',
        query: async function* (): AsyncGenerator<SDKMessage> {
          queryCalled = true
          yield { type: 'result', subtype: 'success' }
        },
      }),
    ).resolves.toBe(false)
    expect(queryCalled).toBe(false)
    expect(decisionLines('session-nomodel')).toEqual([])
  })
})

describe('T4-L3 蒸馏层 · 单一事实源仲裁（验收③）', () => {
  beforeEach(() => {
    useTempHome()
    setMemoryDistillEnabledForTests(true)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setMemoryDistillEnabledForTests(false)
  })

  it('与背板（约束/范围外/功能项）重叠的蒸馏条目确定性丢弃，背板为准', async () => {
    const project = createProject({ request_id: 'req-dup', mode: 'quick', initial_message: '记账应用' })
    seedSession('session-dup')
    // 背板已承载：约束「不含登录」+ 功能项「记账本」——蒸馏产物重复收录这些即第二份事实源
    const { captureConstraints } = await import('../../main/constraint-extractor')
    captureConstraints({ project_id: project.project_id, session_id: 'session-dup', constraints: ['不含登录'], source: 'guide_gate' })
    const { readLastSketchRequirements, recordSketchGenerated } = await import('../../main/project-service')
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记账本' },
      { id: 'F-002', description: '导出记录' },
    ])
    void readLastSketchRequirements

    const result = await distillProjectMemory({
      project_id: project.project_id,
      session_id: 'session-dup',
      query: async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: JSON.stringify({
                rejected_ideas: ['不含登录的方案'], // 与约束「不含登录」重叠
                verbal_preferences: ['界面简单点', '做一个记账本'], // 后者与功能项 F-001 重叠
                non_functional_notes: ['数据不上传云端'],
              }),
            }],
          },
        }
        yield { type: 'result', subtype: 'success' }
      },
    })
    expect(result).toBe(true)
    const memory = readProjectMemory(project.project_id)
    expect(memory?.rejected_ideas).toEqual([]) // 重叠丢弃
    expect(memory?.verbal_preferences).toEqual(['界面简单点']) // 「做一个记账本」与功能项重叠被丢
    expect(memory?.non_functional_notes).toEqual(['数据不上传云端'])
  })
})
