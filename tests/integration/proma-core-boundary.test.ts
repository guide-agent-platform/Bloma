import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

describe('Proma core boundary', () => {
  it('keeps renderer free of direct Node, Electron IPC, and secret APIs', () => {
    scanDir(join(root, 'renderer'), [
      /from ['"]node:/,
      /from ['"]fs['"]/,
      /from ['"]path['"]/,
      /from ['"]child_process['"]/,
      /ipcRenderer/,
      /safeStorage/,
      /encryptString/,
      /decryptString/,
      // 注意：不禁止 api_key 字段名——renderer 建渠道表单需按契约（ChannelCreateInput.api_key）
      // 把用户新输入的 key 经 IPC 交 main 加密；读回时 main 已脱敏为 '***'。真正安全边界是
      // safeStorage/encryptString/decryptString（renderer 不得做加密），仍在此禁止。
    ])
  })

  it('keeps preload limited to IPC bridge code only', () => {
    scanDir(join(root, 'preload'), [
      /from ['"]fs['"]/,
      /from ['"]path['"]/,
      /from ['"]child_process['"]/,
      /safeStorage/,
      /encryptString/,
      /decryptString/,
    ])
  })

  it('defines IPC channels in shared/types.ts only', () => {
    const shared = readFileSync(new URL('../../shared/types.ts', import.meta.url), 'utf8')
    expect(shared).toContain("AGENT_SEND_MESSAGE: 'agent:send-message'")
    expect(shared).toContain("ANALYTICS_TRACK: 'analytics:track'")
  })
})

function scanDir(dir: string, forbidden: RegExp[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      scanDir(full, forbidden)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    const content = readFileSync(full, 'utf8')
    for (const pattern of forbidden) {
      expect(content, `${full} should not match ${pattern}`).not.toMatch(pattern)
    }
  }
}
