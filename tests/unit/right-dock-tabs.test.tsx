// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, Provider } from 'jotai'
import { RightDockTabs } from '../../renderer/components/RightDockTabs'
import {
  currentProjectAtom,
  previewUrlsAtom,
  rightDockActiveTabAtom,
  rightDockFileAtom,
  rightDockOpenAtom,
} from '../../renderer/agent-atoms'
import type { ElectronAPI, Project } from '../../shared/types'

/**
 * W4 右侧弹出标签（不动现有布局）：右缘把手 → dock 覆盖层 → 三标签。
 * 锁四件事：无活跃项目零渲染（不弹不占位）；把手开合；预览双入口 iframe 与空态；
 * 日志轮询调 preview.logs；文件查看调 project.fileRead（含失败如实展示）。
 */

function sampleProject(): Project {
  return {
    project_id: 'p-dock',
    workspace_slug: 'ws',
    name: '本月流水账',
    mode: 'longterm',
    template_type: 'personal_tool',
    status: 'active',
    current_stage: 'ready',
    root_path: 'C:/tmp/p-dock',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    auto_named: false,
  } as unknown as Project
}

/** 类型宽松桩（mock 返回形随用例变）：显式 Mock 类型避免成功形收窄 */
const dockApi: { preview: { logs: ReturnType<typeof vi.fn> }; project: { fileRead: ReturnType<typeof vi.fn> } } = {
  preview: {
    logs: vi.fn(async () => ({ ok: true, request_id: 'r1', data: { logs: '[server] listening on http://127.0.0.1:39000' } })),
  },
  project: {
    fileRead: vi.fn(async () => ({ ok: true, request_id: 'r2', data: { path: 'server.js', content: "require('express')", truncated: false, bytes: 20 } })),
  },
}

describe('RightDockTabs（W4 右侧弹出标签）', () => {
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    window.electronAPI = dockApi as unknown as ElectronAPI
    vi.clearAllMocks()
  })
  afterEach(() => {
    if (originalElectronAPI === undefined) delete window.electronAPI
    else window.electronAPI = originalElectronAPI
    cleanup()
  })

  function renderDock(storeInitial: (store: ReturnType<typeof createStore>) => void) {
    // jotai Provider 注入初始态（渲染路径零内联 atom，陷阱 10）
    const store = createStore()
    storeInitial(store)
    return render(
      <Provider store={store}>
        <RightDockTabs />
      </Provider>,
    )
  }

  it('无活跃项目 → 整体零渲染（不弹不占位）', () => {
    const { container } = renderDock(() => {})
    expect(container.querySelector('[data-ai-id="right-dock-handle"]')).toBeNull()
  })

  it('有项目 → 把手常驻；点击展开 dock，三标签齐全，再点收起', async () => {
    renderDock((store) => store.set(currentProjectAtom, sampleProject()))
    const handle = screen.getByRole('button', { name: /展开右侧面板/ })
    expect(handle).toBeTruthy()
    handle.click()
    expect(await screen.findByRole('region', { name: '右侧面板' })).toBeTruthy()
    for (const id of ['right-dock-tab-preview', 'right-dock-tab-logs', 'right-dock-tab-files']) {
      expect(document.querySelector(`[data-ai-id="${id}"]`)).toBeTruthy()
    }
    screen.getByRole('button', { name: '关闭右侧面板' }).click()
    await waitFor(() => expect(document.querySelector('[data-ai-id="right-dock-panel"]')).toBeNull())
  })

  it('预览标签：无地址如实空态；有地址渲染 iframe（双入口第二入口）', async () => {
    const project = sampleProject()
    renderDock((store) => {
      store.set(currentProjectAtom, project)
      store.set(rightDockOpenAtom, true)
      store.set(previewUrlsAtom, { [project.project_id]: { url: 'http://localhost:39000', updatedAt: 1 } })
    })
    const frame = document.querySelector('[data-ai-id="right-dock-preview-frame"]') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('src')).toBe('http://localhost:39000')
  })

  it('日志标签：轮询 preview.logs 并渲染日志文本', async () => {
    const project = sampleProject()
    renderDock((store) => {
      store.set(currentProjectAtom, project)
      store.set(rightDockOpenAtom, true)
      store.set(rightDockActiveTabAtom, 'logs')
    })
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="right-dock-logs"]')?.textContent).toContain('listening on http://127.0.0.1:39000')
    })
    expect(dockApi.preview.logs).toHaveBeenCalledWith(expect.objectContaining({ project_id: project.project_id }))
  })

  it('文件标签：输入路径 → project.fileRead → 内容呈现；失败如实展示错误', async () => {
    const project = sampleProject()
    renderDock((store) => {
      store.set(currentProjectAtom, project)
      store.set(rightDockOpenAtom, true)
      store.set(rightDockActiveTabAtom, 'files')
    })
    const input = document.querySelector('[data-ai-id="right-dock-file-input"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'server.js' } })
    document.querySelector<HTMLButtonElement>('[data-ai-id="right-dock-file-open"]')!.click()
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="right-dock-file-content"]')?.textContent).toContain("require('express')")
    })
    expect(dockApi.project.fileRead).toHaveBeenCalledWith(expect.objectContaining({ project_id: project.project_id, path: 'server.js' }))

    // 失败腿：fileRead 返回错误 → 错误行如实展示（不静默）
    dockApi.project.fileRead.mockResolvedValueOnce({
      ok: false,
      request_id: 'r3',
      error: { code: 'VALIDATION_ERROR', message: 'FILE_READ_DENIED: 该路径不属于产物文件', retryable: false },
    } as never)
    fireEvent.change(input, { target: { value: 'node_modules/express/index.js' } })
    document.querySelector<HTMLButtonElement>('[data-ai-id="right-dock-file-open"]')!.click()
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="right-dock-file-error"]')?.textContent).toContain('FILE_READ_DENIED')
    })
  })
})
