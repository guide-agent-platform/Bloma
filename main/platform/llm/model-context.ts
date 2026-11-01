import { monetaryContextLimit } from './monetary-budget'
/** Runtime capability metadata is separate from spending/reservation policy. */
export interface ModelContextPolicy {
  contextWindow: number; reserveTokens: number; keepRecentTokens: number; maxOutputTokens: number
  source: 'channel' | 'pi-catalog' | 'fallback'; catalogProvider?: string
  capacityWindow?: number; reservationLimit?: number
}
export const MODEL_LIMITS_ENV = 'BLOMA_MODEL_LIMITS'
export function validModelLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1024 && (value as number) <= 16777216
}
export function attachModelLimits(env: Record<string,string>, limits?: {context_window?:number;max_output_tokens?:number}): void {
  if (limits?.context_window === undefined && limits?.max_output_tokens === undefined) return
  if (limits.context_window !== undefined && !validModelLimit(limits.context_window) || limits.max_output_tokens !== undefined && !validModelLimit(limits.max_output_tokens)) throw Error('MODEL_LIMITS_INVALID')
  env[MODEL_LIMITS_ENV] = JSON.stringify({model:env.ANTHROPIC_MODEL,origin:new URL(env.ANTHROPIC_BASE_URL).origin,...limits})
}
export async function resolveModelContext(env: Record<string,string>, requestedOutput: number): Promise<ModelContextPolicy> {
  const model=env.ANTHROPIC_MODEL
  let origin:string|undefined
  try { origin=new URL(env.ANTHROPIC_BASE_URL).origin } catch { /* explicit fallback below */ }
  let contextWindow=128000,maxOutputTokens=128000,source:ModelContextPolicy['source']='fallback',catalogProvider:string|undefined
  // Reuse Pi's versioned, local provider catalog. Match BOTH endpoint origin and
  // exact model ID; an arbitrary proxy naming itself like a model proves nothing.
  if(model&&origin){
    const {getProviders,getModels}=await import('@earendil-works/pi-ai/compat')
    const candidates=getProviders().flatMap(provider=>getModels(provider).filter(row=>{
      try{return row.id===model&&new URL(row.baseUrl).origin===origin}catch{return false}
    }).map(row=>({provider,row})))
    if(candidates.length){
      contextWindow=Math.min(...candidates.map(c=>c.row.contextWindow));maxOutputTokens=Math.min(...candidates.map(c=>c.row.maxTokens))
      source='pi-catalog';catalogProvider=[...new Set(candidates.map(c=>c.provider))].sort().join(',')
    }
  }
  if(env[MODEL_LIMITS_ENV]){
    const declared=JSON.parse(env[MODEL_LIMITS_ENV])
    if(declared.model===model&&declared.origin===origin){
      if(declared.context_window!==undefined){if(!validModelLimit(declared.context_window))throw Error('MODEL_LIMITS_INVALID');contextWindow=declared.context_window;source='channel'}
      if(declared.max_output_tokens!==undefined){if(!validModelLimit(declared.max_output_tokens))throw Error('MODEL_LIMITS_INVALID');maxOutputTokens=declared.max_output_tokens;source='channel'}
    }
  }
  if(!validModelLimit(contextWindow)||!validModelLimit(maxOutputTokens))throw Error('MODEL_CATALOG_LIMITS_INVALID')
  const capacityWindow=contextWindow,reservationLimit=monetaryContextLimit(env.ANTHROPIC_BASE_URL,model)
  if(reservationLimit!==undefined)contextWindow=Math.min(contextWindow,reservationLimit)
  const output=Math.max(1,Math.min(requestedOutput,maxOutputTokens,Math.floor(contextWindow/2)))
  const reserveTokens=Math.min(Math.floor(contextWindow/2),Math.max(Math.min(25600,Math.floor(contextWindow/4)),output+Math.min(8192,Math.floor(contextWindow/8))))
  return{contextWindow,maxOutputTokens:Math.min(maxOutputTokens,contextWindow-reserveTokens),reserveTokens,keepRecentTokens:Math.min(20000,Math.floor(contextWindow/4)),source,capacityWindow,...(reservationLimit!==undefined?{reservationLimit}:{}),...(catalogProvider?{catalogProvider}:{})}
}
