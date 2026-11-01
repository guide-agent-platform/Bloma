import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RuntimeObservation } from '../agent/loop/runtime-observation'

export interface EvaluationStrategy {
  version: 1
  independent_design: 'enabled' | 'disabled'
  code_review: 'candidate-risk-v1'
  visual_review: 'candidate-risk-v1'
  exploration: 'parent-only'
  workers: 'file-scoped-parent-execution'
  max_children: 2
  implementation_sha256: string
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const implementation = (() => {
  try {
    const own = fileURLToPath(import.meta.url)
    const files = own.endsWith('.ts') ? ['evaluation-identity.ts', 'collaboration-selection.ts', 'quality-review.ts', 'independent-semantics.ts', '../desktop/lean-production.ts'].map(f => join(dirname(own), f)) : [own]
    return hash(files.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')))
  } catch { return 'unknown' }
})()

/** A label for B alone is not an ablation of C/V or ordinary workers. */
export function currentEvaluationStrategy(independent: boolean): EvaluationStrategy {
  return { version: 1, independent_design: independent ? 'enabled' : 'disabled', code_review: 'candidate-risk-v1',
    visual_review: 'candidate-risk-v1', exploration: 'parent-only', workers: 'file-scoped-parent-execution', max_children: 2, implementation_sha256: implementation }
}

export function summarizeRuntimeObservations(events: Array<{ kind: string; data: Record<string, unknown> }>) {
  const issues: string[] = [], observations: Array<RuntimeObservation & { quality_role?: string }> = []
  for (const event of events.filter(e => e.kind === 'runtime_identity')) {
    const value = event.data.observation as RuntimeObservation & { quality_role?: string }
    try {
      if (value.version !== 1 || !value.session_id || !value.request_id || !value.role || value.runtime.engine !== 'pi'
        || !['pi-coding-agent','pi-agent-core','pi-ai'].every(name => /^\d+\.\d+\.\d+/.test(value.runtime.packages[name]))
        || !hex(value.runtime.adapter_sha256) || !hex(value.tools_sha256) || !hex(value.prompt_sha256) || !hex(value.memory_sha256)
        || !hex(value.skills.content_sha256) || !['explicit-bloma','agent-selected'].includes(value.skills.mode) || !Array.isArray(value.skills.names)
        || value.skills.mode==='agent-selected'&&(!hex(value.skills.catalog_sha256)||!Array.isArray(value.skills.available))
        || value.skills.names.some(name=>typeof name!=='string') || !hex(value.route.endpoint_path_sha256)
        || Object.values(value.route).some(v => typeof v !== 'string' || !v || v === 'unknown')
        || !Number.isSafeInteger(value.settings.contextWindow) || value.settings.contextWindow <= 0
        || !Number.isSafeInteger(value.settings.maxTokens) || value.settings.maxTokens <= 0
        || !Number.isSafeInteger(value.settings.maxTurns) || value.settings.maxTurns <= 0
        || !Number.isSafeInteger(value.settings.reserveTokens) || value.settings.reserveTokens <= 0
        || !Number.isSafeInteger(value.settings.keepRecentTokens) || value.settings.keepRecentTokens <= 0
        || !value.settings.permission_mode || !value.settings.thinking || !value.settings.retry
        || !value.runtime.node || !value.runtime.electron || !value.runtime.platform || !value.runtime.arch
        || value.settings.tool_execution !== 'sequential') throw Error('incomplete')
      const url = new URL(value.route.endpoint_origin)
      if (url.username || url.password || url.search || url.hash) throw Error('unsafe route')
      observations.push(value)
    } catch { issues.push('runtime identity invalid or unknown') }
  }
  const parents = observations.filter(o => o.role === 'orchestrator')
  if (!parents.length) issues.push('parent runtime identity missing')
  const profile = (o: RuntimeObservation) => ({ runtime: o.runtime, route: o.route, settings: o.settings,
    tools_sha256: o.tools_sha256, prompt_sha256: o.prompt_sha256, skills: o.skills, memory_sha256: o.memory_sha256 })
  const profiles = [...new Set(parents.map(o => hash(profile(o))))]
  if (profiles.length > 1) issues.push('parent runtime identity changed')
  const byRole = new Map<string, Set<string>>()
  for (const o of observations) {
    const key = o.quality_role ?? o.role
    const values = byRole.get(key) ?? new Set<string>(); values.add(hash(profile(o))); byRole.set(key, values)
  }
  return { issues, observations, parent_profile: parents[0] ? profile(parents[0]) : null,
    parent_profile_sha256: profiles.length === 1 ? profiles[0] : null,
    actual_roles: [...byRole.keys()].sort(), role_profiles: Object.fromEntries([...byRole].map(([key, values]) => [key, [...values].sort()])),
    collaboration_selections: events.filter(e => e.kind === 'collaboration_selected').map(e => e.data.selection) }
}

export function sameEvaluationStrategyExceptB(left?: EvaluationStrategy, right?: EvaluationStrategy): boolean {
  if (!left || !right) return false
  const withoutB = ({ independent_design: _b, ...rest }: EvaluationStrategy) => rest
  return hash(withoutB(left)) === hash(withoutB(right))
}
