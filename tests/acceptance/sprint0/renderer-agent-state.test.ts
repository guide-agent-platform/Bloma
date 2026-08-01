// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from 'jotai'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentStreamStateFamily,
  pendingPermissionRequestsAtom,
  setupGlobalAgentListeners,
  workflowStageAtom,
} from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'

const root = process.cwd()
let eventSequence = 0

describe('Sprint 0 renderer agent state acceptance', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S0-UI-003] Renderer 源文件不得导入 Node、Electron 或进程 API', () => {
    const forbidden = new Set([
      'electron',
      'fs',
      'path',
      'child_process',
      'node:fs',
      'node:path',
      'node:child_process',
      'node:process',
    ])

    for (const path of listTypeScriptFiles(join(root, 'renderer'))) {
      const imports = collectModuleSpecifiers(path)
      expect(imports.filter((specifier) => forbidden.has(specifier)), path).toEqual([])
    }
  })

  it('[S0-UI-004] 全局监听器应跨 session 保留事件、阶段和权限队列', () => {
    const store = createStore()
    let listener: ((event: AgentEvent) => void) | undefined
    const unsubscribe = vi.fn()
    window.__jotai_store__ = store
    window.electronAPI = {
      agent: {
        onStreamEvent(next: (event: AgentEvent) => void) {
          listener = next
          return unsubscribe
        },
      },
    } as unknown as ElectronAPI

    const cleanup = setupGlobalAgentListeners()
    listener?.(event('session-a', 'message_delta', { text: 'A' }))
    listener?.(event('session-b', 'message_delta', { text: 'B' }))
    listener?.(event('session-a', 'stage_changed', { stage: 'generating_sketch' }))
    listener?.(event('session-a', 'permission_requested', {
      request: {
        id: 'role-c-permission',
        session_id: 'session-a',
        tool_name: 'generate_sketch',
        tool_input: {},
        danger_level: 'warning',
        user_visible_summary: '生成草图',
        created_at: new Date().toISOString(),
      },
    }))

    expect(store.get(agentStreamStateFamily('session-a')).content).toBe('A')
    expect(store.get(agentStreamStateFamily('session-b')).content).toBe('B')
    expect(store.get(workflowStageAtom)).toBe('generating_sketch')
    expect(store.get(pendingPermissionRequestsAtom).get('session-a')).toHaveLength(1)
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('[S0-UI-005] Renderer 启动时应先安装全局 store 与监听器再渲染 App', () => {
    const source = readFileSync(join(root, 'renderer', 'main.tsx'), 'utf8')
    const storeIndex = source.indexOf('window.__jotai_store__ = store')
    const listenerIndex = source.indexOf('setupGlobalAgentListeners()')
    const renderIndex = source.indexOf('createRoot(rootElement).render')

    expect(storeIndex).toBeGreaterThan(-1)
    expect(listenerIndex).toBeGreaterThan(storeIndex)
    expect(renderIndex).toBeGreaterThan(listenerIndex)
  })
})

function event(
  sessionId: string,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: `${sessionId}-${type}-${eventSequence += 1}`,
    session_id: sessionId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry)
    if (statSync(fullPath).isDirectory()) files.push(...listTypeScriptFiles(fullPath))
    else if (/\.(ts|tsx)$/.test(entry)) files.push(fullPath)
  }
  return files
}

function collectModuleSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
  })
  return specifiers
}
