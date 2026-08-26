import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendProjectLearning, readRecentLearnings, renderLearningsSection } from '../../main/learnings-log'
import { createProject } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

/**
 * 执行经验日志（2026-08-26 改造 2，ralph progress.txt 等价物）：
 * - append/read 往返：文本截断 300、limit 取最近 N 条、损坏行跳过
 * - renderLearningsSection：无经验空串（首轮零开销）；有经验渲染【历史经验】段（单条截 120）
 * - 静默失败：项目缺失/文件 IO 异常不抛错（增强腿）
 */

describe('learnings-log（执行经验沉淀）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function setup(): { projectId: string; path: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-learnings-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    return {
      projectId: project.project_id,
      path: join(getDocumentsDir(project.workspace_slug, project.project_id), 'learnings.jsonl'),
    }
  }

  it('append → read 往返：最近 N 条、长文本截断、meta 保留', () => {
    const { projectId } = setup()
    appendProjectLearning(projectId, {
      kind: 'loop_summary',
      text: 'a'.repeat(500),
      meta: { status: 'completed', turns: 17 },
    })
    appendProjectLearning(projectId, { kind: 'loop_outcome', text: '第二轮：预算耗尽，GWT 场景 3 始终未过' })

    const recent = readRecentLearnings(projectId, 5)
    expect(recent).toHaveLength(2)
    expect(recent[0].text).toHaveLength(300)
    expect(recent[0].meta).toMatchObject({ turns: 17 })
    expect(recent[1].kind).toBe('loop_outcome')

    // limit 只取最近
    expect(readRecentLearnings(projectId, 1)).toHaveLength(1)
    expect(readRecentLearnings(projectId, 1)[0].text).toContain('预算耗尽')
  })

  it('损坏行跳过：部分 JSONL 行解析失败不影响其余条目', () => {
    const { projectId, path } = setup()
    appendProjectLearning(projectId, { kind: 'note', text: '完好条目' })
    writeFileSync(path, '{broken json\n', { flag: 'a' })
    appendProjectLearning(projectId, { kind: 'note', text: '另一条完好' })

    const recent = readRecentLearnings(projectId, 10)
    expect(recent.map((entry) => entry.text)).toEqual(['完好条目', '另一条完好'])
  })

  it('renderLearningsSection：无经验返回空串；有经验渲染注入段且单条截 120', () => {
    const { projectId } = setup()
    expect(renderLearningsSection(projectId)).toBe('')

    appendProjectLearning(projectId, { kind: 'loop_summary', text: 'b'.repeat(400) })
    appendProjectLearning(projectId, { kind: 'loop_outcome', text: '用户中途停止，产物只到一半' })

    const section = renderLearningsSection(projectId)
    expect(section).toContain('【历史经验】')
    expect(section).toContain('[完成总结]')
    expect(section).toContain('b'.repeat(120))
    expect(section).toContain('用户中途停止')
    // 首轮生成（无文件）零开销语义：全新项目返回空串
    const home = mkdtempSync(join(tmpdir(), 'proma-learnings-empty-'))
    process.env.PROMA_HOME = home
    const fresh = createProject({ request_id: 'req-fresh', mode: 'quick' })
    expect(renderLearningsSection(fresh.project_id)).toBe('')
  })

  it('静默失败：项目缺失 → null / 空数组，不抛错', () => {
    expect(appendProjectLearning('no-such-project', { kind: 'note', text: 'x' })).toBeNull()
    expect(readRecentLearnings('no-such-project')).toEqual([])
  })

  it('JSONL 逐行落盘（append-only，不整文件重写）', () => {
    const { projectId, path } = setup()
    appendProjectLearning(projectId, { kind: 'note', text: '第一条' })
    const afterFirst = readFileSync(path, 'utf8')
    appendProjectLearning(projectId, { kind: 'note', text: '第二条' })
    const afterSecond = readFileSync(path, 'utf8')
    // 追加不重写：首行字节不变，末尾新增一行
    expect(afterSecond.startsWith(afterFirst)).toBe(true)
    const lines = afterSecond.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('第一条')
    expect(lines[1]).toContain('第二条')
  })
})
