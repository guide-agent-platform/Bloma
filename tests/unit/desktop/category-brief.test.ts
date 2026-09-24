/**
 * 桌面品类底稿测试（批次 B，2026-09-24）。
 *
 * 覆盖：双路径矩阵结构、组件清单证据等级、坑库三级证据纪律（[实证] 必带
 * testedAt/command）、2026-09-24 Windows 六项实测回填完整性、查询函数。
 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_COMPONENTS,
  DESKTOP_PITS,
  DESKTOP_ROUTES,
  EVIDENCE_LABEL,
  componentsByEvidence,
  evidenceSummary,
  findPits,
  type DesktopPit,
} from '../../../main/desktop/category-brief'

describe('双路径矩阵', () => {
  it('P1/P2 两路径，P1 实证、P2 待 Spike（未验证路径不可默认交付）', () => {
    expect(DESKTOP_ROUTES.map((r) => r.id)).toEqual(['p1-python-rapid', 'p2-tauri-native'])
    expect(DESKTOP_ROUTES[0].evidence).toBe('field-tested')
    expect(DESKTOP_ROUTES[1].evidence).toBe('spike-required')
  })

  it('每条路径 when/stack/risks 非空（选型权衡三要素齐备）', () => {
    for (const route of DESKTOP_ROUTES) {
      expect(route.when.length, route.id).toBeGreaterThan(10)
      expect(route.stack.length, route.id).toBeGreaterThan(0)
      expect(route.risks.length, route.id).toBeGreaterThan(0)
    }
  })

  it('P1 栈含六项实测组件', () => {
    const stack = DESKTOP_ROUTES[0].stack.join(' ')
    for (const keyword of ['pystray', 'pynput', 'sounddevice', 'winotify', 'pyinstaller', 'venv']) {
      expect(stack.toLowerCase(), keyword).toContain(keyword.toLowerCase())
    }
  })
})

describe('坑库三级证据纪律', () => {
  it('[实证] 条目必带 testedAt（YYYY-MM-DD）与 command（可复现）', () => {
    for (const pit of DESKTOP_PITS.filter((p) => p.evidence === 'field-tested')) {
      expect(pit.testedAt, pit.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(pit.command, pit.id).toBeTruthy()
    }
  })

  it('非 [实证] 条目不得携带 testedAt（防证据等级漂移）', () => {
    for (const pit of DESKTOP_PITS.filter((p) => p.evidence !== 'field-tested')) {
      expect(pit.testedAt, pit.id).toBeUndefined()
    }
  })

  it('每条坑库条目 id 唯一且 finding/action 非空', () => {
    const ids = new Set(DESKTOP_PITS.map((p) => p.id))
    expect(ids.size).toBe(DESKTOP_PITS.length)
    for (const pit of DESKTOP_PITS) {
      expect(pit.finding.length, pit.id).toBeGreaterThan(5)
      expect(pit.action.length, pit.id).toBeGreaterThan(5)
    }
  })

  it('2026-09-24 Windows 六项实测全部回填为 [实证]', () => {
    const tested = new Set(DESKTOP_PITS.filter((p) => p.evidence === 'field-tested').map((p) => p.id))
    // 六项：python 空壳/venv/pystray/pynput/sounddevice/pyinstaller/winotify（+GBK 噪音）
    for (const id of [
      'win-python-store-shell',
      'win-venv-create',
      'win-pystray-lifecycle',
      'win-pynput-backend-classes',
      'win-sounddevice-wasapi',
      'win-pyinstaller-onefile',
      'win-winotify-toast',
    ]) {
      expect(tested.has(id), id).toBe(true)
    }
    // 实测日期一致
    for (const pit of DESKTOP_PITS.filter((p) => p.id.startsWith('win-') && p.evidence === 'field-tested')) {
      expect(pit.testedAt, pit.id).toBe('2026-09-24')
    }
  })

  it('关键待 Spike 项在册（剪贴板监听/Tauri 工具链）', () => {
    const spikeIds = DESKTOP_PITS.filter((p) => p.evidence === 'spike-required').map((p) => p.id)
    expect(spikeIds).toContain('win-clipboard-change-listen')
    expect(spikeIds).toContain('win-tauri-toolchain')
  })
})

describe('组件清单', () => {
  it('六项实测组件全部 [实证]（与坑库对齐）', () => {
    const byId = new Map(DESKTOP_COMPONENTS.map((c) => [c.id, c]))
    expect(byId.get('python-runtime')?.evidence).toBe('field-tested')
    expect(byId.get('tray-icon')?.pipPackage).toContain('pystray')
    expect(byId.get('global-hotkey')?.evidence).toBe('field-tested')
    expect(byId.get('audio-capture')?.evidence).toBe('field-tested')
    expect(byId.get('toast-notify')?.evidence).toBe('field-tested')
    expect(byId.get('packaging')?.evidence).toBe('field-tested')
  })

  it('组件 id 唯一、notes 非空（预置底稿的信息密度）', () => {
    const ids = new Set(DESKTOP_COMPONENTS.map((c) => c.id))
    expect(ids.size).toBe(DESKTOP_COMPONENTS.length)
    for (const c of DESKTOP_COMPONENTS) {
      expect(c.notes.length, c.id).toBeGreaterThan(10)
    }
  })
})

describe('查询函数', () => {
  it('componentsByEvidence 按等级过滤', () => {
    const tested = componentsByEvidence('field-tested')
    expect(tested.length).toBeGreaterThan(0)
    expect(tested.every((c) => c.evidence === 'field-tested')).toBe(true)
    expect(componentsByEvidence('spike-required').map((c) => c.id)).toContain('clipboard-access')
  })

  it('findPits 关键词命中（id/topic/finding 三路）', () => {
    expect(findPits('venv').length).toBeGreaterThan(0)
    expect(findPits('pystray').some((p: DesktopPit) => p.id === 'win-pystray-lifecycle')).toBe(true)
    expect(findPits('不存在的主题xyz')).toEqual([])
  })

  it('evidenceSummary 计数守恒', () => {
    const summary = evidenceSummary()
    const total = summary['field-tested'] + summary.inferred + summary['spike-required']
    expect(total).toBe(DESKTOP_PITS.length)
  })

  it('EVIDENCE_LABEL 标记形态（进提示词渲染）', () => {
    expect(EVIDENCE_LABEL['field-tested']).toBe('[实证]')
    expect(EVIDENCE_LABEL.inferred).toBe('[推断]')
    expect(EVIDENCE_LABEL['spike-required']).toBe('待Spike')
  })
})
