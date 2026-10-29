import type { GuiAcceptanceResult } from './gui-acceptance'

/** Local case evidence only; no claim of exhaustive implementation or AI quality. */
export function guiFeatureResults(gui: GuiAcceptanceResult) {
  if(!gui.case_results)return gui.covers.map(id=>({id,status:gui.status==='passed'?'passed' as const:'unverified' as const,cases:[] as string[],not_run:gui.status!=='passed'}))
  if(gui.case_results.some(row=>!gui.covers.includes(row.feature)||!['passed','failed','unverified','not_run'].includes(row.status)
    ||!Number.isSafeInteger(row.assertions)||row.assertions<0||!Number.isSafeInteger(row.interactions)||row.interactions<0))throw Error('GUI_CASE_RESULT_INVALID')
  return gui.covers.map(id=>{
    const rows=gui.case_results!.filter(row=>row.feature===id)
    let status: 'passed'|'failed'|'unverified'=rows.some(row=>row.status==='failed')?'failed':rows.length&&rows.every(row=>row.status==='passed'&&row.assertions>0)?'passed':'unverified'
    if(status==='passed'&&(gui.source_unchanged===false||gui.native_evidence?.interactions===0||gui.failure_kind==='runtime'||gui.failure_kind==='bootstrap'
      ||gui.status!=='passed'&&gui.source_unchanged!==true))status='unverified'
    return{id,status,cases:rows.map(row=>row.name),not_run:!rows.length||rows.some(row=>row.status==='not_run')}
  })
}
