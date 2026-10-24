import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { createProject, updateProject } from '../../main/project/project-service'
import { parseLeanBrief } from '../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../main/project/prd-store'
import { syncDocuments } from '../../main/project/document-sync'
import { prdScopeFingerprint } from '../../main/project/requirement-contract'
import { createToolState } from '../../main/agent/loop/agent-loop'
import { buildLeanGuiTool } from '../../main/desktop/lean-gui-tool'
import { runGuiAcceptance } from '../../main/desktop/gui-acceptance'

// Optional real-parser acceptance. Point to an existing dependency directory;
// never silently download packages or pretend a byte echo is PDF/Word parsing.
const deps = process.env.SOFTWARE_DOC_IMPORT_TEST_DEPS
const ready = !!deps && existsSync(join(deps, 'pdfjs-dist/legacy/build/pdf.js')) && existsSync(join(deps, 'mammoth/package.json'))
it.skipIf(!ready)('actual browser upload parses frozen PDF and DOCX, exports the text and handles a genuinely invalid PDF', async () => {
  const previous = process.env.PROMA_HOME, home = mkdtempSync(join(tmpdir(), 'bloma-real-doc-')); process.env.PROMA_HOME = home
  try {
    const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), root = project.root_path
    const requirements = [{ description: '导入PDF和Word显示实际文本', expected: '读取固定PDF和Word中的文本' },
      { description: '导出当前文本', expected: '导出文件包含当前文档文本' }, { description: '错误文档反馈', expected: '损坏PDF显示无法读取提示' }]
    const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '浏览器文档阅读器', ui: 'required', delivery: 'browser', requirements }),
      { projectId: project.project_id, sessionId: 's', source: '浏览器文档工具', previous: readPrdBackplane(project.project_id), software: true })!
    if (parsed.action !== 'brief') throw Error('scope')
    parsed.brief.lean_brief!.preview = 'skip'
    syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief)
    const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief)
    updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
    mkdirSync(join(root, 'fixtures')); for (const file of ['sample.pdf', 'sample.docx', 'broken.pdf']) copyFileSync(resolve('tests/fixtures/software-import', file), join(root, 'fixtures', file))
    const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const address = probe.address()
    if (!address || typeof address === 'string') throw Error('port'); await new Promise<void>(done => probe.close(() => done()))
    writeFileSync(join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Documents</title><input id="file" type="file"><button id="export">Export text</button><p id="status"></p><pre id="text"></pre><script>
document.querySelector('#file').onchange=async e=>{const file=e.target.files[0];document.querySelector('#status').textContent='读取中';try{const response=await fetch('/import?name='+encodeURIComponent(file.name),{method:'POST',body:await file.arrayBuffer()});const result=await response.json();if(!response.ok)throw Error(result.error);document.querySelector('#text').textContent=result.text;document.querySelector('#status').textContent='已读取'}catch(error){document.querySelector('#status').textContent='无法读取文档: '+error.message}};document.querySelector('#export').onclick=()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([document.querySelector('#text').textContent]));link.download='text.txt';link.click()};</script>`)
    writeFileSync(join(root, 'server.cjs'), `const fs=require('fs'),pdf=require(${JSON.stringify(join(deps!, 'pdfjs-dist/legacy/build/pdf.js'))}),mammoth=require(${JSON.stringify(join(deps!, 'mammoth'))});require('http').createServer((request,response)=>{if(request.url.startsWith('/import')){const parts=[];request.on('data',chunk=>parts.push(chunk));request.on('end',async()=>{try{const bytes=Buffer.concat(parts),name=new URL(request.url,'http://127.0.0.1').searchParams.get('name');let text;if(name.endsWith('.pdf')){const document=await pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false}).promise;const page=await document.getPage(1);text=(await page.getTextContent()).items.map(item=>item.str).join(' ');await document.destroy()}else{text=(await mammoth.extractRawText({buffer:bytes})).value}response.setHeader('Content-Type','application/json');response.end(JSON.stringify({text}))}catch(error){response.writeHead(422,{'Content-Type':'application/json'});response.end(JSON.stringify({error:error.message}))}})}else{response.setHeader('Content-Type','text/html');response.end(fs.readFileSync('index.html'))}}).listen(${address.port},'127.0.0.1')`)
    writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', url: `http://127.0.0.1:${address.port}`, command: ['node', 'server.cjs'] }))
    const input = { fixtures: ['sample.pdf', 'sample.docx', 'broken.pdf'].map(file => ({ path: `input/${file}`, source: `fixtures/${file}` })),
      steps: [{ id: 'pdf', kind: 'upload', selector: '#file', path: 'input/sample.pdf' }, { id: 'pdf-text', kind: 'expect', selector: '#text', contains: 'Frozen PDF contract text' },
        { id: 'word', kind: 'upload', selector: '#file', path: 'input/sample.docx' }, { id: 'word-text', kind: 'expect', selector: '#text', contains: 'Frozen Word contract text' },
        { id: 'export', kind: 'download', selector: '#export', path: 'outputs/text.txt' }, { id: 'file-text', kind: 'expect_file', path: 'outputs/text.txt', contains: 'Frozen Word contract text' },
        { id: 'bad', kind: 'upload', selector: '#file', path: 'input/broken.pdf' }, { id: 'error', kind: 'expect', selector: '#status', contains: '无法读取文档' }],
      acceptance_refs: { 'pdf-text': ['F-001'], 'word-text': ['F-001'], 'file-text': ['F-002'], error: ['F-003'] } }
    const registered = await buildLeanGuiTool(project.project_id).execute(input, { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(90000), state: createToolState() })
    expect(registered.isError, registered.output).not.toBe(true)
    const actual = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, designHash: scope, signal: AbortSignal.timeout(90000) })
    expect(actual?.status, JSON.stringify(actual)).toBe('passed')
    writeFileSync(resolve('run-artifacts/software-document-import-acceptance.json'), JSON.stringify({ actual, paid_requests: 0, scope: 'real file input/actual parsing/export/invalid document; text extraction only, not page rendering or clean-machine qualification',
      parser_versions: { pdfjs: JSON.parse(readFileSync(join(deps!, 'pdfjs-dist/package.json'), 'utf8')).version, mammoth: JSON.parse(readFileSync(join(deps!, 'mammoth/package.json'), 'utf8')).version } }, null, 2))
  } finally { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }
}, 120000)
