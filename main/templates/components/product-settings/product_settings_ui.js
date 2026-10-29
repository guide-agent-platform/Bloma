(function(global){
  'use strict'
  const messages={SETTINGS_SAVE_OUTCOME_UNKNOWN:'保存结果需要核对，已保留相关密钥。请重新载入设置，并检查数据目录权限。',AI_SETTINGS_STALE:'设置已被其他窗口修改。请重新载入后再编辑。',SETTINGS_ENCRYPTION_UNAVAILABLE:'系统加密不可用，Key 未保存。请恢复系统密钥服务后重试。',AI_ROUTE_INVALID:'服务参数无效，请检查地址、模型和数值范围。',AI_ROUTES_INVALID:'服务配置无效，请检查配置文件。',SETTINGS_OPERATION_FAILED:'操作失败，请重新载入核对保存状态，并检查数据目录权限或配置文件。'}
  const connectionText={not_checked:'尚未检查连接',connected:'连接检查成功；模型效果仍需实际业务验证',auth_error:'鉴权失败，请检查 Key',rate_limited:'服务限流，请稍后重试',unconfigured:'请先填写地址、模型和 Key',cancelled:'连接检查已取消',timeout:'连接检查超时',stale:'设置已变化，请重新检查',invalid_response:'服务返回格式不符，请检查协议',model_error:'服务请求失败'}
  function mountProductSettings(root,bridge){
    root.innerHTML='<h1>服务设置</h1><p>使用你自己的 AI 服务，处理文字与图片。</p><form><label>当前服务<select name="route"></select></label><fieldset><label>协议<select name="protocol"><option value="openai-chat">OpenAI Chat 兼容</option><option value="anthropic-messages">Anthropic Messages 兼容</option></select></label><label>API 基地址<input name="endpoint" type="url" placeholder="https://api.example.com/v1" maxlength="2048"></label><label>模型<input name="model" placeholder="填写服务提供的模型名称" maxlength="160"></label><label>Key<input name="key" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已有 Key"></label><span class="note" data-key-state></span><label>网络范围<select name="network"><option value="public">HTTPS 公网服务</option><option value="loopback">仅本机服务</option></select></label><label>超时（秒）<input name="timeout" type="number" min="0.1" max="60" step="0.1"></label><label>最大输出 token<input name="max_tokens" type="number" min="1" max="8192" step="1"></label><label>输出参数<select name="token_parameter"><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label><label>默认服务<select name="default_route"></select></label></fieldset><div class="actions"><button type="submit">保存设置</button><button type="button" data-reset>取消修改 / 重新载入</button></div><output role="status" aria-live="polite" data-status></output><label data-check-consent><input type="checkbox" name="consent">我同意向当前已保存服务发送一条短请求，可能产生费用。</label><div class="actions"><button type="button" data-check>检查已保存的连接</button><button type="button" data-stop disabled>取消检查</button></div><output role="status" data-connection></output></form><footer>配置保存、连接检查和实际模型效果分别确认。Key 只在本产品后台使用。</footer>'
    const form=root.querySelector('form'),field=name=>form.elements.namedItem(name),status=root.querySelector('[data-status]'),connection=root.querySelector('[data-connection]')
    const reset=root.querySelector('[data-reset]'),check=root.querySelector('[data-check]'),stop=root.querySelector('[data-stop]'),submit=form.querySelector('[type=submit]')
    const editable=['protocol','endpoint','model','network','timeout','max_tokens','token_parameter']
    let snapshot,config,keys=Object.create(null),dirty=false,busy=false,checking=false,disposed=false,epoch=0
    const say=value=>{status.textContent=value}
    function controls(){
      form.querySelector('fieldset').disabled=busy||!snapshot
      field('route').disabled=busy||!snapshot
      submit.disabled=busy||!dirty||!snapshot
      reset.disabled=busy
      check.disabled=busy||checking||dirty||!snapshot||!field('consent').checked
      stop.disabled=!checking
    }
    function showRoute(){
      const row=config.routes[field('route').value]
      for(const name of editable)field(name).value=row[name]??(name==='token_parameter'?'max_tokens':'')
      field('key').value=''
      const present=snapshot.routes.find(r=>r.name===field('route').value)?.key_available
      root.querySelector('[data-key-state]').textContent=Object.hasOwn(keys,field('route').value)?'新 Key 待保存':snapshot.encryption==='unavailable'?'系统加密不可用，无法保存或使用 Key':present?'已保存 Key（不可回读）':'尚未保存 Key'
      connection.textContent=connectionText[snapshot.connection.route===field('route').value?snapshot.connection.kind:'not_checked']??'连接检查未成功'
    }
    function accept(value){
      snapshot=value;config={version:1,default_route:value.settings.default_route,routes:Object.create(null)}
      keys=Object.create(null);dirty=false
      for(const row of value.settings.routes){const {name,configured,...publicRow}=row;config.routes[name]=publicRow}
      for(const name of ['route','default_route']){
        field(name).replaceChildren(...value.settings.routes.map(row=>{const option=document.createElement('option');option.value=row.name;option.textContent=row.name;return option}))
        field(name).value=config.default_route
      }
      field('consent').checked=false;showRoute();controls()
    }
    async function load(){
      const token=++epoch;busy=true;controls()
      try{const result=await bridge.read();if(disposed||token!==epoch)return;if(!result.ok)throw result;accept(result.value);say('已载入。填写配置不代表服务已连接。')}
      catch(error){if(!disposed)say(messages[error.code]??'无法读取设置，请检查配置后重新载入。')}
      finally{if(!disposed&&token===epoch){busy=false;controls()}}
    }
    form.addEventListener('input',event=>{
      if(event.target===field('consent')){controls();return}
      if(!snapshot||event.target===field('route'))return
      const route=field('route').value
      if(event.target===field('key')){if(field('key').value)keys[route]=field('key').value;else delete keys[route]}
      else if(event.target===field('default_route'))config.default_route=field('default_route').value
      else for(const name of editable)config.routes[route][name]=['timeout','max_tokens'].includes(name)?Number(field(name).value):field(name).value
      dirty=true;connection.textContent='有未保存修改，请保存后重新检查连接';say('修改尚未保存');controls()
    })
    field('route').addEventListener('change',showRoute)
    reset.addEventListener('click',()=>{keys=Object.create(null);field('key').value='';load()})
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!snapshot)return
      busy=true;controls()
      try{const result=await bridge.save({config,revision:snapshot.settings.revision,keys});if(disposed)return;if(!result.ok)throw result;accept(result.value);say('设置已保存。')}
      catch(error){if(!disposed)say(messages[error.code]??'保存失败，请检查配置或系统密钥服务。')}
      finally{keys=Object.create(null);field('key').value='';busy=false;if(!disposed)controls()}
    })
    check.addEventListener('click',async()=>{
      if(check.disabled)return
      checking=true;connection.textContent='正在检查已保存的连接…';controls()
      const revision=snapshot.settings.revision,route=field('route').value
      try{const result=await bridge.check({revision,route,consent:true});if(disposed)return;if(!result.ok)throw result
        if(snapshot.settings.revision===revision&&!dirty){snapshot.connection=result.value;if(field('route').value===route)connection.textContent=connectionText[result.value.kind]??'连接检查未成功'}
      }catch(error){if(!disposed)connection.textContent=messages[error.code]??'连接检查失败'}
      finally{checking=false;if(!disposed)controls()}
    })
    stop.addEventListener('click',()=>bridge.cancel())
    controls();load()
    return()=>{disposed=true;epoch++;keys=Object.create(null);field('key').value='';bridge.cancel();root.replaceChildren()}
  }
  global.mountProductSettings=mountProductSettings
  const root=document.getElementById('settings');if(root&&global.productSettings)mountProductSettings(root,global.productSettings)
})(window)
