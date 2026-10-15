import test from 'node:test'
import assert from 'node:assert/strict'
import {selectPreparationChoice,assertPreparationResume,preparationTokenCap,selectClarificationAnswer} from './dispatch-experiment-native-choices.mjs'
const choice=(id,text,visible=true,enabled=true)=>({id,text,visible,enabled})
test('Prefer the fixed desktop shape over delegation and unsupported web choices',()=>{
 assert.equal(selectPreparationChoice([choice('clarification-option-auto','你帮我决定'),choice('clarification-option-web','本地网页应用'),choice('clarification-option-desktop','桌面程序')]),'clarification-option-desktop')
})
test('Both clarification and ordinary cards can delegate; hidden and disabled controls cannot',()=>{
 assert.equal(selectPreparationChoice([choice('clarification-option-auto','你帮我决定',false),choice('card-option-go','直接生成')]),'card-option-go')
 assert.equal(selectPreparationChoice([choice('clarification-option-auto','你帮我决定',true,false)]),undefined)
 assert.equal(selectPreparationChoice([choice('clarification-option-auto','你帮我决定')]),'clarification-option-auto')
 assert.equal(selectPreparationChoice([choice('card-option-web','本地网页应用'),choice('card-option-custom','自定义')]),undefined)
})
test('Resume cannot reset a finished preparation or a different project',()=>{
 assert.doesNotThrow(()=>assertPreparationResume({project_id:'a'},{project_id:'a',state:'prepare'}))
 assert.throws(()=>assertPreparationResume({project_id:'a'},{project_id:'a',state:'prepared'}),/NOT_RESUMABLE/)
 assert.throws(()=>assertPreparationResume({project_id:'a'},{project_id:'b',state:'prepare'}),/NOT_RESUMABLE/)
})
test('Ordinary card labels include descriptions after their titles',()=>{
 assert.equal(selectPreparationChoice([choice('card-option-auto','你帮我决定交给我，按常见做法先出一版')]),'card-option-auto')
 assert.equal(selectPreparationChoice([choice('card-option-web','本地网页应用浏览器打开'),choice('card-option-desktop','桌面程序双击打开，数据存本机文件')]),'card-option-desktop')
})
test('Preparation output caps are bounded and cannot change an execution condition',()=>{
 assert.equal(preparationTokenCap('prepare','16384'),16384)
 assert.equal(preparationTokenCap('prepare','640000'),640000)
 assert.equal(preparationTokenCap('run',undefined),640000)
 for(const value of ['0','-1','Infinity','640001','8192.5']) assert.throws(()=>preparationTokenCap('prepare',value),/INVALID_PREPARATION/)
 assert.throws(()=>preparationTokenCap('run','16384'),/INVALID_PREPARATION/)
})
test('Free-text answers require an unambiguous predefined question match',()=>{
 const answers=[{contains:['备份','格式'],answer:'JSON 文件'}]
 assert.equal(selectClarificationAnswer('备份文件格式未指定',answers),'JSON 文件')
 assert.equal(selectClarificationAnswer('是否加入付费联网功能',answers),undefined)
 assert.equal(selectClarificationAnswer('备份文件格式未指定',[...answers,...answers]),undefined)
 assert.equal(selectClarificationAnswer('其他',[{contains:[],answer:'盲目委托'}]),undefined)
})
