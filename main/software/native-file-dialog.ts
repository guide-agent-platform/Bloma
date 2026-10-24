import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mainRootDir } from '../platform/paths'
import { execFileDriverSpawn, buildDriverEnv } from '../desktop/process-driver'

/** Only the PID of a live process created by this observation is accepted by
 * callers. This is not a general desktop-control or persisted-PID interface. */
export async function selectOwnedNativeFile(processId: number | undefined, file: string, signal?: AbortSignal) {
  if (process.platform !== 'win32' || !processId || !Number.isSafeInteger(processId) || !existsSync(file)) throw Error('GUI_ACTION_UNSUPPORTED_NATIVE_DIALOG_ENVIRONMENT')
  const temporary = mkdtempSync(join(tmpdir(), 'bloma-owned-dialog-')), request = join(temporary, 'request.json')
  try {
    writeFileSync(request, JSON.stringify({ process_id: processId, file }))
    const response = await execFileDriverSpawn({ command: [join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(mainRootDir(), 'templates/tools/select_owned_file_dialog.ps1'), '-RequestPath', request], cwd: temporary,
      env: buildDriverEnv({ env_whitelist: [] } as never, process.env), timeoutMs: 15000, signal })
    const result = JSON.parse(response.stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as { ok?: boolean; error?: string; diagnostics?: unknown }
    if (response.code !== 0 || result.ok !== true) throw Error(`GUI_ACTION_UNSUPPORTED_NATIVE_DIALOG: ${result.error ?? response.stderr.slice(-500)} ${JSON.stringify(result.diagnostics ?? {}).slice(0,2500)}`)
    return { selected: true }
  } finally { if (existsSync(request)) unlinkSync(request); rmdirSync(temporary) }
}
