import { it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateExperiment } from '../../../main/desktop/dispatch-experiment'
import { reportModelExperiment } from '../../../main/desktop/dispatch-experiment-report'

let home:string
const project='retired-fixture',run='historic-prepare',at='2026-10-20T00:00:00Z'
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'blhistory-report-'))
  mkdirSync(join(home,'dispatch-experiments/events'),{recursive:true})
  writeFileSync(join(home,'dispatch-experiment-home.json'),JSON.stringify({version:1}))
  const config=validateExperiment({version:1,project_id:project,experiment_id:'historical',run_id:run,mode:'quick',state:'prepare',tasks:[],workers:{}})
  writeFileSync(join(home,'dispatch-experiments',project+'.json'),JSON.stringify(config))
})
afterEach(()=>rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
const event=(event:string,extra:Record<string,unknown>={})=>JSON.stringify({at,project_id:project,run_id:run,event,...extra})
it('reads failed historical preparation and malformed events without rewriting evidence or manufacturing usage',()=>{
  const path=join(home,'dispatch-experiments/events',run+'.jsonl'),text=[event('model_request',{role:'dispatcher',model:'historical-fixture'}),'{damaged',event('run_finished',{outcome:'failed',reason:'HISTORICAL_PREPARATION_FAILURE'})].join('\n')
  writeFileSync(path,text);const configPath=join(home,'dispatch-experiments',project+'.json'),config=readFileSync(configPath)
  const report=reportModelExperiment(project,home)
  expect(report.run_outcome).toBe('failed');expect(report.termination_reason).toBe('HISTORICAL_PREPARATION_FAILURE');expect(report.malformed_events).toBe(1)
  expect(report.product_success).toBeNull();expect(report.product_quality).toBeNull();expect(report.project_usage.complete).toBe(false)
  expect(readFileSync(path,'utf8')).toBe(text);expect(readFileSync(configPath).equals(config)).toBe(true)
})
it('does not turn an unbound historic green score into current product acceptance',()=>{
  writeFileSync(join(home,'dispatch-experiments/events',run+'.jsonl'),event('product_evaluated',{evaluation:{suite_hash:'f'.repeat(64),product_hash:'e'.repeat(64),checks:[],complete:true,score:1,success:true}}))
  const report=reportModelExperiment(project,home)
  expect(report.evaluation_evidence_valid).toBe(false);expect(report.product_success).toBeNull();expect(report.product_quality).toBeNull()
})
it('keeps the real report CLI and rejects restore before writing the requested home',()=>{
  const before=readFileSync(join(home,'dispatch-experiments',project+'.json'))
  const restored=spawnSync(process.execPath,['scripts/dispatch-experiment.mjs','restore','--home',home],{encoding:'utf8',timeout:60000,windowsHide:true})
  expect(restored.status,restored.stderr).toBe(1);expect(restored.stderr).toContain('LEGACY_EXPERIMENT_EXECUTION_RETIRED')
  const report=spawnSync(process.execPath,['scripts/dispatch-experiment.mjs','report','--home',home,'--project',project],{encoding:'utf8',timeout:60000,windowsHide:true})
  expect(report.status,report.stderr).toBe(0);expect(JSON.parse(report.stdout).product_success).toBeNull()
  expect(readFileSync(join(home,'dispatch-experiments',project+'.json')).equals(before)).toBe(true)
},120000)
