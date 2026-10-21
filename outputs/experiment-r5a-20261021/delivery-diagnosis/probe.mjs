import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire('C:/Users/17359/OneDrive/Desktop/guide-agent-platform-sprint0/package.json');
const {JSDOM}=require('jsdom');
const root='C:/Users/17359/bex-pv220/pilot-r5a/cohort/G11/agent-workspaces/default-software-builder/generated-projects/42487b23-f6c0-47e5-b46b-f607b105ae7b';
const html=fs.readFileSync(root+'/ui/index.html','utf8'),bridge=fs.readFileSync(root+'/ui/bridge.js','utf8');
const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
assert.equal(inline.length,1);
const hashes=()=>Object.fromEntries(['ui/index.html','ui/bridge.js','app.py'].map(p=>[p,createHash('sha256').update(fs.readFileSync(root+'/'+p)).digest('hex')]));
const before=hashes();
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
async function scenario(delayed){
 const dom=new JSDOM(html,{url:'http://local.invalid/index.html',runScripts:'outside-only'}),w=dom.window,timers=[],calls=[];
 w.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 const data=[{id:'saved-1',title:'已保存任务',done:true}];
 const snapshot=view=>({ok:true,view,tasks:data.filter(t=>view==='all'||t.done===(view==='completed')),counts:{all:data.length,active:data.filter(t=>!t.done).length,completed:data.filter(t=>t.done).length}});
 const api={list_tasks:async(view='all')=>{calls.push({op:'list_tasks',view});return JSON.stringify(snapshot(view));},add_task:async(title,view='all')=>{calls.push({op:'add_task',title,view});const added={id:'new-1',title:title.trim(),done:false};data.push(added);return JSON.stringify({...snapshot(view),added});}};
 if(!delayed)w.pywebview={api};
 w.eval(bridge);w.eval(inline[0]);w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await flush();
 const fire=async(ms)=>{const selected=timers.filter(t=>t.ms===ms);for(const t of selected){timers.splice(timers.indexOf(t),1);t.fn();}await flush();};
 await fire(300);if(delayed)await fire(120);
 const state=()=>({rows:[...w.document.querySelectorAll('article.task')].map(e=>e.querySelector('.task-title').textContent),banner:w.document.querySelector('.w-banner').textContent,view:w.document.querySelector('.view-btn[aria-pressed="true"]').dataset.view});
 const initial=state();
 if(delayed){w.pywebview={api};w.dispatchEvent(new w.Event('pywebviewready'));await flush();const afterReady=state();assert.equal(afterReady.rows.length,0);assert(afterReady.banner.includes('桥未就绪'));assert.equal(calls.length,0);w.close();return{initial,after_bridge_ready:afterReady,calls,recovered_automatically:false};}
 assert.deepEqual(initial.rows,['已保存任务']);
 w.document.querySelector('[data-view="completed"]').click();await flush();
 w.document.querySelector('#task-input').value='新增未完成任务';w.document.querySelector('#btn-add').click();await flush();
 const afterAdd=state();assert.equal(afterAdd.view,'completed');assert.deepEqual(afterAdd.rows,['已保存任务']);assert.equal(data.length,2);
 assert(calls.some(c=>c.op==='add_task'&&c.view==='all'));assert.equal(calls.at(-1).view,'completed');w.close();
 return{initial,after_add_in_completed_view:afterAdd,calls,view_preserved_by_refresh:true};
}
const control=await scenario(false),delayed=await scenario(true),after=hashes();assert.deepEqual(after,before);
const result={at:new Date().toISOString(),scope:'Offline DOM execution of actual generated inline UI and actual bridge.js; injected Python API and controlled timer order; not a real WebView startup-frequency test',paid_model_calls:0,control,delayed_bridge:delayed,source_unchanged:true,source_hashes:after};
fs.writeFileSync(new URL('./probe.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
