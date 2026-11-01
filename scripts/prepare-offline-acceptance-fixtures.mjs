/** Build an actual portable Electron fixture from the already installed runtime.
 * No downloads, model calls, historical project data or signing claims. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url), runtime = path.dirname(require('electron'));
const out = path.resolve(process.env.BLOMA_VALIDATION_OUTPUT ?? path.join(root, 'run-artifacts/offline-acceptance-fixtures')), packaged = path.join(out, 'calculator');
if (!out.startsWith(path.join(root, 'run-artifacts') + path.sep))
    throw Error('FIXTURE_OUTPUT_OUTSIDE_ARTIFACTS');
fs.mkdirSync(packaged, { recursive: true });
for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    const target = path.join(packaged, entry.name === 'electron.exe' ? 'Calculator.exe' : entry.name);
    if (entry.isDirectory())
        fs.cpSync(path.join(runtime, entry.name), target, { recursive: true });
    else
        fs.copyFileSync(path.join(runtime, entry.name), target);
}
const app = path.join(packaged, 'resources', 'app');
fs.mkdirSync(path.join(app, 'renderer'), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'offline-calculator-fixture', version: '1.0.0', main: 'main.cjs' }));
fs.writeFileSync(path.join(app, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:600,height:450}).loadFile(require('node:path').join(__dirname,'renderer/index.html')));app.on('window-all-closed',()=>app.quit());`);
fs.writeFileSync(path.join(app, 'renderer/index.html'), `<!doctype html><html><meta charset="utf-8"><title>计算器</title><main style="font:24px system-ui;padding:40px"><h1>计算器</h1><output id="result">0</output><p><button id="key-2">2</button><button id="key-plus">+</button><button id="key-3">3</button><button id="key-equals">=</button></p></main><script>let left='',right='',operator='';const show=()=>document.querySelector('#result').textContent=left+operator+right||'0';for(const n of [2,3])document.querySelector('#key-'+n).onclick=()=>{if(operator)right+=n;else left+=n;show()};document.querySelector('#key-plus').onclick=()=>{operator='+';show()};document.querySelector('#key-equals').onclick=()=>{left=String(Number(left)+Number(right));right='';operator='';show()};</script></html>`);
const manifest = { packaged, documents_dependencies: path.join(root, 'node_modules'), runtime_source: runtime, scope: 'actual local Electron binary and product resources; no installer or clean-machine qualification' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
