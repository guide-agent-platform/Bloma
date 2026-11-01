import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { AnyNode as CssNode } from 'postcss'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { activeSoftwareRelease, runtimeInventory } from './release-store'
import { readQualityLedger, saveQualityLedger, sameIdentity, qualityHash, qualityIdentity, type Identity, type ReviewKind } from './quality-ledger'
import { recordEvaluationEvent } from './harness-evaluation'

export interface CollaborationSelection { version: 1; id: string; identity: Identity; baseline?: string
  risk: 'full' | 'visual_only' | 'unchanged'; required: ReviewKind[]; reasons: string[]; changed_paths: string[]; changed_count: number }
// PostCSS is CommonJS. Resolve the pinned runtime dependency natively; inlining
// it into the ESM Electron main bundle manufactures unusable dynamic require.
const { parse } = createRequire(import.meta.url)('postcss') as typeof import('postcss')
const cosmetic = /^(?:color|background-color|(?:border(?:-(?:top|right|bottom|left))?|outline)-color|box-shadow|text-shadow|font-size|font-weight|font-family|line-height|letter-spacing|word-spacing|border-radius|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|(?:row-|column-)?gap)$/
function safeValue(value: string) {
  return value.length <= 256 && /^[#a-z0-9\s.,()%+\-/]+$/i.test(value) && !/url|var\s*\(|env\s*\(|attr\s*\(|expression|image|paint/i.test(value)
    && [...value.matchAll(/([a-z-]+)\s*\(/ig)].every(match => ['rgb','rgba','hsl','hsla','calc','min','max','clamp'].includes(match[1].toLowerCase()))
}
/** Compare grammar, never strip strings with a regex and assume they are CSS.
 * Only changed values of existing cosmetic declarations may lose C. V remains. */
function sameCss(a: CssNode, b: CssNode): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'decl' && b.type === 'decl') return a.prop === b.prop && Boolean(a.important) === Boolean(b.important)
    && (a.value === b.value || cosmetic.test(a.prop) && safeValue(a.value) && safeValue(b.value))
  if (a.type === 'rule' && b.type === 'rule' && a.selector !== b.selector) return false
  if (a.type === 'atrule' && b.type === 'atrule' && (a.name !== b.name || a.params !== b.params)) return false
  if (a.type === 'comment' && b.type === 'comment') return a.text === b.text
  if (!['root','rule','atrule'].includes(a.type)) return false
  const left = 'nodes' in a ? a.nodes : undefined, right = 'nodes' in b ? b.nodes : undefined
  return Boolean(left) === Boolean(right) && (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every((node, index) => sameCss(node, right![index]))
}
const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export async function selectQualityCollaboration(projectId: string, current: Identity, signal?: AbortSignal): Promise<CollaborationSelection> {
  const brief = readPrdBackplane(projectId), root = findProject(projectId).root_path, gui = brief.lean_brief?.ui === 'required'
  const full: ReviewKind[] = gui ? ['code','visual'] : ['code']
  let baseline: string | undefined, changed: string[] = [], risk: CollaborationSelection['risk'] = 'full', required = full, reasons: string[] = []
  const ledger = readQualityLedger(projectId)
  const unresolved = ledger.findings.some(f => f.disposition !== 'superseded' && ['high','critical'].includes(f.severity) && f.checks.some(c => c.outcome === 'failed')
    && !(f.disposition === 'closed' && f.checks.at(-1) && sameIdentity(f.checks.at(-1)!.identity, current)))
  try {
    const release = await activeSoftwareRelease(projectId, signal)
    if (!release) reasons.push('没有完整验证并发布的基线，先独立审阅新候选')
    else {
      baseline = release.id
      const prior = ledger.reviews.filter(r => r.status === 'complete' && (r.kind ?? 'code') === 'code' && r.identity.source === release.source.digest).at(-1)
      const hex=/^[a-f0-9]{64}$/
      const priorV = ledger.reviews.filter(r => r.status === 'complete' && r.kind === 'visual' && r.identity.source === release.source.digest && r.visual_delivery
        &&r.visual?.project===projectId&&r.visual.review===r.id&&r.visual.candidate===qualityHash(r.identity)&&hex.test(r.visual.image_hash)&&hex.test(r.visual.manifest_hash)&&hex.test(r.visual_delivery.request_hash)
        &&r.child&&r.image?.imageId.startsWith(`${r.child}/`)&&r.visual.image_hash === r.visual_delivery.image_hash && r.visual_observations?.length).at(-1)
      const previousSelection = ledger.collaboration?.find(s => s.id === release.verified?.collaboration_id)
      let certificate: CollaborationSelection | undefined
      if(previousSelection){const {id,...facts}=previousSelection;if(previousSelection.version===1&&qualityHash(facts)===id&&previousSelection.identity.source===release.source.digest&&Array.isArray(previousSelection.required)
        &&previousSelection.required.every(role=>['code','visual'].includes(role))&&(['full','visual_only','unchanged'].includes(previousSelection.risk))
        &&(previousSelection.risk==='full'?JSON.stringify(previousSelection.required)===JSON.stringify(full):previousSelection.risk==='visual_only'?gui&&JSON.stringify(previousSelection.required)==='["visual"]':previousSelection.required.length===0))certificate=previousSelection}
      const anchor=prior?.identity??certificate?.identity
      const codeCovered=Boolean(prior||certificate&&!certificate.required.includes('code'))
      const visualCovered=Boolean(priorV&&anchor&&sameIdentity(priorV.identity,anchor)||certificate&&!certificate.required.includes('visual'))
      if (release.verified?.scope !== prdScopeFingerprint(brief) || !anchor || anchor.target !== current.target || anchor.environment !== current.environment || !codeCovered
        || gui && !visualCovered) reasons.push('基线目标、环境或既有独立审阅不完整，不能缩减当前协作')
      else if (unresolved) reasons.push('有重要已复现问题尚未在当前候选复测闭合，保留完整审阅')
      else {
        const inventory = await runtimeInventory(root, signal)
        if (inventory.digest !== current.source) throw Error('COLLABORATION_CANDIDATE_CHANGED')
        const old = new Map(release.source.files.map(f => [f.path, f])), now = new Map(inventory.files.map(f => [f.path, f]))
        changed = [...new Set([...old.keys(),...now.keys()])].filter(path => old.get(path)?.sha256 !== now.get(path)?.sha256).sort()
        if (!changed.length) { risk = 'unchanged'; required = []; reasons.push('当前源码、依赖、确认目标及环境与完整验证基线相同；不重复自动C/V，原交付检查仍执行') }
        else if (gui && changed.length <= 2 && changed.every(path => /\.css$/i.test(path) && old.has(path) && now.has(path) && old.get(path)!.size <= 32768 && now.get(path)!.size <= 32768)) {
          const cosmeticOnly = changed.every(path => {
            const before = readFileSync(join(release.root, path)), after = readFileSync(join(root, path))
            if (bytesHash(before) !== old.get(path)!.sha256 || bytesHash(after) !== now.get(path)!.sha256) throw Error('COLLABORATION_CANDIDATE_CHANGED')
            return sameCss(parse(before.toString('utf8')), parse(after.toString('utf8')))
          })
          if (cosmeticOnly) { risk = 'visual_only'; required = ['visual']; reasons.push('最多两份已有小CSS文件仅改变允许的样式值；当前PNG仍须V独立审阅，不复用旧图通过') }
          else reasons.push('CSS结构、交互属性或无法确定的样式发生变化，保留C/V')
        } else reasons.push('逻辑、数据、依赖、配置、测试、文件增删或未知变更，保留完整审阅')
      }
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (String(error).includes('COLLABORATION_CANDIDATE_CHANGED')) throw error
    risk = 'full'; required = full; reasons = ['基线完整性、差异读取或CSS解析不可确认，保留完整审阅']
  }
  if (risk !== 'full' && !sameIdentity(current, await qualityIdentity(projectId, signal))) throw Error('COLLABORATION_CANDIDATE_CHANGED')
  const facts = { version: 1 as const, identity: current, baseline, risk, required, reasons, changed_paths: changed.slice(0,64), changed_count: changed.length }
  const selection: CollaborationSelection = { ...facts, id: qualityHash(facts) }
  const latest = readQualityLedger(projectId)
  if (latest.collaboration?.at(-1)?.id !== selection.id) { (latest.collaboration ??= []).push(selection); saveQualityLedger(projectId, latest)
    recordEvaluationEvent(projectId, 'collaboration_selected', { selection }) }
  return selection
}
