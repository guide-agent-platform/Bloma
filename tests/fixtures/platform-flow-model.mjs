import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
/** Deterministic local responses, never a provider or evidence of model quality. */
export async function startPlatformFlowModel(electron) {
    let sequence = 0, requests = 0, scenario = 'gui', hold = false, cancelled = 0;
    const observations = [], held = new Set(), text = value => ({ type: 'text', text: value }), use = (name, input) => ({ type: 'tool_use', id: 'local_' + (++sequence), name, input });
    const expected = '保存输入后重开仍能看到记录';
    const files = {
        'package.json': JSON.stringify({ name: 'local-notes-fixture', version: '1.0.0', main: 'main.cjs' }),
        'main.cjs': `const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path');const data=process.env.APP_DATA_DIR;fs.mkdirSync(data,{recursive:true});const file=path.join(data,'notes.json');const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];ipcMain.handle('notes:read',()=>read());ipcMain.handle('notes:save',(_,note)=>{if(typeof note!=='string'||!note.trim())return read();const rows=[...read(),note.trim()];fs.writeFileSync(file+'.tmp',JSON.stringify(rows));fs.renameSync(file+'.tmp',file);return rows});app.whenReady().then(()=>new BrowserWindow({width:800,height:650,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}}).loadFile('index.html'));app.on('window-all-closed',()=>app.quit());`,
        'preload.cjs': `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('notes',{read:()=>ipcRenderer.invoke('notes:read'),save:text=>ipcRenderer.invoke('notes:save',text)});`,
        'index.html': `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机记事本</title><link rel="stylesheet" href="theme.css"><main><h1>本机记事本</h1><label for="note">记录</label><input id="note"><button id="save">保存</button><ul id="items"></ul><p id="status" role="status"></p></main><script>const render=rows=>{document.querySelector('#items').replaceChildren(...rows.map(text=>{const li=document.createElement('li');li.textContent=text;return li}))};window.notes.read().then(render);document.querySelector('#save').onclick=async()=>{render(await window.notes.save(document.querySelector('#note').value));document.querySelector('#status').textContent='已保存'};</script></html>`,
        'theme.css': 'body{font:18px system-ui;background:#f8f7fb;color:#273044}main{max-width:600px;margin:48px auto;padding:24px;background:white;border-radius:16px}input,button{font:inherit;margin:12px;padding:10px}button{background:#3457b1;color:white;border:0;border-radius:8px}',
        'LAUNCH.json': JSON.stringify({ schema_version: 2, command: [electron, 'main.cjs'], ui: 'electron', window_title: '本机记事本' }),
    };
    // Fixture-only CDP permits observing the normal trial entry and its real data.
    files['main.cjs'] = files['main.cjs'].replace("const data=", "if(!app.commandLine.hasSwitch('remote-debugging-port')){app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');app.commandLine.appendSwitch('remote-debugging-port','0')}const data=");
    const calls = b => (b.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_use');
    function reply(b) {
        const tools = (b.tools ?? []).map(t => t.name), history = JSON.stringify(b.messages), system = JSON.stringify(b.system), done = calls(b);
        if (system.includes('独立视觉/交互审阅V')) {
            const images = (b.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'image' && c.source?.data);
            if (!images.length)
                return [use('read_quality_review', {}), use('view_quality_image', {})];
            if (!done.some(c => c.name === 'submit_quality_findings'))
                return [use('submit_quality_findings', { findings: [], visual_observations: [{ image_sha256: createHash('sha256').update(Buffer.from(images.at(-1).source.data, 'base64')).digest('hex'), region: '主界面输入及保存区域', observed: '受控界面包含标题、输入框、保存按钮和记录列表；实际操作另由宿主检查。' }] })];
            return [text('受控视觉材料记录已提交。')];
        }
        if (system.includes('独立只读代码/数据审阅C'))
            return done.some(c => c.name === 'submit_quality_findings') ? [text('受控代码审阅协议已提交。')] : [use('read_quality_review', {}), use('read_file', { path: scenario === 'gui' ? 'main.cjs' : 'app.cjs' }), use('submit_quality_findings', { findings: [] })];
        if (tools.includes('write_file')) {
            if (hold)
                return null;
            if (!done.some(c => c.name === 'read_skill'))
                return [use('read_skill', { name: 'software-verification' })];
            if (scenario === 'gui' && history.includes('把保存按钮改为紫色') && !done.some(c => c.name === 'write_file' && c.input?.path === 'theme.css' && c.input.content.includes('#6b21a8')))
                return [use('read_file', { path: 'theme.css' }), use('write_file', { path: 'theme.css', content: files['theme.css'] + 'button{background:#6b21a8}' })];
            if (!done.some(c => c.name === 'write_file')) {
                if (scenario === 'gui')
                    return [...Object.entries(files).map(([path, content]) => use('write_file', { path, content })), use('register_gui_check', { expectations: { 'F-001': expected }, steps: [{ id: 'type', kind: 'fill', selector: '#note', value: 'host record' }, { id: 'save', kind: 'click', selector: '#save' }, { id: 'saved', kind: 'expect', selector: '#items', equals: 'host record' }, { id: 'restart', kind: 'restart' }, { id: 'persisted', kind: 'expect', selector: '#items', equals: 'host record' }], acceptance_refs: { saved: ['F-001'], persisted: ['F-001'] } })];
                return [use('write_file', { path: 'app.cjs', content: 'console.log(42)' }), use('write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }) }), use('register_cli_check', { expectations: { 'F-001': '显示42' }, cases: [{ name: 'output42', covers: ['F-001'], args: [], stdout: '42', exit_code: 0 }] })];
            }
            return [text('本机受控实现已保存，请运行宿主检查。')];
        }
        if (system.includes('短任务单') && scenario === 'clarify')
            return [text(JSON.stringify({ action: 'clarify', question: '主要通过什么方式使用？', options: ['命令行输出42', '需要图形界面'] }))];
        if (system.includes('短任务单'))
            return [text(JSON.stringify({ action: 'brief', name: scenario === 'gui' ? '本机记事本' : scenario === 'longterm' ? '长期输出工具' : scenario === 'clarified' ? '澄清后的任务' : '本机命令工具', goal: scenario === 'gui' ? '保存与重开记录' : '输出42', ui: scenario === 'gui' ? 'required' : 'none', delivery: scenario === 'gui' ? 'desktop' : 'command', requirements: [{ description: scenario === 'gui' ? '保存与重开记录' : '输出42', expected: scenario === 'gui' ? expected : '显示42' }], constraints: [], out_of_scope: [], suggestions: [] }))];
        if (/HTML|html|草图/.test(system))
            return [text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main><h1>本机记事本</h1><label>记录<input></label><button>保存</button><ul><li>示例记录</li></ul></main></body></html>')];
        throw Error('UNSCRIPTED_MODEL_REQUEST: ' + system.slice(0, 150));
    }
    const server = createServer(async (req, res) => {
        try {
            let raw = '';
            for await (const part of req)
                raw += part;
            const b = JSON.parse(raw);
            if (++requests > 100)
                throw Error('LOCAL_REQUEST_LIMIT');
            const blocks = reply(b), entry = { n: requests, scenario, model: b.model, tools: (b.tools ?? []).map(t => t.name), response_tools: blocks?.filter(c => c.type === 'tool_use').map(c => c.name), has_image: JSON.stringify(b.messages).includes('"type":"image"'), held: blocks === null };
            observations.push(entry);
            if (blocks === null) {
                held.add(res);
                res.on('close', () => { held.delete(res); cancelled++; });
                return;
            }
            const stop = blocks.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn', incoming = blocks.some(c => c.name === 'read_skill') ? 300000 : 120;
            const message = { id: 'local_msg_' + (++sequence), type: 'message', role: 'assistant', model: b.model, content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: incoming, output_tokens: 20 } };
            if (!b.stream) {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(message));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
            send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: incoming, output_tokens: 0 } } });
            blocks.forEach((c, index) => { send('content_block_start', { index, content_block: c.type === 'text' ? { type: 'text', text: '' } : { ...c, input: {} } }); send('content_block_delta', { index, delta: c.type === 'text' ? { type: 'text_delta', text: c.text } : { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }); send('content_block_stop', { index }); });
            send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
            send('message_stop', {});
            res.end();
        }
        catch (error) {
            observations.push({ error: String(error) });
            res.writeHead(500);
            res.end(JSON.stringify({ error: { message: String(error) } }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: 'http://127.0.0.1:' + server.address().port, observations, files, setScenario(value) { scenario = value; }, setHold(value) { hold = value; }, heldCount: () => held.size, cancelled: () => cancelled, async close() { for (const res of held)
            res.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
