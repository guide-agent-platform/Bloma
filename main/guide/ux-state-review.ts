import type { UxDesign } from '../model/ux-design'
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

/** Host-rendered review evidence; never injected into the product's main screen. */
export function renderUxStateReview(design: UxDesign): string {
  const rows = design.interactions.map(item => `<section><h2>${esc(item.action)}</h2><small>${esc(item.id)} · ${esc(item.feature_id)} · ${esc(item.page_id)}</small>${item.states.map(state =>
    `<article><b>${esc(state.kind)}</b><p>${esc(state.observable)}</p><small>${esc(state.scenario_ids.join('、'))}</small></article>`).join('')}</section>`).join('')
  const extras = (design.enhancements ?? []).map(extra => `<article><h3>${esc(extra.name)}</h3><p>${esc(extra.description)}</p><p>${esc(extra.benefit)}</p></article>`).join('')
  const nonUi = design.non_ui_features.map(item => `<article><b>${esc(item.feature_id)}</b><p>${esc(item.reason)}</p><small>${esc(item.scenario_ids.join('、'))}</small></article>`).join('')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>交互与状态说明</title><style>body{font:15px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#20232a;background:#fafafa;max-width:1000px;margin:32px auto;padding:24px}h1{font-size:25px}h2{font-size:18px}section{padding:18px 0;border-top:1px solid #ddd}article{background:white;border:1px solid #ddd;border-radius:8px;margin:12px 0;padding:16px}small{color:#626975}p{overflow-wrap:anywhere}</style></head><body><h1>交互与状态说明</h1><p>这是独立的设计评审记录，不属于产品主界面；状态描述不代表已经运行验证。</p>${rows}${nonUi}${extras ? '<section><h2>附加能力提案</h2><p>基础功能必须完整，合理增强可加分；实现后仍需验证。</p>' + extras + '</section>' : ''}</body></html>`
}
