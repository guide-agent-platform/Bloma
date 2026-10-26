import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
export async function connectApp() {
    const endpoint = new URL(process.env.BLOMA_DEBUG_CDP ?? '');
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
        throw Error('BROWSER_SCRIPT_OWNED_ENDPOINT_REQUIRED');
    const downloads = join(process.env.APP_DATA_DIR, 'browser-downloads');
    mkdirSync(downloads, { recursive: true });
    const browser = await chromium.connectOverCDP(endpoint.href, { isLocal: true, artifactsDir: downloads });
    const all=browser.contexts().flatMap(context=>context.pages()),pages=[]
    for(const page of all){
      if(!process.env.BLOMA_DEBUG_TARGET){if(page.url()===process.env.BLOMA_DEBUG_PAGE)pages.push(page);continue}
      const cdp=await page.context().newCDPSession(page)
      try{const{targetInfo}=await cdp.send('Target.getTargetInfo');if(targetInfo.targetId===process.env.BLOMA_DEBUG_TARGET)pages.push(page)}finally{await cdp.detach()}
    }
    if (pages.length !== 1) {
        await browser.close();
        throw Error('BROWSER_SCRIPT_PAGE_NOT_UNIQUE');
    }
    pages[0].setDefaultTimeout(5000);
    return { browser, page: pages[0], context: pages[0].context() };
}
