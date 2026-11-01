import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, ElectronApplication, BrowserContext } from 'playwright'
import { electronEntry } from './gui-observer'
import { softwareEnvironment } from './command-runtime'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import type { ChildProcess } from 'node:child_process'
import { copyDataForPreview, softwareDataDirectory } from './data-update'
import { startSoftwareProcess, stopSoftwareProcess } from './process-manager'
import { isolatedBrowserLaunch } from './isolated-launch'

const pages = new Map<string, Page>()
/** Host-only handle, never exposed to a product, renderer or model tool. */
export const activeSoftwareCorrectionPage = (projectId: string) => pages.get(projectId)

/** Run the normal Electron/browser program with copied data, then install a host
 * selection overlay. No product-owned Python bridge or template markers needed. */
export async function startSoftwareCorrection(projectId: string, root: string, launch: LaunchDeclaration, sessionDir: string, sourceData?:string): Promise<{ child?: ChildProcess; pid?:number; close: () => Promise<void>; dataSnapshotted: boolean }> {
  if (!['electron','browser'].includes(launch.ui??'')) throw Error('CORRECTION_RUNTIME_UNSUPPORTED: 当前点选支持Electron和浏览器界面')
  const data = join(sessionDir, 'data')
  mkdirSync(data, { recursive: true })
  const currentData = sourceData??softwareDataDirectory(projectId), dataSnapshotted = existsSync(currentData)
  if (dataSnapshotted) await copyDataForPreview(currentData, data)
  if (existsSync(join(currentData, '..', 'environment-home'))) await copyDataForPreview(join(currentData, '..', 'environment-home'), join(sessionDir, 'environment-home'))
  const { _electron, chromium } = await import('playwright')
  let app: ElectronApplication | undefined
  let browser:BrowserContext|undefined,serviceId:string|undefined,servicePid:number|undefined
  const owner=`correction-${sessionDir.split(/[\\/]/).at(-1)}`
  let child: ChildProcess | undefined
  const close = async () => {
    pages.delete(projectId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.all([app?.close(),browser?.close()]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CORRECTION_CLOSE_TIMEOUT')), 7000) })]) }
    finally { clearTimeout(timer); if (child && child.exitCode === null && !child.signalCode) child.kill();if(serviceId)await stopSoftwareProcess(projectId,serviceId,owner) }
  }
  try {
    let page:Page
    if(launch.ui==='electron'){
      const entry = electronEntry(root, launch.command)
      app = await _electron.launch({ ...entry, args: [...entry.args, `--user-data-dir=${join(sessionDir, 'profile')}`], cwd: root, env: softwareEnvironment(projectId, data,root), timeout: 20000 })
      child = app.process();page=await app.firstWindow({timeout:15000})
    }else{
      const isolated=await isolatedBrowserLaunch(launch)
      if(!isolated.url)throw Error('CORRECTION_URL_REQUIRED')
      const service=await startSoftwareProcess({projectId,root,sessionId:owner,command:isolated.command,url:isolated.url,dataDir:data,purpose:'correction',readyMs:10000})
      serviceId=service.id;servicePid=service.pid
      if(!service.ready)throw Error('CORRECTION_BROWSER_NOT_READY: 程序需使用PORT/APP_PORT或启动端口参数')
      browser=await chromium.launchPersistentContext(join(sessionDir,'profile'),{headless:false,...(existsSync(chromium.executablePath())?{executablePath:chromium.executablePath()}:{channel:process.platform==='win32'?'msedge':'chrome'}),env:softwareEnvironment(projectId,data,root),timeout:20000})
      page=browser.pages()[0]??await browser.newPage();await page.goto(isolated.url,{waitUntil:'domcontentloaded',timeout:15000})
    }
    pages.set(projectId,page)
    page.on('close',()=>{pages.delete(projectId);if(serviceId)void stopSoftwareProcess(projectId,serviceId,owner).catch(()=>{})})
    let count = 0
    await page.exposeFunction('__blomaUserPick', async (payload: unknown) => {
      if (!payload || typeof payload !== 'object') throw Error('CORRECTION_PICK_INVALID')
      const serialized = JSON.stringify(payload)
      if (serialized.length > 4096 || ++count > 64) throw Error('CORRECTION_PICK_LIMIT')
      appendFileSync(join(sessionDir, 'picks.jsonl'), `${serialized}\n`)
      return { ok: true }
    })
    await page.evaluate(() => {
      const host = window as unknown as { __blomaUserPick: (value: unknown) => Promise<unknown> }
      const toolbar = document.createElement('aside'), title = document.createElement('strong'), note = document.createElement('textarea'), kind = document.createElement('select'), send = document.createElement('button'), done = document.createElement('button'), hint = document.createElement('span')
      toolbar.id = 'bloma-correction-host'
      toolbar.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;left:12px;right:12px;display:flex;flex-wrap:wrap;box-sizing:border-box;align-items:center;gap:10px;padding:14px;background:#fff;color:#1e293b;border:2px solid #6366f1;border-radius:12px;box-shadow:0 8px 30px #0003;font:14px system-ui'
      title.textContent = '修改预览 · 使用数据副本'; title.style.whiteSpace = 'nowrap'; note.placeholder = '先点要改的地方，再写修改意见'; note.setAttribute('aria-label', '修改意见'); note.rows = 2; note.style.cssText = 'flex:1 1 180px;min-width:160px;max-height:80px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit'
      for (const [value, text] of [['visual', '外观'], ['function', '功能'], ['guess', '按常见做法']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option) }
      send.textContent = '记录这处修改'; done.textContent = '完成点选'; toolbar.append(title, note, kind, send, done, hint); document.body.append(toolbar)
      for (const control of [kind, send, done]) control.style.cssText = 'white-space:nowrap;flex-shrink:0;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#1e293b;font:inherit;cursor:pointer'
      send.style.background = '#6366f1'; send.style.color = '#fff'; hint.style.cssText = 'flex:1 1 180px;line-height:1.5'
      let selected: HTMLElement | undefined, seq = 0
      const selector = (element: HTMLElement) => {
        if (element.id) return `#${CSS.escape(element.id)}`
        const parts: string[] = []; let node: HTMLElement | null = element
        for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
          const index = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node!.tagName).indexOf(node) + 1 : 1
          parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`)
        }
        return parts.join(' > ')
      }
      const pick = (event: MouseEvent) => {
        if (!(event.target instanceof HTMLElement) || toolbar.contains(event.target)) return
        event.preventDefault(); event.stopImmediatePropagation()
        if (selected) selected.style.removeProperty('outline')
        selected = event.target.closest<HTMLElement>('button,input,textarea,select,[data-bloma-id],[role],h1,h2,h3,p,li,article,section') ?? event.target
        selected.style.outline = '3px solid #6366f1'; hint.textContent = `已选 ${(selected.textContent ?? selected.getAttribute('aria-label') ?? selected.tagName).trim().slice(0, 32)}`
      }
      document.addEventListener('click', pick, true)
      send.onclick = async () => {
        if (!selected || !note.value.trim()) { hint.textContent = '请先选择一处并填写意见'; return }
        const rect = selected.getBoundingClientRect()
        try { await host.__blomaUserPick({ seq: ++seq, componentId: selector(selected), displayName: (selected.textContent || selected.getAttribute('aria-label') || selected.tagName).trim().slice(0, 60), kind: kind.value, note: note.value.trim().slice(0, 200), source: 'user', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } }); hint.textContent = `已记录 ${seq} 处`; note.value = '' }
        catch { hint.textContent = '记录失败，意见仍保留，请重试' }
      }
      done.onclick = async () => { try { await host.__blomaUserPick({ type: 'done' }); document.removeEventListener('click', pick, true); hint.textContent = '点选已完成，请回Bloma提交修改' } catch { hint.textContent = '提交未成功，请重试' } }
    })
    return { child, pid:child?.pid??servicePid, close, dataSnapshotted }
  } catch (error) { await close(); throw error }
}
