import { restorePromaHome } from '../../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendLoopLogDocument,
  listDocuments,
  syncDocuments,
} from '../../../main/project/document-engine'
import { createProject, recordSketchGenerated } from '../../../main/project/project-service'
import { getDocumentsDir } from '../../../storage/config-paths'

/**
 * P3 任务级三文档契约 · PR-B：loop-log append-only 过程日志。
 * 关键锁定（实施稿 §6 PR-B 测试清单）：
 * - 会话分节追加（迭代重跑新分节不覆盖历史）+ 轮次行/终态节格式；
 * - stale 豁免：type 'loop_log' 条目在多次 checkpoint 同步后仍 synced、文件内容不被触碰（硬约束 7）；
 * - BLOMA_LOOP_LOG 开关矩阵；
 * - 清单登记幂等（按 path 去重）。
 */

describe('appendLoopLogDocument — append-only 过程日志', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalLoopLog = process.env.BLOMA_LOOP_LOG
  let projectId = ''
  let dir = ''

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'proma-looplog-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-looplog', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    projectId = project.project_id
    dir = getDocumentsDir(project.workspace_slug, project.project_id)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalLoopLog === undefined) delete process.env.BLOMA_LOOP_LOG
    else process.env.BLOMA_LOOP_LOG = originalLoopLog
  })

  function readLog(): string {
    return readFileSync(join(dir, 'loop-log.md'), 'utf8')
  }

  it('首次写：文档头 + 会话头（mode/maxTurns/plan 摘要行）+ 轮次行 + 终态节', () => {
    appendLoopLogDocument(projectId, {
      kind: 'session_start',
      mode: 'longterm',
      maxTurns: 40,
      planSummary: '2 个目标文件：index.html、src/app.js',
      label: 'MVP 生成',
    })
    appendLoopLogDocument(projectId, {
      kind: 'turn',
      turn: 1,
      toolCalls: [
        { name: 'write_file', path: 'src/app.js' },
        { name: 'run_gwt_tests' },
      ],
      inputTokens: 100,
      outputTokens: 20,
    })
    appendLoopLogDocument(projectId, { kind: 'final', status: 'completed', turns: 3, toolCalls: 5 })

    const log = readLog()
    expect(log).toContain('# Agent Loop 过程记录（loop-log）')
    expect(log).toContain('append-only')
    expect(log).toContain('## MVP 生成（')
    expect(log).toContain('- 模式：longterm｜轮次上限：40')
    expect(log).toContain('- 技术合同：2 个目标文件：index.html、src/app.js')
    expect(log).toContain('- 轮 1：write_file(src/app.js) → run_gwt_tests ｜ tokens in 100/out 20')
    expect(log).toContain('### 终态：completed（3 轮 / 5 次工具调用）')
  })

  it('plan 未生成时会话头如实标注；无 tokens 的轮次行省略 tokens 段；空工具轮兜底文案', () => {
    appendLoopLogDocument(projectId, { kind: 'session_start', mode: 'quick', maxTurns: 24, planSummary: null })
    appendLoopLogDocument(projectId, { kind: 'turn', turn: 2, toolCalls: [] })
    const log = readLog()
    expect(log).toContain('- 技术合同：未生成（plan 腿关闭或失败）')
    expect(log).toContain('- 轮 2：（无工具调用）')
    expect(log).not.toContain('tokens')
  })

  it('迭代重跑新会话分节（append-only，历史轮次在盘）+ 清单登记幂等', () => {
    appendLoopLogDocument(projectId, { kind: 'session_start', mode: 'quick', maxTurns: 24, label: 'MVP 生成' })
    appendLoopLogDocument(projectId, { kind: 'turn', turn: 1, toolCalls: [{ name: 'write_file', path: 'index.html' }] })
    appendLoopLogDocument(projectId, { kind: 'final', status: 'completed', turns: 1, toolCalls: 1 })

    appendLoopLogDocument(projectId, { kind: 'session_start', mode: 'quick', maxTurns: 24, label: '迭代重生成' })
    appendLoopLogDocument(projectId, { kind: 'turn', turn: 1, toolCalls: [{ name: 'edit_file', path: 'src/app.js' }] })
    appendLoopLogDocument(projectId, { kind: 'final', status: 'cancelled', turns: 1, toolCalls: 1 })

    const log = readLog()
    // 历史（第一会话）原样保留——崩溃/取消续写口径的静态面
    expect(log.indexOf('## MVP 生成')).toBeLessThan(log.indexOf('## 迭代重生成'))
    expect(log).toContain('- 轮 1：write_file(index.html)')
    expect(log).toContain('- 轮 1：edit_file(src/app.js)')
    // cancelled 如实写终态节（硬约束 7）
    expect(log).toContain('### 终态：cancelled（1 轮 / 1 次工具调用）')
    // 文档头只出现一次
    expect(log.match(/# Agent Loop 过程记录/g)).toHaveLength(1)

    // 清单幂等：只有一条 loop_log 条目，status synced
    const loopLogDocs = listDocuments(projectId).filter((doc) => doc.type === 'loop_log')
    expect(loopLogDocs).toHaveLength(1)
    expect(loopLogDocs[0].status).toBe('synced')
  })

  it('stale 豁免锁定：多次 checkpoint 同步后 loop_log 条目仍 synced、文件内容不被触碰', () => {
    appendLoopLogDocument(projectId, { kind: 'session_start', mode: 'quick', maxTurns: 24 })
    const before = readLog()

    syncDocuments({ request_id: 'r', session_id: 's', project_id: projectId, checkpoint: 'sketch_confirmed' })
    syncDocuments({ request_id: 'r', session_id: 's', project_id: projectId, checkpoint: 'mvp_before_generation' })
    syncDocuments({ request_id: 'r', session_id: 's', project_id: projectId, checkpoint: 'mvp_tested' })
    syncDocuments({ request_id: 'r', session_id: 's', project_id: projectId, checkpoint: 'iteration_completed' })

    const entry = listDocuments(projectId).find((doc) => doc.type === 'loop_log')
    expect(entry?.status).toBe('synced')
    // append-only：同步不触碰过程日志内容
    expect(readLog()).toBe(before)
  })
})

describe('P2a 终态节真实出口原因标注（degenerate_output）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let projectId = ''
  let dir = ''

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'proma-looplog-p2a-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-looplog-p2a', mode: 'quick' })
    projectId = project.project_id
    dir = getDocumentsDir(project.workspace_slug, project.project_id)
  })
  afterEach(() => restorePromaHome(originalPromaHome))

  it('final 携带 terminationReason → 终态行追加标注；缺省不带（字节级现状）', () => {
    appendLoopLogDocument(projectId, { kind: 'final', status: 'turn_limit', turns: 37, toolCalls: 60, terminationReason: 'degenerate_output（末轮输出退化，非轮数耗尽）' })
    let log = readFileSync(join(dir, 'loop-log.md'), 'utf8')
    expect(log).toContain('### 终态：turn_limit（37 轮 / 60 次工具调用）｜degenerate_output（末轮输出退化，非轮数耗尽）')
    appendLoopLogDocument(projectId, { kind: 'final', status: 'completed', turns: 3, toolCalls: 5 })
    log = readFileSync(join(dir, 'loop-log.md'), 'utf8')
    expect(log).toContain('### 终态：completed（3 轮 / 5 次工具调用）\n')
  })
})
