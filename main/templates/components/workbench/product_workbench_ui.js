(function(){
 const api=window.productWorkbench,$=id=>document.getElementById(id),selected=new Set()
 let status,listing,current,focusId,queryEpoch=0,focusEpoch=0,busy=false,lastSignature='',connectionRevision,connectionLoaded=false
 const say=text=>{$('notice').textContent=text}
 async function call(method,input){const result=await api[method](input);if(!result.ok)throw result;return result.value}
 function button(label,fn){const item=document.createElement('button');item.type='button';item.textContent=label;item.onclick=fn;return item}
 async function perform(fn,message){if(busy)return;busy=true;try{const value=await fn();say(value?.archived===true?'该任务已归档，未重新执行；请查看已有资料或结果':message);await refresh(true);return value}catch(error){say((error.next??'操作失败，请核对设置与当前状态')+' ['+(error.code??'UNKNOWN')+']')}finally{busy=false}}
 async function query(){
  const epoch=++queryEpoch,value=await call('query',{query:$('query').value,type:$('type').value||undefined,sort:$('sort').value,page:listing?.page??1,selected:[...selected]})
  if(epoch!==queryEpoch)return
  listing=value;selected.clear();for(const id of value.selected)selected.add(id)
  $('count').textContent='找到 '+value.total+' 条记录';$('pages').textContent='第 '+value.page+' / '+value.pages+' 页';$('prev').disabled=value.page<=1;$('next').disabled=value.page>=value.pages
  $('records').replaceChildren(...value.rows.map(row=>{
   const tr=document.createElement('tr');tr.dataset.id=row.id;tr.setAttribute('aria-selected',String(row.id===focusId))
   const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selected.has(row.id);checkbox.setAttribute('aria-label','选择 '+(row.data.name??row.id));checkbox.onchange=()=>checkbox.checked?selected.add(row.id):selected.delete(row.id)
   const choice=document.createElement('td');choice.append(checkbox)
   const title=document.createElement('td');title.append(button(row.displayName,()=>focus(row.id)))
   const kind=document.createElement('td');kind.textContent=({asset:'来源文件',analysis:'分析结果',document:'文档内容',remote:'外部记录',outbound:'同步记录',import_preview:'导入预览',cursor:'同步游标',event:'通知记录'})[row.type]??row.type
   const revision=document.createElement('td');revision.textContent=String(row.revision);tr.append(choice,title,kind,revision);return tr
  }))
 }
 async function focus(id){
  const epoch=++focusEpoch;focusId=id;current=null;$('source').textContent='正在载入来源…';$('preview-image').hidden=true;$('record-detail').textContent='';$('correction').value=''
  try{const value=await call('inspect',{id});if(epoch!==focusEpoch)return;current=value
   $('source').textContent=value.source?value.source.name+' · '+({image:'图片',audio:'音频',document:'文档'})[value.source.kind]+' · 来源 '+value.source.sha256.slice(0,12):'当前选择的记录'
   $('source').title=value.source?.sha256??value.record.id
   if(value.image){$('preview-image').src=value.image;$('preview-image').hidden=false}
   const row=value.record
   const modeLabel={vision:'AI图片理解',ocr:'本机文字识别',audio:'音频转写'},stateLabel={pending:'写入结果待核对',unknown:'写入结果未知，请先核对外部系统',done:'已同步',rejected:'服务拒绝写入',not_applied:'已核对，确认未写入'}
   $('record-detail').textContent=row.type==='document'?row.data.document.blocks.map(item=>item.text).join('\n'):row.type==='analysis'?modeLabel[row.data.mode]+' · '+(row.data.corrected?'已人工校正':'结果待核对')+'\n原始结果：'+row.data.originalText:row.type==='asset'?'来源已保存，大小 '+row.data.bytes+' 字节。请选择处理方式。':row.type==='import_preview'?value.previewRows.map(item=>item.name+'：'+(item.ok?'可提交':'解析失败')+'\n'+item.summary).join('\n\n'):row.type==='outbound'?(!row.data.destination_scope?'该旧记录未绑定发送目标，请先核对。':stateLabel[row.data.status]+'\n目标：'+row.data.destination_url):row.type==='remote'?Object.entries(row.data.fields).map(([name,value])=>name+'：'+String(value)).join('\n'):'状态已保存，可在关联操作中核对。'
   $('correction').value=row.type==='analysis'?row.data.text:''
   if(value.source)$('mode').value=value.source.kind==='audio'?'audio':'vision'
   if(row.type==='outbound')$('reconcile-id').value=row.id
   await query()
  }catch(error){if(epoch===focusEpoch)say('无法读取所选资料，请核对来源文件。')}
 }
 function loadConnection(){
  connectionLoaded=true
  const row=status?.connections.records[$('connection').value],form=$('connection-form'),field=name=>form.elements.namedItem(name)
  connectionRevision=row?.revision??0
  const config=row?.data??{name:'我的连接',baseUrl:'',network:'public',readPath:'items',writePath:'items',writeMethod:'POST',itemsPath:'items',nextPath:'next',checkpointPath:'checkpoint',cursorParam:'cursor',idPath:'id',versionPath:'version',mapping:{title:'title'}}
  for(const key of ['name','baseUrl','network','readPath','writePath','writeMethod'])field(key).value=config[key]
  const mapping={};for(const key of ['itemsPath','nextPath','checkpointPath','cursorParam','idPath','versionPath','mapping','authHeader','authPrefix'])if(config[key]!==undefined)mapping[key]=config[key]
  field('mappingConfig').value=JSON.stringify(mapping,null,2);field('key').value='';field('webhookKey').value=''
 }
 async function refresh(force=false){
  const next=await call('status'),signature=JSON.stringify([next.revision,next.sync.revision,next.jobs.map(row=>[row.id,row.state,row.progress])]);status=next
  $('resource-status').textContent=next.resources.audio==='unavailable'?'音频转写资源未准备，请先完成离线资源设置。':'音频资源已配置，实际处理结果仍需核对。'
  if(force||signature!==lastSignature){lastSignature=signature;await query();renderJobs()}
  const previous=$('connection').value,known=Object.keys(next.connections.records)
  const oldOptions=[...$('connection').options].map(option=>[option.value,option.textContent]),options=[...known.map(id=>[id,next.connections.records[id].data.name]),['new','新建连接']]
  if(JSON.stringify(options)!==JSON.stringify(oldOptions)){$('connection').replaceChildren(...options.map(([id,name])=>{const option=document.createElement('option');option.value=id;option.textContent=name;return option}));$('connection').value=known.includes(previous)?previous:known[0]??'new';if(previous!==$('connection').value||!connectionLoaded)loadConnection()}
 }
 function renderJobs(){
  const labels={queued:'等待处理',running:'处理中',cancelling:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消',interrupted:'中断 / 待核对'}
  $('jobs').replaceChildren(...status.jobs.slice(-20).reverse().map(row=>{
   const div=document.createElement('div');div.className='job';div.dataset.job=row.id
   const kind=({parse:'文档解析',pull:'拉取记录',sync:'同步结果',media:row.input.mode==='audio'?'音频转写':row.input.mode==='ocr'?'文字识别':'图片理解'})[row.type]??'处理任务'
   const text=document.createElement('span');text.textContent=kind+' · '+labels[row.state]+(row.error?' · 请核对来源或服务状态':'')+' ';text.title=row.error??'';const progress=document.createElement('progress');progress.max=1;progress.value=row.progress;div.append(text,progress)
   if(['queued','running'].includes(row.state))div.append(button('取消',()=>perform(()=>call('cancel',{id:row.id}),'已请求取消，请等待任务终态')))
   if(['failed','cancelled','interrupted'].includes(row.state)){
    if(row.needs_review){const note=document.createElement('span');note.textContent=' 请先核对远端写入，再明确恢复。';div.append(note)}
    div.append(button(row.needs_review?'已核对，恢复任务':'恢复任务',()=>perform(()=>{if(row.needs_review&&!window.confirm('已核对外部系统，并确认从检查点恢复不会重复写入？'))return;return call('resume',{id:row.id,reviewed:row.needs_review===true})},'已重新入队')))
   }
   const id=row.result?.previewId??row.result?.resultId;if(id)div.append(button(row.result.previewId?'查看导入预览':'查看结果',()=>focus(id)))
   return div
  }))
 }
 $('toggle-settings').onclick=()=>{$('settings').hidden=!$('settings').hidden}
 $('import').onclick=()=>perform(async()=>{const result=await call('selectFiles',{kind:$('file-kind').value});$('batch-results').textContent=[...result.imported.map(row=>row.data.name+'：已导入'),...result.failed.map(row=>row.name+'：无法导入，请核对格式与大小')].join('\n');if(result.imported[0])await focus(result.imported[0].id)},'导入结果已更新，请核对逐项状态')
 $('parse').onclick=()=>perform(()=>call('parse',{ids:[...selected]}),'文档解析已入队，成功后查看导入预览')
 $('commit').onclick=()=>perform(()=>{if(current?.record.type!=='import_preview')throw{code:'FILES_PREVIEW_STALE',next:'请先选择一份导入预览'};return call('commit',{id:current.record.id,revision:current.record.revision,dedupe:false})},'预览已提交，成功资料已保存')
 $('analyze').onclick=()=>perform(()=>{if(!current?.source)throw{code:'MEDIA_INPUT_INVALID',next:'请先选择来源图片或音频'};return call('analyze',{assetId:current.source.id,mode:$('mode').value,prompt:$('prompt').value,language:$('language').value,consent:$('ai-consent').checked})},'处理已入队，完成后查看对应结果')
 $('correct').onclick=()=>perform(async()=>{if(current?.record.type!=='analysis')throw{code:'MEDIA_RESULT_STALE',next:'请先选择一份分析结果'};await call('correct',{resultId:current.record.id,expectedRevision:current.record.revision,text:$('correction').value});await focus(current.record.id)},'人工校正已保存，原始结果仍保留')
 $('pull').onclick=()=>perform(()=>call('pull',{connectionId:$('connection').value}),'拉取已入队，游标仅在全部记录提交后更新')
 $('sync').onclick=()=>perform(()=>{if(current?.record.type!=='analysis')throw{code:'MEDIA_RESULT_STALE',next:'请先选择一份分析结果'};return call('sync',{connectionId:$('connection').value,resultId:current.record.id,revision:current.record.revision,consent:$('sync-consent').checked})},'同步已入队，请核对任务与同步记录')
 $('webhook').onclick=()=>perform(async()=>{const result=await call('startWebhook',{connectionId:$('connection').value});$('webhook-url').textContent='仅本机接收：'+result.url},'本机通知入口已开启；公网部署须另外配置')
 $('connection').onchange=loadConnection;$('connection-reset').onclick=()=>perform(async()=>{status=await call('status');loadConnection()},'已重新载入连接设置，草稿已丢弃')
 $('connection-form').onsubmit=event=>{event.preventDefault();perform(async()=>{
  const form=$('connection-form'),field=name=>form.elements.namedItem(name),old=status.connections.records[$('connection').value],config={...(old?.data??{}),...JSON.parse(field('mappingConfig').value)}
  for(const name of ['name','baseUrl','network','readPath','writePath','writeMethod'])config[name]=field(name).value
  try{await call('saveConnection',{id:old?.id??'connection_'+Date.now(),revision:status.connections.revision,entityRevision:connectionRevision,config,key:field('key').value,webhookKey:field('webhookKey').value});status=await call('status');loadConnection()}finally{field('key').value='';field('webhookKey').value=''}
 },'连接设置已保存；保存不会请求外部服务')}
 $('export').onclick=()=>perform(()=>call('export'),'备份操作已结束，请核对所选文件')
 $('restore').onclick=()=>perform(async()=>{if(!window.confirm('将恢复所选备份，当前记录会先备份。继续？'))return;await call('restore',{revision:status.revision});focusEpoch++;current=null;focusId=null;$('source').textContent='恢复后请重新选择资料';$('preview-image').hidden=true;$('correction').value=''},'恢复操作已结束，请核对当前资料')
 $('delete').onclick=()=>perform(async()=>{if(!window.confirm('删除选中记录？仍被其他记录引用的资料将保留并报告错误。'))return;const result=await call('remove',{ids:[...selected]});$('batch-results').textContent=JSON.stringify(result.map(row=>({id:row.id,ok:row.ok,code:row.code})),null,2);selected.clear();focusEpoch++;current=null;focusId=null;$('source').textContent='请选择资料';$('record-detail').textContent='';$('preview-image').hidden=true;$('correction').value=''},'逐项删除结果已更新')
 $('archive-jobs').onclick=()=>perform(()=>{const ids=status.jobs.filter(row=>['succeeded','failed','cancelled'].includes(row.state)&&!row.needs_review&&!row.effect_pending).map(row=>row.id);if(!ids.length)throw{code:'JOBS_ARCHIVE_REVIEW_REQUIRED',next:'没有可归档的已结束任务，待核对任务会保留'};return call('archiveJobs',{ids})},'已归档结束任务，去重凭据仍保留；不会重跑业务')
 $('reconcile').onclick=()=>perform(()=>call('reconcile',{operationId:$('reconcile-id').value,revision:status.sync.revision,state:$('reconcile-state').value,remoteId:$('remote-id').value}),'核对结果已记录；不会自动重发')
 for(const id of ['query','type','sort'])$(id).addEventListener(id==='query'?'input':'change',()=>{if(id!=='sort')selected.clear();listing={page:1};query().catch(error=>say('查询失败，请重新载入'))})
 $('prev').onclick=()=>{listing.page--;query()};$('next').onclick=()=>{listing.page++;query()}
 refresh(true).then(()=>say('资料已载入，服务请求只在明确操作后发生')).catch(()=>say('无法载入，请检查产品数据目录'))
 setInterval(()=>{if(!busy)refresh().catch(()=>{})},700)
})()
