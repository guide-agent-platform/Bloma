import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeTextFileAtomic } from '../../storage/json-store'
import { renameWithRetry, WIN32_RETRYABLE, POSIX_RETRYABLE, type FsRetryDeps } from '../../storage/fs-retry'

vi.mock('../../storage/fs-retry', async original => {
  const actual = await original<typeof import('../../storage/fs-retry')>()
  return { ...actual, renameWithRetry: vi.fn(actual.renameWithRetry) }
})

let root: string, target: string
let actual: typeof import('../../storage/fs-retry')
const oldContent = '{"revision":27}\n'
const newContent = '{"revision":29}\n'
const permissionError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`rename ${code}`), { code })

beforeEach(async () => {
  actual = await vi.importActual<typeof import('../../storage/fs-retry')>('../../storage/fs-retry')
  vi.mocked(renameWithRetry).mockImplementation(actual.renameWithRetry)
  root = mkdtempSync(join(tmpdir(), 'bloma-atomic-rename-'))
  target = join(root, 'state.json')
  writeFileSync(target, oldContent)
})
afterEach(() => {
  vi.clearAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function injectRename(rename: FsRetryDeps['renameSync'], retryableCodes = WIN32_RETRYABLE): number[] {
  const sleeps: number[] = []
  vi.mocked(renameWithRetry).mockImplementation((source, destination) => actual.renameWithRetry(source, destination, {
    renameSync: rename, retryableCodes, maxAttempts: 5,
    sleepSync: ms => { sleeps.push(ms) }, rmSync, existsSync,
  }))
  return sleeps
}

describe('atomic text persistence under transient file contention', () => {
  it('retries Windows EPERM and replaces the whole old file only when rename succeeds', () => {
    let attempts = 0
    const sleeps = injectRename((source, destination) => {
      attempts++
      expect(readFileSync(destination, 'utf8')).toBe(oldContent)
      expect(readFileSync(source, 'utf8')).toBe(newContent)
      if (attempts < 3) throw permissionError('EPERM')
      renameSync(source, destination)
    })
    writeTextFileAtomic(target, newContent)
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([50, 100])
    expect(readFileSync(target, 'utf8')).toBe(newContent)
    expect(readdirSync(root)).toEqual(['state.json'])
  })

  it('preserves the old file and removes the temporary file after permanent Windows EPERM', () => {
    let attempts = 0
    const error = permissionError('EPERM')
    const sleeps = injectRename(() => { attempts++; throw error })
    expect(() => writeTextFileAtomic(target, newContent)).toThrow(error)
    expect(attempts).toBe(5)
    expect(sleeps).toEqual([50, 100, 200, 400])
    expect(readFileSync(target, 'utf8')).toBe(oldContent)
    expect(readdirSync(root)).toEqual(['state.json'])
  })

  it.each(['EPERM', 'EACCES'])('does not retry a POSIX %s permission refusal', code => {
    let attempts = 0
    const error = permissionError(code)
    const sleeps = injectRename(() => { attempts++; throw error }, POSIX_RETRYABLE)
    expect(() => writeTextFileAtomic(target, newContent)).toThrow(error)
    expect(attempts).toBe(1)
    expect(sleeps).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe(oldContent)
    expect(readdirSync(root)).toEqual(['state.json'])
  })

  it.skipIf(process.platform !== 'win32').each(['transient', 'permanent'] as const)(
    'handles a real %s Windows deny-delete handle held by another process', async mode => {
      // .NET FileShare.ReadWrite permits readers/writers, but deliberately omits
      // FileShare.Delete: the same sharing conflict as a short-lived external reader.
      const script = [
        "$ErrorActionPreference='Stop'",
        '$held=[System.IO.File]::Open($env:BLOMA_TEST_LOCK_TARGET,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)',
        "try { [Console]::WriteLine('LOCK_READY'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); Start-Sleep -Milliseconds 180 } finally { $held.Dispose() }",
      ].join('; ')
      const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BLOMA_TEST_LOCK_TARGET: target },
      })
      const ended = new Promise<number | null>(resolve => {
        holder.once('exit', resolve)
        holder.once('error', () => resolve(null))
      })
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '', errors = ''
          const timer = setTimeout(() => reject(new Error(`Lock holder startup timed out: ${errors}`)), 5000)
          holder.stderr.on('data', bytes => { errors += String(bytes) })
          holder.stdout.on('data', bytes => {
            output += String(bytes)
            if (output.includes('LOCK_READY')) { clearTimeout(timer); resolve() }
          })
          holder.once('error', error => { clearTimeout(timer); reject(error) })
          holder.once('exit', code => {
            clearTimeout(timer)
            if (!output.includes('LOCK_READY')) reject(new Error(`Lock holder exited ${code}: ${errors}`))
          })
        })
        const probe = join(root, 'rename-probe.tmp')
        writeFileSync(probe, newContent)
        let lockedError: NodeJS.ErrnoException | undefined
        try { renameSync(probe, target) } catch (error) { lockedError = error as NodeJS.ErrnoException }
        expect(lockedError?.code).toMatch(/^(EPERM|EACCES|EBUSY)$/)
        unlinkSync(probe)

        if (mode === 'transient') holder.stdin.write('release\n')
        const started = Date.now()
        if (mode === 'transient') {
          writeTextFileAtomic(target, newContent)
          expect(readFileSync(target, 'utf8')).toBe(newContent)
        } else {
          expect(() => writeTextFileAtomic(target, newContent)).toThrow()
          expect(Date.now() - started).toBeGreaterThanOrEqual(700)
          expect(readFileSync(target, 'utf8')).toBe(oldContent)
        }
        expect(readdirSync(root)).toEqual(['state.json'])
      } finally {
        holder.stdin.end()
        const timer = setTimeout(() => holder.kill(), 2000)
        await ended
        clearTimeout(timer)
      }
      expect(await ended).toBe(0)
    }, 15000,
  )
})
