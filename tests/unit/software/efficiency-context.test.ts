import {createHash} from 'node:crypto'
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {buildRepositoryContextTool} from '../../../main/software/repository-context'
import {buildProductionContextTool} from '../../../main/desktop/production-context'
import {leanBudget} from '../../../main/desktop/lean-budget'
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-efficiency-'));process.env.PROMA_HOME=home;project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const ctx=()=>({projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(10000),state:createToolState()})
it('finds transitive test candidates, includes deleted imports and marks dynamic/unknown languages incomplete without skipping formal gates',async()=>{
 const root=project.root_path;mkdirSync(join(root,'src'));mkdirSync(join(root,'tests'))
 writeFileSync(join(root,'src/value.ts'),'export const value=1')
 writeFileSync(join(root,'src/logic.ts'),'export {value} from "./value.js"')
 writeFileSync(join(root,'tests/logic.test.ts'),'import {value} from "../src/logic"; export const expected=value')
 writeFileSync(join(root,'tests/unrelated.test.ts'),'export const independent=true')
 const tool=buildRepositoryContextTool(project.project_id),result=await tool.execute({mode:'impact',paths:['src/value.ts']},ctx())
 expect(result.isError,result.output).not.toBe(true);const found=JSON.parse(result.output)
 expect(found.suggested_tests).toEqual(['tests/logic.test.ts']);expect(found.affected).toContain('src/logic.ts');expect(found.formal_acceptance).toBe('unchanged_full_gate')
 rmSync(join(root,'src/value.ts'));expect(JSON.parse((await tool.execute({mode:'impact',paths:['src/value.ts']},ctx())).output).suggested_tests).toEqual(['tests/logic.test.ts'])
 writeFileSync(join(root,'src/dynamic.js'),'const route="./logic";import(route)')
 const partial=JSON.parse((await tool.execute({mode:'impact',paths:['src/data.py']},ctx())).output);expect(partial.partial).toBe(true);expect(partial.dynamic_imports).toBe(1)
 expect((await tool.execute({mode:'impact',paths:['../outside.ts']},ctx())).isError).toBe(true)
 expect((await tool.execute({mode:'impact',paths:['D:outside.ts']},ctx())).isError).toBe(true)
})
it('summarizes a historical failure with unknown cause, scrubs credentials and cannot turn a corrupt receipt into success or reset accounting',async()=>{
 const budget=leanBudget(project.project_id,'desktop-implement').snapshot(),dir=join(home,'software-verification');mkdirSync(dir)
 mkdirSync(dirname(budget.file),{recursive:true});writeFileSync(budget.file,JSON.stringify({version:1,requests:7,output:123,phases:{'desktop-implement':7}}));const budgetBefore=readFileSync(budget.file,'utf8')
 const result={status:'failed',failure:{category:'unknown',classification_basis:'unresolved',code:'LOCATOR_PENDING',expected:'目标控件',actual:'Authorization: Bearer PRIVATE_DIAGNOSTIC_KEY',next:'先看实际界面'},core:{host_gui:{case_results:[{name:'F-001 pending',status:'not_run',error:'api_key=PRIVATE_DIAGNOSTIC_KEY'}]}}}
 const file=join(dir,project.project_id+'.json');writeFileSync(file,JSON.stringify({version:1,state:'complete',at:Date.now(),result,result_hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')}))
 const tool=buildProductionContextTool(project.project_id),output=await tool.execute({topic:'diagnostics'},ctx());expect(output.isError,output.output).not.toBe(true)
 const facts=JSON.parse(output.output);expect(facts.verification).toMatchObject({historical:true,revalidated:false,status:'failed',failure:{category:'unknown',classification_basis:'unresolved'}});expect(output.output).not.toContain('PRIVATE_DIAGNOSTIC_KEY')
 writeFileSync(file,'corrupt');const broken=JSON.parse((await tool.execute({topic:'diagnostics'},ctx())).output);expect(broken.verification.available).toBe(false)
 expect(readFileSync(budget.file,'utf8')).toBe(budgetBefore)
 for(const topic of ['components','ai-service'])expect((await tool.execute({topic},ctx())).isError).not.toBe(true)
})
