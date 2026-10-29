import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),out=path.resolve(process.env.BLOMA_TEMPLATE_EVIDENCE_DIR||path.join(root,'run-artifacts/template-rollout-20261029')),sources=new Map()
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
for(const folder of fs.readdirSync(path.join(root,'main/templates/components')))for(const name of fs.readdirSync(path.join(root,'main/templates/components',folder))){assert.ok(!sources.has(name));sources.set(name,path.join(root,'main/templates/components',folder,name))}
for(const name of fs.readdirSync(path.join(root,'main/templates/tools')))if(!sources.has(name))sources.set(name,path.join(root,'main/templates/tools',name))
const workbench=JSON.parse(fs.readFileSync(path.join(out,'workbench-report.json'),'utf8')),distribution=JSON.parse(fs.readFileSync(path.join(out,'distribution-report.json'),'utf8'))
assert.equal(workbench.status,'passed');assert.equal(distribution.status,'passed')
const verified=await require('../main/templates/components/distribution/product_distribution.cjs').verifyDistribution(distribution.artifact)
assert.equal(verified.id,distribution.bundle_one)
let checks=0
for(const [name,file]of sources){
 if(workbench.product_files[name]){assert.equal(workbench.product_files[name],sha(file),'GUI evidence source changed: '+name);checks++}
 const packaged=verified.manifest.app.find(row=>row.path===name)
 if(packaged){assert.equal(packaged.sha256,sha(file),'Packaged source changed: '+name);checks++}
}
const report={status:'passed',scope:'local evidence and physical artifact source binding; not external-service acceptance',source_checks:checks,workbench_cases:workbench.cases.length,portable_cases:distribution.cases.length,artifact:distribution.artifact,artifact_id:verified.id}
fs.writeFileSync(path.join(out,'source-match.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
