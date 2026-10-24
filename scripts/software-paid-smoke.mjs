import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')
const runtime = join(root, 'dist-main/main/software-paid-smoke-runtime.mjs')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await build({ stdin: { contents: "export {main} from './scripts/software-paid-smoke'", resolveDir: root }, outfile: runtime, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [import.meta.filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
  child.once('error', error => { console.error(error.message); process.exitCode = 1 }); child.once('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app } = await import('electron')
  // Electron emits ready after the entry module finishes evaluating. Awaiting
  // main()->app.whenReady() here would deadlock that lifecycle.
  import(pathToFileURL(runtime).href).then(api => api.main()).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}
