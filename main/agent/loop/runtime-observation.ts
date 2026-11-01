import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentLoopInput } from './agent-loop'

export const PI_CONTEXT_POLICY = { contextWindow: 128000, reserveTokens: 25600, keepRecentTokens: 20000 } as const
export const PI_RETRY_POLICY = { enabled: true, maxRetries: 2, baseDelayMs: 1000 } as const
export const runtimeHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface RuntimeObservation {
  version: 1
  session_id: string
  request_id: string
  role: string
  runtime: { engine: 'pi'; packages: Record<string, string>; adapter_sha256: string; node: string; electron: string; platform: string; arch: string }
  route: { model: string; provider: string; endpoint_origin: string; endpoint_path_sha256: string }
  settings: { contextWindow: number; reserveTokens: number; keepRecentTokens: number; maxTokens: number; maxTurns: number; thinking: string; temperature: number | null; tool_execution: 'sequential'; permission_mode: string; retry: typeof PI_RETRY_POLICY }
  tools_sha256: string
  prompt_sha256: string
  skills: { mode: 'explicit-bloma'; names: string[]; content_sha256: string }
  memory_sha256: string
}
const require = createRequire(import.meta.url)
function packageVersion(name: string): string {
  try {
    // Pi only exports an `import` condition; createRequire.resolve cannot
    // resolve that ESM entry. Use ESM resolution, with source-test fallback.
    let entry: string
    try { entry = fileURLToPath(import.meta.resolve(name)) } catch {
      const root = require.resolve.paths(name)?.find(root => existsSync(join(root, name, 'package.json')))
      if (!root) return 'unknown'
      entry = join(root, name, 'package.json')
    }
    let current = dirname(entry)
    for (;;) {
      const file = join(current, 'package.json')
      if (existsSync(file)) { const value = JSON.parse(readFileSync(file, 'utf8')); if (value.name === name) return String(value.version) }
      const parent = dirname(current); if (parent === current) return 'unknown'; current = parent
    }
  } catch { return 'unknown' }
}
function adapterFingerprint(): string {
  try {
    const own = fileURLToPath(import.meta.url)
    // Bundled production code is one artifact; source-mode tests fingerprint the
    // executing adapter modules, not a git label or the user's dirty worktree.
    const files = own.endsWith('.ts') ? ['runtime-observation.ts', 'pi-runtime.ts', 'pi-transport.ts', 'pi-messages.ts', 'pi-session-store.ts', 'agent-loop.ts'].map(f => join(dirname(own), f)) : [own]
    return runtimeHash(files.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')))
  } catch { return 'unknown' }
}
// Capture once per process, matching the loaded runtime rather than files that
// may be rebuilt on disk while a user still runs the previous instance.
const runtime = { engine: 'pi' as const, packages: Object.fromEntries(['pi-coding-agent', 'pi-agent-core', 'pi-ai'].map(name =>
  [name, packageVersion('@earendil-works/' + name)])), adapter_sha256: adapterFingerprint(), node: process.versions.node,
  electron: process.versions.electron ?? 'none', platform: process.platform, arch: process.arch }

export function observePiRuntime(input: AgentLoopInput, skills: { names: string[]; content: string }, memory: string): RuntimeObservation {
  let origin = 'unknown', endpointPath = 'unknown'
  try { const url = new URL(input.env.ANTHROPIC_BASE_URL); origin = url.origin; endpointPath = runtimeHash(url.pathname) } catch { /* unknown is never comparable */ }
  return { version: 1, session_id: input.sessionId, request_id: input.requestId, role: input.accountingRole ?? 'orchestrator', runtime,
    route: { model: input.env.ANTHROPIC_MODEL || 'unknown', provider: input.providerType ?? input.env.ANTHROPIC_PROVIDER_TYPE ?? 'unknown', endpoint_origin: origin, endpoint_path_sha256: endpointPath },
    settings: { ...PI_CONTEXT_POLICY, maxTokens: input.maxTokens, maxTurns: input.maxTurns,
      thinking: input.thinkingLevel ?? (input.env.BLOMA_LOOP_THINKING === 'off' ? 'off' : 'low'), temperature: input.temperature ?? null, tool_execution: 'sequential',permission_mode:input.permissionMode,retry:PI_RETRY_POLICY },
    tools_sha256: runtimeHash(input.tools.map(tool => ({ name: tool.name, description: tool.description, schema: tool.input_schema }))),
    prompt_sha256: runtimeHash(input.system), skills: { mode: 'explicit-bloma', names: skills.names, content_sha256: runtimeHash(skills.content) }, memory_sha256: runtimeHash(memory) }
}
