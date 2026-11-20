import React, { useEffect, useRef } from 'react'
import type { ApiResult } from '../../shared/types'
import { mountTokenMonitor } from '../../token monitor/web/app.js'
import markup from '../../token monitor/web/panel.html?raw'
import styles from '../../token monitor/web/styles.css?inline'

async function unwrap<T>(request: Promise<ApiResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

export function TokenMonitorPanel() {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = container.current
    if (!host) return
    const monitor = window.electronAPI?.tokenMonitor
    if (!monitor) {
      host.textContent = '请在 Bloma 桌面应用中查看 Token 用量。'
      return
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const stylesheet = document.createElement('style')
    stylesheet.textContent = styles
    const panel = document.createElement('div')
    panel.className = 'token-monitor embedded'
    panel.innerHTML = markup
    shadow.replaceChildren(stylesheet, panel)
    const stop = mountTokenMonitor(panel, {
      read: () => unwrap(monitor.read()),
      refreshPrices: () => unwrap(monitor.refreshPrices()),
      openSource: provider => unwrap(monitor.openSource(provider)),
      auditModels: () => unwrap(monitor.auditModels()),
      auditStart: filter => unwrap(monitor.auditStart(filter)),
      auditStatus: () => unwrap(monitor.auditStatus()),
      auditStop: () => unwrap(monitor.auditStop()),
    })
    return () => {
      stop()
      shadow.replaceChildren()
    }
  }, [])
  return <div data-ai-id="token-monitor-panel" ref={container} />
}
