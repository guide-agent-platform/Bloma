import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {beforeEach,afterEach,it,expect} from 'vitest'
const require=createRequire(import.meta.url),distribution=require('../../../main/templates/components/distribution/product_distribution.cjs'),efficiency=require('../../../main/templates/components/distribution/product_efficiency.cjs')
let root:string,source:string,runtime:string
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'bloma-product-distribution-'));source=join(root,'source');runtime=join(root,'runtime');mkdirSync(source);mkdirSync(runtime);writeFileSync(join(source,'app.cjs'),'console.log("test fixture")');copyFileSync(resolve('main/templates/components/distribution/product_distribution.cjs'),join(source,'product_distribution.cjs'));writeFileSync(join(runtime,'electron.exe'),'fake executable for file-contract tests only');writeFileSync(join(runtime,'physical.asar'),Buffer.from([1,2,3,4]))})
afterEach(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const build=(name:string,dataSchema=1)=>distribution.buildDistribution({projectDir:source,runtimeDir:runtime,outputDir:join(root,name),entry:'app.cjs',productId:'example-product',dataSchema})
it('hashes physical sources/runtime, refuses missing resources, modified bytes and private product source',async()=>{
 await expect(distribution.buildDistribution({projectDir:source,runtimeDir:runtime,outputDir:join(root,'missing'),entry:'app.cjs',requiredResources:[{path:'missing.model',sha256:'f'.repeat(64)}]})).rejects.toThrow('RESOURCE_MISSING')
 const result=await build('中文 包');expect((await distribution.verifyDistribution(result.root)).id).toBe(result.id)
 writeFileSync(join(result.root,'runtime','physical.asar'),'modified');await expect(distribution.verifyDistribution(result.root)).rejects.toThrow('FILES_CHANGED')
 writeFileSync(join(source,'.env'),'PRIVATE_KEY');await expect(build('private')).rejects.toThrow('PRIVATE_SOURCE_REFUSED')
})
it('installs, upgrades and rolls back without changing external user data, rejects incompatible upgrades before pointer change',async()=>{
 const one=await build('one'),install=join(root,'installed'),data=join(root,'data');mkdirSync(data);writeFileSync(join(data,'records.json'),JSON.stringify({schema_version:1,revision:2,records:{}}));const before=readFileSync(join(data,'records.json'))
 await distribution.installDistribution({bundleDir:one.root,installDir:install,dataDir:data})
 writeFileSync(join(source,'app.cjs'),'console.log("upgraded fixture")');const two=await build('two')
 expect((await distribution.installDistribution({bundleDir:two.root,installDir:install,dataDir:data})).previous).toBe(one.id)
 expect((await distribution.installDistribution({bundleDir:two.root,installDir:install,dataDir:data})).previous).toBe(one.id)
 const pointer=readFileSync(join(install,'current.json'));const incompatible=await build('incompatible',2)
 await expect(distribution.installDistribution({bundleDir:incompatible.root,installDir:install,dataDir:data})).rejects.toThrow('MIGRATION_REQUIRED');expect(readFileSync(join(install,'current.json'))).toEqual(pointer)
 expect((await distribution.rollbackDistribution(install)).current).toBe(one.id);expect(readFileSync(join(data,'records.json'))).toEqual(before)
})
it('freezes comparison identity, rejects duplicates/missing real conditions/evidence and retains failures instead of claiming acceleration',()=>{
 const protocol={version:1,status:'preregistered',tasks:[{id:'C1',input_sha256:'a'.repeat(64),required_cases:['source','sync']}],variants:{baseline:'v1',templates:'v2'},environment:'same-machine',design:'frozen-design',scope:'real_services',model:'test-protocol-only',channel:'declared-test-channel',account_scope:'declared-account-hash',budget_rmb:10}
 const directory=join(root,'measurements'),recorder=efficiency.createEfficiencyRecorder(directory,protocol)
 const run=(variant:string)=>({sample_id:variant,protocol_id:recorder.id,task_id:'C1',variant,version:variant==='baseline'?'v1':'v2',input_sha256:'a'.repeat(64),environment:protocol.environment,design:protocol.design,model:protocol.model,channel:protocol.channel,account_scope:protocol.account_scope,service_scope:'real',outcome:'delivered',independent_verification:true,cases:{source:'passed',sync:'passed'},elapsed_ms:variant==='baseline'?100:80,cost_rmb:1,physical_requests:2,user_interventions:0,failures:[],evidence:[{path:'evidence.txt',sha256:hash('evidence fixture not real service evidence')}]})
 expect(()=>efficiency.createEfficiencyRecorder(directory,{...protocol,budget_rmb:20})).toThrow('FROZEN')
 expect(()=>efficiency.createEfficiencyRecorder(join(root,'invalid'),{...protocol,budget_rmb:0})).toThrow('INVALID')
 recorder.record(run('baseline'));expect(()=>recorder.record(run('baseline'))).toThrow()
 expect(recorder.analyze()).toMatchObject({eligible:false,pairs:[]});recorder.record(run('templates'));expect(recorder.analyze().reasons).toContain('EVIDENCE_FILE_INVALID')
 writeFileSync(join(directory,'evidence.txt'),'evidence fixture not real service evidence')
 // Eligibility here is a schema/file-evidence fixture; no external run is represented by this unit test.
 expect(recorder.analyze().pairs[0].time_difference_ms).toBe(20)
 const failed={...run('templates'),outcome:'failed',failures:['bad output'],cost_rmb:undefined}
 const invalid=efficiency.analyzeEfficiency(protocol,[run('baseline'),failed],{evidenceRoot:directory});expect(invalid.eligible).toBe(false);expect(invalid.pairs).toEqual([]);expect(invalid.runs[1].failures).toEqual(['bad output'])
 expect(efficiency.analyzeEfficiency(protocol,[run('baseline'),run('templates')]).reasons).toContain('UNVERIFIED_EVIDENCE_FILES')
})
