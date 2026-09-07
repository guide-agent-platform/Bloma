import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'

const clearRequirement = '做一个家庭记账页面，可以记录收入支出并看本月结余'

test('[S1-SKETCH-007] Electron 中模糊需求应展示不超过三个生活化选项并包含你帮我决定', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await sendMessage(bloma.page, '帮我做个东西')

  const options = bloma.page.locator('[data-ai-id^="card-option-"]')
  await expect(options.first()).toBeVisible()
  const optionCount = await options.count()
  expect(optionCount).toBeGreaterThanOrEqual(2)
  expect(optionCount).toBeLessThanOrEqual(3)
  await expect(bloma.page.getByText('你帮我决定', { exact: true })).toBeVisible()
})

test('[S1-SKETCH-008] Electron 中明确需求应生成含脚本的可交互草图预览', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await sendMessage(bloma.page, clearRequirement)

  const html = await bloma.previewHtml()
  expect(html).toMatch(/<script(?:\s|>)/i)
  expect(html).toMatch(/<button\b/i)
})

test('[S1-SKETCH-009] 点击澄清选项时灰色说明不应被拼入用户回复', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await sendMessage(bloma.page, '帮我做个东西')

  const option = bloma.page.locator('[data-ai-id^="card-option-"]').first()
  await expect(option).toBeVisible()
  const label = (await option.locator('span').first().innerText()).trim()
  const description = (await option.locator('span').nth(1).innerText()).trim()
  expect(description).not.toBe('')
  await option.click()

  await expect.poll(() => lastPersistedUserMessage(bloma.promaHome)).toBe(label)
  expect(lastPersistedUserMessage(bloma.promaHome)).not.toContain(description)
})

test('[S1-UI-009] Electron 中等待反馈应在超过五秒后出现', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await bloma.page.clock.install()
  await bloma.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:send-message')
    ipcMain.handle('agent:send-message', () => new Promise(() => undefined))
  })

  await sendMessage(bloma.page, clearRequirement)

  await expect(bloma.page.getByRole('status')).toHaveCount(0)
  await bloma.page.clock.fastForward(5_100)
  await expect(bloma.page.getByRole('status')).toContainText('我正在帮你生成可运行版本')
})

test('[S1-ANALYTICS-002] Electron 草图闭环应落盘三类脱敏埋点', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await sendMessage(bloma.page, clearRequirement)
  await expect(bloma.page.locator('webview[title="软件预览"]')).toBeVisible()

  const analyticsPath = join(
    bloma.promaHome,
    'agent-workspaces',
    'default-software-builder',
    'analytics.jsonl',
  )
  await expect.poll(() => existsSync(analyticsPath)).toBe(true)
  const contents = readFileSync(analyticsPath, 'utf8')

  expect(contents).toContain('project_created')
  expect(contents).toContain('conversation_submitted')
  expect(contents).toContain('sketch_generated')
  expect(contents).not.toContain(clearRequirement)
})

async function enterQuickWorkspace(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-ai-id="mode-card-quick"]').click()
  await expect(page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
}

async function sendMessage(page: import('@playwright/test').Page, content: string): Promise<void> {
  const input = page.getByPlaceholder('描述你的想法…')
  await input.fill(content)
  await page.getByRole('button', { name: '发送消息' }).click()
}

function lastPersistedUserMessage(promaHome: string): string | undefined {
  const sessionsDir = join(promaHome, 'agent-sessions')
  if (!existsSync(sessionsDir)) return undefined
  const sessionFile = readdirSync(sessionsDir).find((file) => file.endsWith('.jsonl'))
  if (!sessionFile) return undefined
  const lines = readFileSync(join(sessionsDir, sessionFile), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  const messages = lines.map((line) => JSON.parse(line) as {
    role?: string
    content?: Array<{ type?: string; text?: string }>
  })
  const users = messages.filter((message) => message.role === 'user')
  return users.at(-1)?.content?.find((block) => block.type === 'text')?.text
}
