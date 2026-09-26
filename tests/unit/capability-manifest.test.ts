import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureCapabilityManifest, recordCapabilityManifest } from '../../main/coding/capability-manifest'
import { createProject, findProject } from '../../main/project/project-service'
import { getAgentSessionPath } from '../../storage/config-paths'

/**
 * 能力开关 manifest（2026-09-26 运行审计 P2-03）：每 run 持久化真实开关值——
 * 「函数存在」不再等于「现网生效」，未启用的保护能力须在下游可见。
 */

describe('能力开关 manifest（P2-03）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    vi.unstubAllEnvs()
  })

  it('captureCapabilityManifest：真实反映开关值（缺省与显式 on 两态）', () => {
    const defaults = captureCapabilityManifest('s-1')
    expect(defaults.session_id).toBe('s-1')
    expect(defaults.switches.repair_noop_guard).toBe(true) // P1-05 已翻默认 on
    expect(defaults.switches.write_guard).toBe(false) // 仍缺省 off（事实如实，不美化）
    expect(defaults.switches.browser_tools).toBe(false)

    vi.stubEnv('BLOMA_WRITE_GUARD', '1')
    vi.stubEnv('BLOMA_BROWSER_TOOLS', '1')
    const turnedOn = captureCapabilityManifest('s-1')
    expect(turnedOn.switches.write_guard).toBe(true)
    expect(turnedOn.switches.browser_tools).toBe(true)
  })

  it('recordCapabilityManifest：落项目字段 + 决策日志如实列出未启用能力', () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-manifest-'))
    const project = createProject({ request_id: 'req-manifest', mode: 'quick' })
    recordCapabilityManifest(project.project_id, 's-manifest')

    const manifest = findProject(project.project_id).capability_manifest
    expect(manifest).toBeDefined()
    expect(manifest?.session_id).toBe('s-manifest')
    expect(typeof manifest?.switches).toBe('object')

    // recordDecision 落会话 JSONL（[decision] 行；decisions.md 为运行时导出，测试环境未触发）
    const sessionPath = getAgentSessionPath('s-manifest')
    expect(existsSync(sessionPath)).toBe(true)
    const session = readFileSync(sessionPath, 'utf8')
    expect(session).toContain('能力开关 manifest')
    expect(session).toContain('write_guard') // 未启用清单如实列出
  })

  it('fail-open：项目缺失不抛错（可观测性增强不阻断交付链）', () => {
    expect(() => recordCapabilityManifest('nonexistent-project', 's')).not.toThrow()
  })
})
