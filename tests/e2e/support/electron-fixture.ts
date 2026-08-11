import { _electron as electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))

interface ProjectIndex {
  projects?: Array<{ project_id?: string }>
}

export class BlomaElectronApp {
  readonly promaHome = mkdtempSync(join(tmpdir(), 'bloma-electron-e2e-'))
  app!: ElectronApplication
  page!: Page

  async start(): Promise<void> {
    const userDataDir = join(this.promaHome, 'electron-user-data')
    this.app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, '.'],
      cwd: projectRoot,
      env: { ...process.env, PROMA_HOME: this.promaHome },
    })
    this.page = await this.app.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    await expect(this.page.locator('body')).toBeVisible()
  }

  async relaunch(): Promise<void> {
    await this.closeApplication()
    await this.start()
  }

  async previewHtml(): Promise<string> {
    const webview = this.page.locator('webview[title="软件预览"]')
    await expect(webview).toBeVisible()
    const webContentsId = await webview.evaluate((element) => (
      element as HTMLElement & { getWebContentsId(): number }
    ).getWebContentsId())
    return this.app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents) return ''
      return contents.executeJavaScript('document.documentElement.outerHTML') as Promise<string>
    }, webContentsId)
  }

  async attachFailureScreenshot(testInfo: TestInfo): Promise<void> {
    if (testInfo.status === testInfo.expectedStatus || !this.page || this.page.isClosed()) return
    await testInfo.attach('electron-window', {
      body: await this.page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
  }

  async dispose(): Promise<void> {
    await this.closeApplication()
    rmSync(this.promaHome, { recursive: true, force: true })
  }

  private async closeApplication(): Promise<void> {
    if (!this.app) return
    await this.stopSandboxes()
    await this.app.close().catch(() => undefined)
  }

  private async stopSandboxes(): Promise<void> {
    if (!this.page || this.page.isClosed()) return
    const projectIds = this.readProjectIds()
    if (projectIds.length === 0) return
    await this.page.evaluate(async (ids) => {
      for (const projectId of ids) {
        await window.electronAPI?.sandbox.stop({
          request_id: `e2e-stop-${projectId}`,
          project_id: projectId,
        })
      }
    }, projectIds).catch(() => undefined)
  }

  private readProjectIds(): string[] {
    const projectsPath = join(this.promaHome, 'projects.json')
    if (!existsSync(projectsPath)) return []
    const index = JSON.parse(readFileSync(projectsPath, 'utf8')) as ProjectIndex
    return (index.projects ?? [])
      .map((project) => project.project_id)
      .filter((projectId): projectId is string => Boolean(projectId))
  }
}

export const test = base.extend<{ bloma: BlomaElectronApp }>({
  bloma: async ({}, use, testInfo) => {
    const bloma = new BlomaElectronApp()
    try {
      await bloma.start()
      await use(bloma)
    } finally {
      await bloma.attachFailureScreenshot(testInfo)
      await bloma.dispose()
    }
  },
})

export { expect }
