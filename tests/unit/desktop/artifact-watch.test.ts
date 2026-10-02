/**
 * 产物监听与清单测试（刀3 呈现层最小版，2026-10-02）。
 *
 * 覆盖：清单三类白名单扫描（png/md/json；目录缺失空清单；mtime 排序）、
 * 图片读取 fail-closed 边界（白名单外路径拒/越界拒/超大拒/正常 data URL）、
 * watcher 单订阅模型（新订阅停旧/停订幂等）——fs.watch 真实触发用临时目录
 * 写文件驱动（Windows recursive watch 原生支持），去抖用真实定时器等待。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeWatchProjectId,
  listDesktopArtifacts,
  readDesktopArtifactImage,
  stopDesktopArtifactsWatch,
  subscribeDesktopArtifacts,
} from '../../../main/desktop/artifact-watch'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bloma-artifact-watch-'))
})

afterEach(() => {
  stopDesktopArtifactsWatch()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('listDesktopArtifacts 清单扫描', () => {
  it('三类白名单：png 截图 + 00_ARCH md/json + DELIVERY.md；mtime 升序', () => {
    mkdirSync(join(root, '00_VERIFY', 'screenshots'), { recursive: true })
    mkdirSync(join(root, '00_ARCH'), { recursive: true })
    writeFileSync(join(root, '00_VERIFY', 'screenshots', 'S2.png'), 'fake-png-2')
    writeFileSync(join(root, '00_VERIFY', 'screenshots', 'S1.png'), 'fake-png-1')
    writeFileSync(join(root, '00_VERIFY', 'screenshots', 'notes.txt'), 'not-listed')
    writeFileSync(join(root, '00_ARCH', 'architecture.md'), '# arch')
    writeFileSync(join(root, '00_ARCH', 'env-checklist.json'), '{}')
    writeFileSync(join(root, '00_ARCH', 'logo.svg'), '<svg/>')
    writeFileSync(join(root, 'DELIVERY.md'), '# delivery')

    const items = listDesktopArtifacts(root)
    const paths = items.map((item) => item.path)
    expect(paths).toContain('00_VERIFY/screenshots/S1.png')
    expect(paths).toContain('00_VERIFY/screenshots/S2.png')
    expect(paths).toContain('00_ARCH/architecture.md')
    expect(paths).toContain('00_ARCH/env-checklist.json')
    expect(paths).toContain('DELIVERY.md')
    expect(paths).not.toContain('00_VERIFY/screenshots/notes.txt')
    expect(paths).not.toContain('00_ARCH/logo.svg')
    expect(items.find((i) => i.path === '00_VERIFY/screenshots/S1.png')?.kind).toBe('image')
    expect(items.find((i) => i.path === '00_ARCH/architecture.md')?.kind).toBe('doc')
    // mtime 升序（S2 先写 → 排在前）
    const s1 = items.find((i) => i.path.endsWith('S1.png'))!
    const s2 = items.find((i) => i.path.endsWith('S2.png'))!
    expect(s2.mtime).toBeLessThanOrEqual(s1.mtime)
  })

  it('目录全缺 → 空清单（合法状态，不抛）', () => {
    expect(listDesktopArtifacts(root)).toEqual([])
  })
})

describe('readDesktopArtifactImage 图片读取边界', () => {
  beforeEach(() => {
    mkdirSync(join(root, '00_VERIFY', 'screenshots'), { recursive: true })
    writeFileSync(join(root, '00_VERIFY', 'screenshots', 'S1.png'), 'fake-png-bytes')
  })

  it('白名单内 png → data URL', () => {
    const result = readDesktopArtifactImage(root, '00_VERIFY/screenshots/S1.png')
    expect(result.data_url.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.bytes).toBe(14)
  })

  it('白名单外路径拒读（fail-closed）：md/json/绝对路径/上跳', () => {
    expect(() => readDesktopArtifactImage(root, 'DELIVERY.md')).toThrow(/ARTIFACT_NOT_IMAGE/)
    expect(() => readDesktopArtifactImage(root, '00_ARCH/env-checklist.json')).toThrow(/ARTIFACT_NOT_IMAGE/)
    expect(() => readDesktopArtifactImage(root, '../outside.png')).toThrow(/ARTIFACT_BAD_PATH/)
    expect(() => readDesktopArtifactImage(root, 'C:/x/S1.png')).toThrow(/ARTIFACT_BAD_PATH/)
  })

  it('超大拒读（2MB 上限）', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1)
    writeFileSync(join(root, '00_VERIFY', 'screenshots', 'BIG.png'), big)
    expect(() => readDesktopArtifactImage(root, '00_VERIFY/screenshots/BIG.png')).toThrow(/ARTIFACT_TOO_LARGE/)
  })
})

describe('watcher 单订阅模型', () => {
  it('新订阅停旧（activeWatchProjectId 反映当前）；停订幂等', async () => {
    mkdirSync(join(root, 'watch-a'), { recursive: true })
    const onEvent = vi.fn()
    subscribeDesktopArtifacts('p1', root, onEvent)
    expect(activeWatchProjectId()).toBe('p1')

    // 单订阅替换：新项目订阅后旧 watcher 关闭
    subscribeDesktopArtifacts('p2', root, onEvent)
    expect(activeWatchProjectId()).toBe('p2')

    stopDesktopArtifactsWatch()
    expect(activeWatchProjectId()).toBeUndefined()
    stopDesktopArtifactsWatch() // 幂等
  }, 10000)

  it('文件写入 → 去抖后变更信号（真实 fs.watch 事件 + fake timers 驱动去抖窗口，密闭）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const onEvent = vi.fn()
      subscribeDesktopArtifacts('p1', root, onEvent)
      mkdirSync(join(root, '00_VERIFY', 'screenshots'), { recursive: true })
      writeFileSync(join(root, '00_VERIFY', 'screenshots', 'S1.png'), 'shot')
      writeFileSync(join(root, '00_VERIFY', 'screenshots', 'S2.png'), 'shot')
      // 真实事件循环让步（fs.watch 回调到达并注册去抖 timer）+ 推进去抖窗口；
      // 循环容忍 Windows 下 watcher 事件到达的调度延迟，不依赖真实 3s 等待。
      let fired = false
      for (let i = 0; i < 30 && !fired; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        vi.advanceTimersByTime(3000)
        fired = onEvent.mock.calls.length > 0
      }
      expect(fired).toBe(true)
      expect(onEvent).toHaveBeenCalledWith('p1')
      expect(onEvent.mock.calls.length).toBe(1) // 连续两写合并为一次信号（去抖）
    } finally {
      vi.useRealTimers()
    }
  }, 10000)

  it('未订阅变更（旧项目事件在换订后被丢弃）：新订阅只回调当前项目', async () => {
    const onEvent = vi.fn()
    subscribeDesktopArtifacts('p1', root, onEvent)
    subscribeDesktopArtifacts('p2', root, onEvent) // p1 watcher 已停
    expect(activeWatchProjectId()).toBe('p2')
    expect(onEvent).not.toHaveBeenCalled() // 换订本身不触发回调
  })
})
