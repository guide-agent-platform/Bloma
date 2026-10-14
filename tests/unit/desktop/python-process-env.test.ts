import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildChildExecEnv } from '../../../main/desktop/child-exec-tool'
import { buildDriverEnv, execFileDriverSpawn } from '../../../main/desktop/process-driver'
import type { ProjectContract } from '../../../main/desktop/contract-schema'

const pythonAvailable = spawnSync('python', ['--version'], { windowsHide: true }).status === 0

describe.skipIf(!pythonAvailable)('nested Python text pipes', () => {
  it.each(['executor', 'verification'] as const)('%s preserves Chinese stdout through subprocess.run(text=True)', async (scope) => {
    const parent = { ...process.env }
    delete parent.PYTHONUTF8
    delete parent.PYTHONIOENCODING
    const env = scope === 'executor' ? buildChildExecEnv(parent)
      : buildDriverEnv({ env_whitelist: [] } as unknown as ProjectContract, parent)
    const expected = 'PASS 中文场景\n'
    const inner = `import sys; sys.stdout.buffer.write(bytes.fromhex('${Buffer.from(expected).toString('hex')}'))`
    const code = `import subprocess,sys\nr=subprocess.run([sys.executable,'-c',${JSON.stringify(inner)}],capture_output=True,text=True,check=True)\nassert r.stdout == ${JSON.stringify(expected)}\nprint(r.stdout,end='')`
    const outcome = await execFileDriverSpawn({ command: ['python', '-c', code], env, cwd: tmpdir(), timeoutMs: 10000 })
    expect(outcome.stderr).toBe('')
    expect(outcome.code).toBe(0)
    expect(outcome.stdout.replace(/\r\n/g, '\n')).toBe(expected)
  })
})
