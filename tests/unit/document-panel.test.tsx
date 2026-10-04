// @vitest-environment jsdom

/**
 * W6（用户拍板 2026-09-18）：右侧 dock 撤除，产物文件渲染能力并入文档面板。
 * 锁三件事：快捷件与手输路径走 project.fileRead；内容在文档面板内渲染（截断如实标注）；
 * 失败（如基础设施目录被拒）如实展示错误不静默。
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, Provider } from 'jotai'
import { DocumentPanel } from '../../renderer/components/DocumentPanel'
import { currentProjectAtom, documentPanelExpandedAtom } from '../../renderer/components/atoms'
import type { ElectronAPI, Project } from '../../shared/types'

const api = {
  documents: {
    list: vi.fn(async () => ({ ok: true, request_id: 'r1', data: { documents: [] } })),
  },
  project: {
    fileRead: vi.fn(async () => ({
      ok: true,
      request_id: 'r2',
      data: { path: 'server.js', content: "require('express')", truncated: false, bytes: 17 },
    })),
  },
}

function sampleProject(): Project {
  return {
    project_id: 'p-doc',
    workspace_slug: 'ws',
    name: '个人记账本',
    mode: 'longterm',
    template_type: 'personal_tool',
    status: 'active',
    current_stage: 'ready',
    root_path: 'C:/tmp/p-doc',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    auto_named: false,
  } as unknown as Project
}

function renderPanel() {
  const store = createStore()
  store.set(currentProjectAtom, sampleProject())
  store.set(documentPanelExpandedAtom, true)
  return render(
    <Provider store={store}>
      <DocumentPanel />
    </Provider>,
  )
}

describe('DocumentPanel 产物文件渲染（W6）', () => {
  const original = window.electronAPI

  beforeEach(() => {
    window.electronAPI = api as unknown as ElectronAPI
    vi.clearAllMocks()
  })
  afterEach(() => {
    if (original === undefined) delete window.electronAPI
    else window.electronAPI = original
    cleanup()
  })

  it('快捷件点击 → project.fileRead → 面板内渲染内容', async () => {
    renderPanel()
    const quick = document.querySelector<HTMLButtonElement>('[data-ai-id="document-panel-file-quick"]')!
    quick.click()
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="document-file-content"]')?.textContent).toContain("require('express')")
    })
    expect(api.project.fileRead).toHaveBeenCalledWith(expect.objectContaining({ path: 'index.html' }))
  })

  it('手输路径回车打开；失败如实展示错误（基础设施目录被主进程拒绝）', async () => {
    renderPanel()
    const input = document.querySelector<HTMLInputElement>('[data-ai-id="document-panel-file-input"]')!
    fireEvent.change(input, { target: { value: 'server.js' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="document-file-content"]')?.textContent).toContain("require('express')")
    })

    api.project.fileRead.mockResolvedValueOnce({
      ok: false,
      request_id: 'r3',
      error: { code: 'VALIDATION_ERROR', message: 'FILE_READ_DENIED: 该路径不属于产物文件', retryable: false },
    } as never)
    fireEvent.change(input, { target: { value: 'node_modules/express/index.js' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="document-panel-file-error"]')?.textContent).toContain('FILE_READ_DENIED')
    })
  })
})

describe('全局内容渲染（2026-10-04：DocumentContent 分流）', () => {
  beforeEach(() => {
    window.electronAPI = api as unknown as ElectronAPI
    vi.clearAllMocks()
  })

  it('md 文件 → Markdown 渲染（标题成块而非裸 #）', async () => {
    api.project.fileRead.mockImplementation(async () => ({ ok: true, request_id: 'r2', data: { path: 'docs/readme.md', content: '# 标题\n\n- 要点一\n- 要点二', truncated: false, bytes: 10 } }))
    renderPanel()
    const input = document.querySelector<HTMLInputElement>('[data-ai-id="document-panel-file-input"]')!
    fireEvent.change(input, { target: { value: 'docs/readme.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      const md = document.querySelector('[data-ai-id="document-markdown"]')
      expect(md).not.toBeNull()
      expect(md!.querySelector('h1')?.textContent).toContain('标题')
      expect(md!.querySelectorAll('li').length).toBe(2)
    })
  })

  it('json 文件 → 美化缩进展示', async () => {
    api.project.fileRead.mockImplementation(async () => ({ ok: true, request_id: 'r2', data: { path: 'contract.json', content: '{"a":1}', truncated: false, bytes: 7 } }))
    renderPanel()
    const input = document.querySelector<HTMLInputElement>('[data-ai-id="document-panel-file-input"]')!
    fireEvent.change(input, { target: { value: 'contract.json' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="document-json"]')?.textContent).toContain('"a": 1')
    })
  })

  it('代码文件 → 等宽原文（旧观感不变）', async () => {
    api.project.fileRead.mockImplementation(async () => ({ ok: true, request_id: 'r2', data: { path: 'app.py', content: 'print("hi")', truncated: false, bytes: 11 } }))
    renderPanel()
    const input = document.querySelector<HTMLInputElement>('[data-ai-id="document-panel-file-input"]')!
    fireEvent.change(input, { target: { value: 'app.py' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(document.querySelector('[data-ai-id="document-plain"]')?.textContent).toContain('print')
    })
  })
})
