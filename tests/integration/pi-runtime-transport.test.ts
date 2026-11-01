import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runAgentLoop } from '../../main/agent/loop/agent-loop'
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import { createProductionBudget } from '../../main/desktop/production-budget'
import { createProject } from '../../main/project/project-service'
import { savePastedImage } from '../../main/platform/shell/pasted-images'
import { buildSoftwareImageTool } from '../../main/software/image-tool'
import { piSessionPath } from '../../main/agent/loop/pi-session-store'

let home: string, originalHome: string | undefined
beforeEach(() => { originalHome = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-pi-http-')); process.env.PROMA_HOME = home })
afterEach(() => {
  if (originalHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})
it.each(['anthropic-compatible','zhipu'])('actual image bytes traverse attachments, view_image, Pi resume and %s HTTP without base64 in durable history',async providerType=>{
  const project=createProject({request_id:'vision',mode:'quick'},{workflowVersion:'software-v1'}),{createCanvas}=await import('@napi-rs/canvas'),canvas=createCanvas(2,2),drawing=canvas.getContext('2d')
  drawing.fillStyle='red';drawing.fillRect(0,0,2,2);const red=canvas.toBuffer('image/png'),initial=savePastedImage('vision-wire',red.toString('base64'),'png')
  drawing.fillStyle='blue';drawing.fillRect(0,0,2,2);const blue=canvas.toBuffer('image/png');writeFileSync(join(project.root_path,'blue.png'),blue)
  const bodies:any[]=[],frame=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(Buffer.from(chunk));bodies.push(JSON.parse(Buffer.concat(parts).toString('utf8')))
    const first=bodies.length===1;res.writeHead(200,{'content-type':'text/event-stream'})
    if(providerType==='zhipu'){
      res.write(frame({choices:[{delta:first?{tool_calls:[{index:0,id:'see',type:'function',function:{name:'view_image',arguments:'{"path":"blue.png"}'}}]}:{content:'local controlled response'},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:5}}));res.end('data: [DONE]\n\n')
    }else{
      res.write(frame({type:'message_start',message:{id:'m',role:'assistant',usage:{input_tokens:30}}}))
      res.write(frame({type:'content_block_start',index:0,content_block:first?{type:'tool_use',id:'see',name:'view_image',input:{}}:{type:'text',text:''}}))
      res.write(frame({type:'content_block_delta',index:0,delta:first?{type:'input_json_delta',partial_json:'{"path":"blue.png"}'}:{type:'text_delta',text:'local controlled response'}}))
      res.write(frame({type:'content_block_stop',index:0}));res.write(frame({type:'message_delta',delta:{stop_reason:first?'tool_use':'end_turn'},usage:{output_tokens:5}}));res.end(frame({type:'message_stop'}))
    }
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port')
  try{
    const budget=createProductionBudget(project.project_id,'vision-scope','desktop-implement'),tool=buildSoftwareImageTool(project.project_id);let executions=0
    const original=tool.execute;tool.execute=async(...args)=>{executions++;return original(...args)}
    const common={runtimeScope:'desktop-implement' as const,system:'Use the actual supplied image tool',projectId:project.project_id,sessionId:'vision-wire',requestId:'vision-run',query:budget.wrap(anthropicMessagesQueryViaProviders),env:{PATH:process.env.PATH??process.env.Path??'',ANTHROPIC_AUTH_TOKEN:'local-vision-key',ANTHROPIC_MODEL:'local-vision-model',ANTHROPIC_BASE_URL:`http://127.0.0.1:${address.port}`,ANTHROPIC_PROVIDER_TYPE:providerType},providerType,maxTokens:1000,maxTurns:4,permissionMode:'allow-all' as const,signal:AbortSignal.timeout(30000),publish:()=>{},tools:[tool]}
    expect((await runAgentLoop({...common,task:'compare the actual images',images:[initial]})).status).toBe('completed')
    expect((await runAgentLoop({...common,task:'continue from the prior image references'})).status).toBe('completed')
    expect(executions).toBe(1);expect(bodies).toHaveLength(3)
    const urls=(body:any)=>body.messages.flatMap((turn:any)=>Array.isArray(turn.content)?turn.content.filter((block:any)=>block.type==='image'||block.type==='image_url').map((block:any)=>block.type==='image'?block.source.data:block.image_url.url.split(',')[1]):[])
    expect(urls(bodies[0])).toEqual([red.toString('base64')]);expect(urls(bodies[1])).toContain(blue.toString('base64'));expect(urls(bodies[2])).toContain(blue.toString('base64'))
    const history=readFileSync(piSessionPath(project.project_id,'vision-wire','desktop-implement:',project.root_path),'utf8')
    expect(history).toContain(Buffer.from('bloma-image-ref:'+initial.imageId).toString('base64'));expect(history).not.toContain(blue.toString('base64'));expect(history).not.toContain('local-vision-key')
    expect(budget.snapshot().requests).toBe(3)
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
},45000)
it.each(['anthropic-compatible', 'zhipu'])('real Pi → guarded local HTTP/SSE → %s tools → durable file → ledger', async providerType => {
  const bodies: Array<Record<string, unknown>> = []
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(Buffer.from(chunk))
    bodies.push(JSON.parse(Buffer.concat(parts).toString('utf8')))
    const useTool = bodies.length === 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (providerType === 'zhipu') {
      res.write(frame({ choices: [{ delta: useTool ? { tool_calls: [{ index: 0, id: 'wire-write', type: 'function',
        function: { name: 'write_file', arguments: '{"content":"durable output"}' } }] } : { content: '已保存' }, finish_reason: useTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } }))
      res.end('data: [DONE]\n\n')
    } else {
      res.write(frame({ type: 'message_start', message: { id: 'm', role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 20 } } }))
      res.write(frame({ type: 'content_block_start', index: 0, content_block: useTool
        ? { type: 'tool_use', id: 'wire-write', name: 'write_file', input: {} } : { type: 'text', text: '' } }))
      res.write(frame({ type: 'content_block_delta', index: 0, delta: useTool
        ? { type: 'input_json_delta', partial_json: '{"content":"durable output"}' } : { type: 'text_delta', text: '已保存' } }))
      res.write(frame({ type: 'content_block_stop', index: 0 }))
      res.write(frame({ type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }))
      res.end(frame({ type: 'message_stop' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER_ADDRESS')
  try {
    const budget = createProductionBudget('wire-project', 'scope', 'desktop-implement')
    const result = await runAgentLoop({ runtimeScope: 'desktop-implement', system: 'write using the supplied tool', task: 'save',
      projectId: 'wire-project', sessionId: 'wire-session', requestId: 'wire-run', query: budget.wrap(anthropicMessagesQueryViaProviders),
      env: { PATH: process.env.PATH ?? process.env.Path ?? '', ANTHROPIC_AUTH_TOKEN: 'local-test-credential', ANTHROPIC_MODEL: 'local-test-model',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_PROVIDER_TYPE: providerType }, providerType,
      maxTokens: 1000, maxTurns: 4, permissionMode: 'allow-all', signal: new AbortController().signal, publish: () => {},
      tools: [{ name: 'write_file', description: 'save', input_schema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
        execute: async args => { writeFileSync(join(home, 'output.txt'), String(args.content)); return { output: 'saved evidence', detail: { path: 'output.txt' } } } }] })
    expect(result.status).toBe('completed'); expect(readFileSync(join(home, 'output.txt'), 'utf8')).toBe('durable output')
    expect(bodies).toHaveLength(2); expect(JSON.stringify(bodies[1])).toContain('saved evidence')
    expect(budget.snapshot().requests).toBe(2)
    const ledger = readFileSync(join(home, 'usage-ledger', 'wire-project.jsonl'), 'utf8')
    expect(ledger.split('\n').filter(line => line.includes('"event":"query_finished"'))).toHaveLength(2)
    expect(ledger).not.toContain('local-test-credential')
    expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 10, turnsWithUsage: 2 })
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
