import { useEffect, useState } from 'react'

/**
 * Phase 10 落地旅程（2026-09-16）：实验开关只读实况（app:switch-state 白名单出口）。
 * 模块级缓存一次性拉取（env 只随进程重启变化）；失败/非 Electron 环境 → null=
 * 调用方按现状口径渲染（fail-open 不阻塞 UI）。I4「渲染端无 env 透传」待办的窄收口。
 */

let cache: Record<string, boolean> | null = null
let cachePromise: Promise<Record<string, boolean> | null> | null = null

function loadSwitches(): Promise<Record<string, boolean> | null> {
  if (cache) return Promise.resolve(cache)
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        const api = window.electronAPI
        if (!api?.app?.switchState) return null
        const result = await api.app.switchState({ request_id: `switch-state-${Date.now()}` })
        if (result?.ok && result.data) {
          cache = result.data.switches
          return cache
        }
        return null
      } catch {
        return null
      }
    })()
  }
  return cachePromise
}

/** 开关实况 hook：null=未知（按现状口径渲染）。 */
export function useExperimentSwitches(): Record<string, boolean> | null {
  const [switches, setSwitches] = useState<Record<string, boolean> | null>(cache)
  useEffect(() => {
    if (cache) return
    let alive = true
    void loadSwitches().then((value) => {
      if (alive && value) setSwitches(value)
    })
    return () => {
      alive = false
    }
  }, [])
  return switches
}
