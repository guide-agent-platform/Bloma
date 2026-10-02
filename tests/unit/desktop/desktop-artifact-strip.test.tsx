// @vitest-environment jsdom
/**
 * 桌面线产物预览条组件测试（刀3 呈现层最小版，2026-10-02）。
 *
 * 锚点 data-ai-id；非 globals 模式 RTL 手动 cleanup；electronAPI mock 注入
 * （subscribe 快照清单 + image data URL）。覆盖：显示判定（桌面线×有产物×项目
 * 匹配）、截图缩略渲染、文档条目 chip。
 */
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, Provider } from 'jotai'
import { currentProjectAtom, desktopArtifactsAtom } from '../../../renderer/agent-atoms'
import { DesktopArtifactStrip } from '../../../renderer/components/DesktopArtifactStrip'

configure({ testIdAttribute: 'data-ai-id' })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { electronAPI?: unknown }).electronAPI
})

function mockElectronApi(overrides: Partial<Record<'subscribe' | 'image' | 'fileRead', unknown>> = {}) {
  const api = {
    desktopArtifacts: {
      subscribe: vi.fn(async () => ({ ok: true, request_id: 'r', data: { items: [] } })),
      image: vi.fn(async () => ({ ok: true, request_id: 'r', data: { data_url: 'data:image/png;base64,QUJD', bytes: 3 } })),
      ...overrides,
    },
    project: {
      fileRead: vi.fn(async () => ({ ok: true, request_id: 'r', data: { content: '# 交付说明\n双击启动', truncated: false, bytes: 100 } })),
    },
  }
  ;(window as { electronAPI?: unknown }).electronAPI = api
  return api
}

function renderStrip(project: Record<string, unknown> | null, artifacts?: { projectId: string | null; items: import('../../../shared/types').DesktopArtifactItemDto[]; version: number }) {
  const store = createStore()
  store.set(currentProjectAtom, project as never)
  store.set(desktopArtifactsAtom, artifacts ?? { projectId: null, items: [], version: 0 })
  return render(
    <Provider store={store}>
      <DesktopArtifactStrip />
    </Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('显示判定', () => {
  it('非桌面线项目 → 不渲染', () => {
    mockElectronApi()
    renderStrip({ project_id: 'p1', template_type: 'web_fullstack' })
    expect(screen.queryByTestId('desktop-artifact-strip')).toBeNull()
  })

  it('桌面线但清单项目不匹配（未订阅本项目的快照）→ 不渲染', () => {
    mockElectronApi({ subscribe: vi.fn(async () => new Promise(() => undefined)) })
    renderStrip(
      { project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-arch' },
      { projectId: 'other', items: [{ path: '00_VERIFY/screenshots/S1.png', kind: 'image', bytes: 10, mtime: 1 }], version: 0 },
    )
    expect(screen.queryByTestId('desktop-artifact-strip')).toBeNull()
  })

  it('桌面线 + 清单匹配 → 渲染产物条（截图缩略 + 文档 chip）', async () => {
    const items = [
      { path: '00_VERIFY/screenshots/S1.png', kind: 'image' as const, bytes: 10, mtime: 1 },
      { path: 'DELIVERY.md', kind: 'doc' as const, bytes: 100, mtime: 2 },
    ]
    mockElectronApi({ subscribe: vi.fn(async () => ({ ok: true, request_id: 'r', data: { items } })) })
    renderStrip(
      { project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-verify' },
      { projectId: 'p1', items, version: 0 },
    )
    expect(screen.getByTestId('desktop-artifact-strip')).toBeTruthy()
    // 截图 data URL 异步读取后渲染 <img>
    await waitFor(() => {
      expect(screen.getByTestId('artifact-image-00_VERIFY/screenshots/S1.png')).toBeTruthy()
    })
    expect(screen.getByTestId('artifact-doc-DELIVERY.md')).toBeTruthy()
  })

  it('订阅 effect：桌面线激活时 SUBSCRIBE 拉清单快照写入 atom', async () => {
    const api = mockElectronApi({
      subscribe: vi.fn(async () => ({
        ok: true,
        request_id: 'r',
        data: { items: [{ path: '00_VERIFY/screenshots/S1.png', kind: 'image', bytes: 10, mtime: 1 }] },
      })),
    })
    const store = createStore()
    store.set(currentProjectAtom, { project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-arch' } as never)
    store.set(desktopArtifactsAtom, { projectId: null, items: [], version: 0 })
    render(
      <Provider store={store}>
        <DesktopArtifactStrip />
      </Provider>,
    )
    await waitFor(() => {
      expect(api.desktopArtifacts.subscribe).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }))
    })
    // 快照写入 atom → 渲染出产物条
    await waitFor(() => {
      expect(screen.getByTestId('desktop-artifact-strip')).toBeTruthy()
    })
  })
})
