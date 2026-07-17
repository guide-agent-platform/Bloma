import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Proma core boundary', () => {
  it('keeps renderer free of direct Node and Electron IPC imports', () => {
    const atoms = readFileSync(new URL('../../renderer/agent-atoms.ts', import.meta.url), 'utf8')
    expect(atoms).not.toMatch(/from ['"]node:/)
    expect(atoms).not.toMatch(/from ['"]fs['"]/)
    expect(atoms).not.toContain('ipcRenderer')
    expect(atoms).not.toContain('api_key')
  })

  it('defines IPC channels in shared/types.ts only', () => {
    const shared = readFileSync(new URL('../../shared/types.ts', import.meta.url), 'utf8')
    expect(shared).toContain("AGENT_SEND_MESSAGE: 'agent:send-message'")
    expect(shared).toContain("ANALYTICS_TRACK: 'analytics:track'")
  })
})
