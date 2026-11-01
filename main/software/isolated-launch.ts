import { createServer } from 'node:net'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import { loopbackUrl } from './process-manager'
/** Reuse a normal launch declaration with a free local port; never rewrite
 * business source or borrow the user's already-running backend. */
export async function isolatedBrowserLaunch(launch:LaunchDeclaration):Promise<LaunchDeclaration>{
  if(launch.ui!=='browser'||!launch.url)return launch
  const original=new URL(loopbackUrl(launch.url)),oldPort=original.port||'80',server=createServer()
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)})
  const address=server.address();await new Promise<void>(done=>server.close(()=>done()))
  if(!address||typeof address==='string')throw Error('ISOLATED_PORT_UNAVAILABLE')
  original.port=String(address.port)
  return{...launch,url:original.href,command:launch.command.map(arg=>arg===oldPort?String(address.port):arg===launch.url?original.href:arg===`--port=${oldPort}`?`--port=${address.port}`:arg)}
}
