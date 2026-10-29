import {createRequire} from 'node:module'
import {createServer,type Server} from 'node:http'
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHmac} from 'node:crypto'
import dns from 'node:dns/promises'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const require=createRequire(import.meta.url)
const {createHttpConnector,verifyWebhook,isAllowedAddress}=require('../../../main/templates/tools/http_connector.cjs')
const {createWebhookInbox}=require('../../../main/templates/tools/webhook_inbox.cjs')
let server:Server,url:string,home:string,hits:Array<{path:string;auth?:string;body:string}>
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'bloma-http-'));hits=[]
 server=createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk)
  hits.push({path:request.url!,auth:request.headers.authorization,body:Buffer.concat(chunks).toString('utf8')})
  response.setHeader('Content-Type','application/json')
  if(request.url==='/auth'){response.writeHead(401);response.end('{"error":"PRIVATE_TOKEN"}');return}
  if(request.url==='/limit'){response.writeHead(429,{'Retry-After':'7'});response.end('{}');return}
  if(request.url==='/redirect'){response.writeHead(302,{Location:'/target'});response.end('{}');return}
  if(request.url==='/slow'){setTimeout(()=>response.end('{}'),300);return}
  if(request.url==='/bad'){response.end('invalid');return}
  if(request.url==='/large'){response.end('x'.repeat(2*1024*1024+1));return}
  if(request.url==='/empty'){response.writeHead(204);response.end();return}
  response.end(JSON.stringify({name:'外部记录',method:request.method}))
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port');url=`http://127.0.0.1:${address.port}/`
})
afterEach(async()=>{vi.restoreAllMocks();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(home,{recursive:true,force:true})})
const client=(extra={})=>createHttpConnector({baseUrl:url,network:'loopback',...extra})
it('makes real authenticated JSON GET/POST requests with snapshotted configuration and never replays writes',async()=>{
 const auth={header:'Authorization',value:'Bearer PRIVATE_TOKEN'},methods=['GET','POST'],api=client({auth,methods})
 auth.value='changed';methods.push('DELETE')
 expect(await api.request('items')).toMatchObject({ok:true,data:{name:'外部记录',method:'GET'}})
 expect(await api.request('/items',{method:'POST',body:{name:'中文提交'}})).toMatchObject({ok:true,data:{method:'POST'}})
 expect(hits).toHaveLength(2);expect(hits[0].auth).toBe('Bearer PRIVATE_TOKEN');expect(JSON.parse(hits[1].body)).toEqual({name:'中文提交'})
 await expect(api.request('/items',{method:'DELETE'})).rejects.toThrow('REQUEST_INVALID')
 await expect(api.request('https://another.example/items')).rejects.toThrow('ORIGIN_MISMATCH')
 await expect(client().request('/items',{method:'POST'})).rejects.toThrow('REQUEST_INVALID');expect(hits).toHaveLength(2)
})
it('returns bounded error categories without error bodies, refuses redirects and exposes rate-limit delay without retrying',async()=>{
 const api=client({auth:{header:'Authorization',value:'Bearer PRIVATE_TOKEN'}})
 const auth=await api.request('auth');expect(auth).toEqual({ok:false,status:401,kind:'auth_error'});expect(JSON.stringify(auth)).not.toContain('PRIVATE_TOKEN')
 expect(await api.request('limit')).toEqual({ok:false,status:429,kind:'rate_limited',retryAfterSeconds:7})
 expect(await api.request('redirect')).toMatchObject({ok:false,kind:'redirect_refused'})
 expect(hits.map(hit=>hit.path)).toEqual(['/auth','/limit','/redirect'])
 expect(await api.request('bad')).toMatchObject({ok:false,kind:'invalid_response'})
 expect(await api.request('large')).toMatchObject({ok:false,kind:'response_limit'})
 expect(await api.request('empty')).toMatchObject({ok:true,status:204,data:null})
})
it('enforces a total deadline and propagates cancellation without restarting a request',async()=>{
 const api=client();expect(await api.request('slow',{timeoutMs:50})).toMatchObject({ok:false,kind:'timeout'})
 const controller=new AbortController(),observed=new Promise<void>(done=>server.once('request',()=>done())),pending=api.request('slow',{signal:controller.signal})
 await observed;controller.abort();expect(await pending).toMatchObject({ok:false,kind:'cancelled'});expect(hits).toHaveLength(2)
})
it('rejects private/reserved targets by default and validates DNS answers before the pinned connection',async()=>{
 expect(()=>createHttpConnector({baseUrl:url})).toThrow('BASE_URL_INVALID')
 for(const address of ['10.0.0.1','169.254.169.254','100.64.0.1','192.88.99.1','::1','::ffff:127.0.0.1','2001:db8::1'])expect(isAllowedAddress(address,'public')).toBe(false)
 expect(isAllowedAddress('8.8.8.8','public')).toBe(true)
 vi.spyOn(dns,'lookup').mockResolvedValue([{address:'127.0.0.1',family:4}] as never)
 expect(await client({baseUrl:url.replace('127.0.0.1','localhost')}).request('dns-pinned')).toMatchObject({ok:true})
 expect(dns.lookup).toHaveBeenCalledTimes(1)
 expect(await createHttpConnector({baseUrl:'https://api.example.test/'}).request('records')).toMatchObject({ok:false,kind:'network_blocked'})
 expect(hits.map(hit=>hit.path)).toEqual(['/dns-pinned'])
})
const secret='local-test-secret-at-least-16',rawBody=Buffer.from('{"id":"event-1","name":"中文"}'),timestamp=String(Math.floor(Date.now()/1000))
const signed=(bytes=rawBody,time=timestamp)=>({secret,rawBody:bytes,timestamp:time,signature:'sha256='+createHmac('sha256',secret).update(time+'.').update(bytes).digest('hex')})
it('authenticates exact webhook bytes and rejects forged, stale and future signatures',()=>{
 expect(verifyWebhook(signed()).valid).toBe(true)
 expect(verifyWebhook({...signed(),rawBody:Buffer.from('{}')})).toMatchObject({valid:false,kind:'invalid_signature'})
 expect(verifyWebhook(signed(rawBody,String(Number(timestamp)-301))).valid).toBe(false)
 expect(verifyWebhook(signed(rawBody,String(Number(timestamp)+301))).valid).toBe(false)
 expect(verifyWebhook({...signed(rawBody,String(Number(timestamp)-301)),nowSeconds:Number(timestamp)-301}).valid).toBe(false)
 expect(verifyWebhook({...signed(),signature:'sha256=aa'}).valid).toBe(false)
})
it('persists pending/done deduplication across reopen, rejects conflicting IDs and never replays pending effects',()=>{
 const inbox=createWebhookInbox(home),input={...signed(),eventId:'event-1'},accepted=inbox.accept(input)
 expect(accepted).toMatchObject({accepted:true,state:'pending'})
 expect(createWebhookInbox(home).accept(input)).toEqual({accepted:false,kind:'duplicate_pending'})
 expect(()=>inbox.markDone({...accepted.receipt,token:'wrong'})).toThrow('OWNER_INVALID')
 inbox.markDone(accepted.receipt)
 expect(createWebhookInbox(home).accept(input)).toEqual({accepted:false,kind:'duplicate_done'})
 expect(inbox.accept({...signed(Buffer.from('{"different":true}')),eventId:'event-1'})).toEqual({accepted:false,kind:'event_id_conflict'})
 const file=readdirSync(join(home,'.webhook-inbox')).find(name=>name.endsWith('.json'))!
 writeFileSync(join(home,'.webhook-inbox',file),'broken')
 expect(()=>inbox.accept(input)).toThrow()
})
