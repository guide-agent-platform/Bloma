import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileDriverSpawn } from '../../../main/desktop/process-driver'
import { runLaunchSmoke } from '../../../main/desktop/launch-smoke'

describe('controlled process cleanup', () => {
  it.skipIf(process.platform !== 'win32')('cancels an actual startup smoke process tree and removes its isolated data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bloma-smoke-tree-'))
    try {
      const observed = join(directory, 'observed.json'), controller = new AbortController()
      const code = `const fs=require('fs'),cp=require('child_process');const p=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.mkdirSync(process.env.APP_DATA_DIR,{recursive:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:p.pid,data:process.env.APP_DATA_DIR}));setInterval(()=>{},1000);`
      writeFileSync(join(directory, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: [process.execPath, '-e', code, observed] }))
      const outcome = runLaunchSmoke(directory, { signal: controller.signal, graceMs: 5000 }).catch(error => error)
      for (let n = 0; n < 80 && !existsSync(observed); n++) await new Promise(resolve => setTimeout(resolve, 25))
      expect(existsSync(observed)).toBe(true)
      const saved = JSON.parse(readFileSync(observed, 'utf8'))
      controller.abort()
      expect((await outcome).name).toBe('AbortError')
      expect(existsSync(saved.data)).toBe(false)
      const state = execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${Number(saved.pid)} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
      expect(state.trim()).toBe('gone')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 15000)

  it('aborted request never starts a process', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(execFileDriverSpawn({ command: ['never-start'], cwd: process.cwd(), env: {}, timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' })
  })
  it.skipIf(process.platform !== 'win32')('timeout and cancel terminate the actual helper descendant', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bloma-tree-'))
    try {
      for (const mode of ['timeout', 'cancel'] as const) {
        const file = join(directory, `${mode}.pid`)
        const controller = new AbortController()
        const code = `const fs=require('fs'),cp=require('child_process');const p=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000);`
        const outcome = execFileDriverSpawn({ command: [process.execPath, '-e', code, file], cwd: directory, env: { ...process.env } as Record<string, string>, timeoutMs: mode === 'timeout' ? 1000 : 5000, signal: controller.signal }).catch(e => e)
        for (let n = 0; n < 40 && !existsSync(file); n++) await new Promise(resolve => setTimeout(resolve, 25))
        expect(existsSync(file)).toBe(true)
        const pid = Number(readFileSync(file, 'utf8'))
        if (mode === 'cancel') controller.abort()
        expect((await outcome).kind).toBe(mode === 'timeout' ? 'timeout' : 'cancelled')
        const state = execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
        expect(state.trim()).toBe('gone')
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 15000)
})
