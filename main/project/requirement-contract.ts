import { createHash } from 'node:crypto'
import type { PrdBackplane, SketchRequirement } from '../model/prd-backplane'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Identity belongs to the frozen description, never to the array position. */
export function requirementIdentity(item: SketchRequirement): string {
  return digest([item.id, item.description])
}

/** Only creators of a fresh, same-input acceptance map may establish a binding. */
export function bindAcceptance(backplane: PrdBackplane): PrdBackplane {
  return { ...backplane, acceptance_bindings: Object.fromEntries(backplane.requirements.flatMap(item => {
    const text = backplane.acceptance[item.id]
    return text?.trim() ? [[item.id, { requirement: requirementIdentity(item), acceptance: digest(text) }]] : []
  })) }
}

export function trustedAcceptance(backplane: PrdBackplane, item: SketchRequirement): string | undefined {
  const text = backplane.acceptance?.[item.id]
  const binding = backplane.acceptance_bindings?.[item.id]
  return text && binding?.requirement === requirementIdentity(item) && binding.acceptance === digest(text) ? text : undefined
}

export function acceptanceAssociationIssues(backplane: PrdBackplane): string[] {
  return backplane.requirements.flatMap(item => backplane.acceptance?.[item.id] && !trustedAcceptance(backplane, item)
    ? [`${item.id}: 验收关联未经确认或已失效；以当前需求描述和行为断言为准，旧内容不可作为覆盖证据`] : [])
}

/** Test registrations bind to behavior as well as identity; priority is scheduling only. */
export function requirementEvidenceHash(backplane: PrdBackplane, item: SketchRequirement): string {
  return digest([item.id, item.description, item.story ?? '', item.behavior_assertions ?? [],
    item.scope_notes ?? '', trustedAcceptance(backplane, item) ?? '', backplane.constraints ?? [], backplane.out_of_scope ?? [],
    backplane.ux ?? null, backplane.shape ?? null, backplane.gdd ?? null, backplane.ai_capabilities ?? [], backplane.key_tasks ?? [],
    backplane.assumptions ?? [], backplane.requirements_model ?? null])
}

export function requirementVerificationContext(backplane: PrdBackplane): unknown {
  return backplane.requirements.map(item => [item.id, requirementEvidenceHash(backplane, item)]).sort((a, b) => a[0]!.localeCompare(b[0]!))
}

/** Revisions must not inherit acceptance text from a different meaning under the same id. */
export function reconcileAcceptanceRevision(original: PrdBackplane, revised: PrdBackplane): PrdBackplane {
  const acceptance = Object.fromEntries(revised.requirements.flatMap(item => {
    const previous = original.requirements.find(old => old.id === item.id)
    if (previous && requirementIdentity(previous) === requirementIdentity(item)) {
      const text = trustedAcceptance(original, previous)
      if (text) return [[item.id, text]]
    }
    const assertions = item.behavior_assertions?.filter(text => text.trim()) ?? []
    return assertions.length ? [[item.id, assertions.join('；')]] : []
  }))
  // Old document sections can carry the same stale numbering. Reproject at the caller.
  return bindAcceptance({ ...revised, acceptance, prd_document: undefined })
}
