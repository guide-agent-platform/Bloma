import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

export interface TemporaryPromaHome {
  home: string
  cleanup(): void
}

export function useTemporaryPromaHome(prefix: string): TemporaryPromaHome {
  const original = process.env.PROMA_HOME
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home

  return {
    home,
    cleanup() {
      if (original === undefined) delete process.env.PROMA_HOME
      else process.env.PROMA_HOME = original
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}

export function listFilesRecursively(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry)
    if (statSync(fullPath).isDirectory()) files.push(...listFilesRecursively(fullPath))
    else files.push(fullPath)
  }
  return files
}

export function makeChildProcess(): {
  process: ChildProcess
  kill: ReturnType<typeof vi.fn>
} {
  const process = new EventEmitter() as ChildProcess
  const kill = vi.fn(() => true)
  Object.assign(process, { kill, pid: 4242 })
  return { process, kill }
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
