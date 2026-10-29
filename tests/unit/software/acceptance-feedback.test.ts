import { it, expect } from 'vitest'
import { nativeGuiObservations } from '../../../main/software/native-gui-tests'
import { guiFeatureResults } from '../../../main/desktop/gui-feature-results'
import { verificationFailure } from '../../../main/software/verification-diagnostics'
const suite={covers:['F-001','F-002','F-003'],native_tests:{cases:[{name:'F-001 save',feature:'F-001'},{name:'F-002 reject',feature:'F-002'},{name:'F-003 reopen',feature:'F-003'}]}} as never
function observed(){return nativeGuiObservations(suite,[{code:1,events:[{type:'test:pass',name:'F-001 save'},{type:'test:fail',name:'F-002 reject',error:'expected actual',assertion:{expected:'required',actual:'accepted'}}].map(row=>JSON.stringify(row)).join('\n'),
  trace:JSON.stringify({interactions:2,assertions:1,cases:[{name:'F-001 save',interactions:1,assertions:1},{name:'F-002 reject',interactions:1,assertions:0}]})}])}
it('keeps completed, failed and unexecuted native cases distinct while the whole suite fails',()=>{
  const result=observed();expect(result.status).toBe('failed');expect(result.case_results.map(row=>row.status)).toEqual(['passed','failed','not_run'])
  const rows=guiFeatureResults({...result,version:1,scope:'host_native_gui_business',suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:true})
  expect(rows.map(row=>row.status)).toEqual(['passed','failed','unverified']);expect(rows[2].not_run).toBe(true)
})
it('does not promote zero-assertion, skipped or missing cases into passed features',()=>{
  const result=nativeGuiObservations(suite,[{code:0,events:JSON.stringify({type:'test:pass',name:'F-001 save',skip:true}),trace:JSON.stringify({interactions:1,assertions:0,cases:[]})}])
  expect(result.status).toBe('unverified');expect(result.case_results.every(row=>row.status==='not_run')).toBe(true)
  const rows=guiFeatureResults({...result,version:1,scope:'host_native_gui_business',suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:true})
  expect(rows.every(row=>row.status==='unverified')).toBe(true)
})
it('invalidates passed case claims on runtime errors or changed source and keeps legacy failures conservative',()=>{
  const gui={...observed(),version:1 as const,scope:'host_native_gui_business' as const,suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:false}
  expect(guiFeatureResults(gui)[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,source_unchanged:true,failure_kind:'runtime'})[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,source_unchanged:true,native_evidence:{interactions:0,assertions:1}})[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,case_results:undefined}).every(row=>row.status==='unverified')).toBe(true)
})
it('reports bootstrap separately and never clears an earlier failure with a later success',()=>{
  const bootstrap=nativeGuiObservations(suite,[{code:1,events:JSON.stringify({type:'test:fail',name:'loader',error:'Cannot find package'}),trace:'{"interactions":0,"assertions":0,"cases":[]}'}])
  expect(bootstrap).toMatchObject({status:'unverified',failure_kind:'bootstrap'})
  const repeated=nativeGuiObservations(suite,[{code:1,events:[{type:'test:fail',name:'F-001 save',error:'bad'},{type:'test:pass',name:'F-001 save'}].map(row=>JSON.stringify(row)).join('\n'),trace:'{"interactions":1,"assertions":1,"cases":[{"name":"F-001 save","assertions":1,"interactions":1}]}'}])
  expect(repeated.case_results[0].status).toBe('failed');expect(repeated.status).toBe('failed')
})
it('uses structured execution evidence and leaves a locator timeout root cause unresolved',()=>{
  const result={status:'failed' as const,summary:'actual GUI check failed',core:{host_gui:{failure_kind:'assertion',steps:[{id:'one',passed:false,actual:{error:'TimeoutError waiting for locator',assertion:{}}}]}}} as never
  expect(verificationFailure(result)).toMatchObject({category:'unknown',classification_basis:'unresolved',next_tool:'inspect_app'})
  const assertion={status:'failed',summary:'check failed',core:{host_gui:{failure_kind:'assertion',steps:[{id:'one',passed:false,actual:{assertion:{expected:1,actual:0}}}]}}} as never
  expect(verificationFailure(assertion)).toMatchObject({category:'product_assertion',classification_basis:'assertion'})
})
