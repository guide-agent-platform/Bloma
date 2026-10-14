import test from 'node:test'
import assert from 'node:assert/strict'
import {selectPreparationChoice,assertPreparationResume} from './dispatch-experiment-native-choices.mjs'
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
