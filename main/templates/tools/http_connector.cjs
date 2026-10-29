// Product-owned JSON API client. Credentials come from product settings only.
const http=require('node:http'),https=require('node:https'),dns=require('node:dns').promises
const {isIP,BlockList}=require('node:net'),{createHmac,timingSafeEqual}=require('node:crypto')
const blocked=new BlockList()
for(const [ip,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(ip,bits,'ipv4')
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6')
const blockedV6=new BlockList();blockedV6.addSubnet('2001::',23,'ipv6');blockedV6.addSubnet('2001:db8::',32,'ipv6');blockedV6.addSubnet('2002::',16,'ipv6')
function isAllowedAddress(address,network) {
  if(network==='loopback')return address==='::1'||/^127\./.test(address)&&isIP(address)===4
  const family=isIP(address)
  return family===4?!blocked.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!blockedV6.check(address,'ipv6')
}
function createHttpConnector(config) {
  let base
  try{base=new URL(config?.baseUrl)}catch{throw Error('HTTP_BASE_URL_INVALID')}
  const network=config.network??'public',methods=config.methods??['GET']
  const host=base.hostname.replace(/^\[|\]$/g,''),loopbackName=host==='localhost'||isAllowedAddress(host,'loopback')
  if(!['public','loopback'].includes(network)||base.username||base.password||base.search||base.hash||!['https:','http:'].includes(base.protocol)
    ||network==='public'&&(base.protocol!=='https:'||isIP(host)&&!isAllowedAddress(host,network)||!isIP(host)&&(!host.includes('.')||/\.(local|internal|localhost)$/.test(host)))
    ||network==='loopback'&&!loopbackName)throw Error('HTTP_BASE_URL_INVALID')
  if(!Array.isArray(methods)||!methods.length||methods.some(x=>!['GET','POST','PUT','PATCH','DELETE'].includes(x)))throw Error('HTTP_METHODS_INVALID')
  const auth=config.auth
  if(auth&&(!auth.header||!/^[A-Za-z0-9-]+$/.test(auth.header)||['host','content-length','connection','transfer-encoding'].includes(auth.header.toLowerCase())||typeof auth.value!=='string'||!auth.value||/[\r\n]/.test(auth.value)))throw Error('HTTP_AUTH_INVALID')
  // Snapshot caller configuration; mutating settings cannot broaden this client.
  const allowed=new Set(methods),authorization=auth?{[auth.header]:auth.value}:{}
  return { async request(relative,options={}) {
    const method=options.method??'GET',timeout=options.timeoutMs??15000
    if(typeof relative!=='string'||relative.length>4096||!Number.isInteger(timeout)||timeout<50||timeout>60000||!allowed.has(method))throw Error('HTTP_REQUEST_INVALID')
    let url
    try{url=new URL(relative,base)}catch{throw Error('HTTP_REQUEST_INVALID')}
    if(url.origin!==base.origin||url.username||url.password||url.hash)throw Error('HTTP_ORIGIN_MISMATCH')
    if(options.body!==undefined&&method==='GET')throw Error('HTTP_GET_BODY_UNSUPPORTED')
    let body
    try{body=options.body===undefined?undefined:JSON.stringify(options.body)}catch{throw Error('HTTP_BODY_INVALID')}
    if(options.body!==undefined&&body===undefined)throw Error('HTTP_BODY_INVALID')
    if(body!==undefined&&Buffer.byteLength(body)>1024*1024)throw Error('HTTP_BODY_LIMIT')
    if(options.signal?.aborted)return {ok:false,kind:'cancelled'}
    return new Promise(resolve=>{
      let settled=false,request,timer
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve(value)}
      const stop=kind=>{finish({ok:false,kind});request?.destroy()}
      const abort=()=>stop('cancelled')
      timer=setTimeout(()=>stop('timeout'),timeout);options.signal?.addEventListener('abort',abort,{once:true})
      const start=async()=>{
        try {
          const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await dns.lookup(host,{all:true,verbatim:true})
          if(settled)return
          if(!addresses.length||addresses.some(item=>!isAllowedAddress(item.address,network)))return finish({ok:false,kind:'network_blocked'})
          const chosen=addresses[0]
          request=(url.protocol==='https:'?https:http).request(url,{method,agent:false,lookup:(_hostname,settings,callback)=>{
            // Pin the validated DNS answer to this connection; no second lookup.
            if(settings.all)callback(null,[chosen]);else callback(null,chosen.address,chosen.family)
          },headers:{Accept:'application/json','Accept-Encoding':'identity',...authorization,...(body!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},response=>{
            const status=response.statusCode??0
            if(status<200||status>=300){
              response.destroy()
              const retry=Number(response.headers['retry-after'])
              return finish({ok:false,status,kind:status===401||status===403?'auth_error':status===429?'rate_limited':status>=300&&status<400?'redirect_refused':'http_error',...(status===429&&Number.isInteger(retry)&&retry>=0?{retryAfterSeconds:Math.min(retry,3600)}:{})})
            }
            const chunks=[];let bytes=0
            response.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){stop('response_limit');response.destroy()}else chunks.push(chunk)})
            response.on('aborted',()=>finish({ok:false,kind:'incomplete_response'}))
            response.on('error',()=>finish({ok:false,kind:'network_error'}))
            response.on('end',()=>{
              if(settled)return
              if(status===204)return finish({ok:true,status,data:null})
              if(!/^application\/(?:[\w.-]+\+)?json\b/i.test(String(response.headers['content-type']??'')))return finish({ok:false,status,kind:'invalid_response'})
              try{finish({ok:true,status,data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))})}catch{finish({ok:false,status,kind:'invalid_response'})}
            })
          })
          request.on('error',()=>finish({ok:false,kind:'network_error'}))
          if(settled){request.destroy();return}
          request.end(body)
        }catch{finish({ok:false,kind:'network_error'})}
      }
      start()
    })
  } }
}
/** Generic opt-in convention: hex HMAC-SHA256(timestamp + '.' + raw body).
 * Vendor-specific formats require explicit adapters. This does not apply effects. */
function verifyWebhook({secret,rawBody,timestamp,signature}) {
  const nowSeconds=Math.floor(Date.now()/1000)
  if(typeof secret!=='string'||Buffer.byteLength(secret)<16||!Buffer.isBuffer(rawBody)||rawBody.length>1024*1024
    ||typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||!Number.isFinite(nowSeconds)||Math.abs(nowSeconds-Number(timestamp))>300
    ||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))return {valid:false,kind:'invalid_webhook'}
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest(),actual=Buffer.from(signature.slice(7),'hex')
  if(!timingSafeEqual(expected,actual))return {valid:false,kind:'invalid_signature'}
  return {valid:true,eventDigest:createHmac('sha256',secret).update(rawBody).digest('hex'),scope:'signature_only_persist_idempotency_before_effects'}
}
module.exports={createHttpConnector,verifyWebhook,isAllowedAddress}
