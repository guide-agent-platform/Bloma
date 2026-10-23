import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prdScopeFingerprint } from './requirement-contract'
import type { PrdBackplane } from '../model/prd-backplane'
import { findProject } from './project-service'
import { uxDesignFingerprint, uxDesignIssues, type UxDesign } from '../model/ux-design'

export function readConfirmedUxBinding(projectId: string, prd: PrdBackplane): { html_path?: string; design_path?: string } | undefined {
  const project = findProject(projectId), root = project.root_path
  if (prd.lean_brief?.ui === 'none') return undefined
  if (prd.lean_brief?.preview === 'skip') {
    const scope = prdScopeFingerprint(prd)
    if (!prd.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope
      || project.ux_confirmation.design_hash !== scope || project.ux_confirmation.html_hash !== null) throw new Error('UX_DELEGATION_UNCONFIRMED')
    return undefined
  }
  if (!root) {
    if (prd.requirements_model) throw new Error('UX_CONFIRMATION_MISSING: 项目目录缺失')
    return undefined
  }
  const metadata = join(root, '00_UX/confirmed.json'), htmlPath = join(root, '00_UX/confirmed.html')
  if (!existsSync(metadata)) {
    if (prd.lean_brief) throw new Error('UX_CONFIRMATION_MISSING: 界面方向尚未确认')
    if (prd.requirements_model) throw new Error('UX_CONFIRMATION_MISSING: 当前需求尚无已确认界面设计')
    return existsSync(htmlPath) ? { html_path: '00_UX/confirmed.html' } : undefined
  }
  const binding = JSON.parse(readFileSync(metadata, 'utf8')) as { version: number; design: UxDesign; html_hash: string | null; mode?: string; scope_hash?: string }
  if (prd.lean_brief) {
    const trusted = project.ux_confirmation
    const scope = prdScopeFingerprint(prd)
    if (!prd.user_confirmed_at || binding.version !== 2 || binding.mode !== 'lean' || binding.scope_hash !== scope
      || trusted?.prd_fingerprint !== scope || trusted.design_hash !== binding.html_hash || trusted.html_hash !== binding.html_hash
      || !existsSync(htmlPath) || createHash('sha256').update(readFileSync(htmlPath)).digest('hex') !== binding.html_hash) throw new Error('UX_CONFIRMATION_CHANGED: 当前目标或草图尚未获得有效确认')
    return { html_path: '00_UX/confirmed.html' }
  }
  if (binding.version !== 1 || ![undefined, 'html', 'text'].includes(binding.mode)) throw new Error('UX_CONFIRMATION_INVALID: 确认记录格式无效')
  if (!prd.user_confirmed_at || uxDesignIssues(binding.design, prd).length) throw new Error('UX_CONFIRMATION_STALE: 设计与当前已确认需求不一致')
  const trusted = project.ux_confirmation
  if (!trusted || trusted.prd_fingerprint !== binding.design.prd_fingerprint || trusted.design_hash !== uxDesignFingerprint(binding.design) || trusted.html_hash !== binding.html_hash) throw new Error('UX_CONFIRMATION_CHANGED: 界面设计确认凭据不匹配')
  if (binding.mode === 'text') {
    if (binding.html_hash !== null) throw new Error('UX_CONFIRMATION_INVALID: 文字版本不能保留HTML确认凭据')
    return { design_path: '00_UX/confirmed.json' }
  }
  if (!existsSync(htmlPath) || createHash('sha256').update(readFileSync(htmlPath)).digest('hex') !== binding.html_hash) throw new Error('UX_CONFIRMATION_CHANGED: 已确认草图内容发生变化')
  return { html_path: '00_UX/confirmed.html', design_path: '00_UX/confirmed.json' }
}
