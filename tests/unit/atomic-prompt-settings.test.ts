import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPromptSlot, savePromptSlot } from '../../main/agent/prompting/prompt-service'
import { restorePromaHome } from '../support/proma-home-guard'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

describe('提示词保存失败保留旧内容', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), 'bloma-prompt-atomic-'))
    process.env.PROMA_HOME = home
  })
  afterEach(() => {
    vi.restoreAllMocks()
    restorePromaHome(originalHome)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it('原子替换失败时原配置未变，临时文件清理；再次保存成功后即时读取新版', () => {
    savePromptSlot('loop-system', '原有规则')
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('file busy'), { code: 'EPERM' }) })
    expect(() => savePromptSlot('loop-system', '新的规则')).toThrow('file busy')
    expect(readPromptSlot('loop-system').content).toBe('原有规则')
    expect(fs.readdirSync(join(home, 'prompts'))).toEqual(['loop-system.md'])
    savePromptSlot('loop-system', '新的规则')
    expect(readPromptSlot('loop-system').content).toBe('新的规则')
  })
})
