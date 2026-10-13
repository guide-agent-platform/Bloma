import { expect, test } from '../support/electron-fixture'

test('[S1-PROJECT-011] Electron 中选择快速尝鲜应创建项目并进入工作区', async ({ bloma }) => {
  await bloma.page.locator('[data-ai-id="mode-card-quick"]').click()
  await bloma.page.locator('[data-ai-id="create-project-button"]').click()

  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
  await expect(bloma.page.getByText('快速型', { exact: true })).toBeVisible()
  await expect(bloma.page.locator('[data-ai-id="mode-selection-page"]')).toHaveCount(0)
  await expect(bloma.page.getByText('技术栈')).toHaveCount(0)
})

test('[S1-PROJECT-012] Electron 中选择精细打磨应进入长期工作区并显示文档入口', async ({ bloma }) => {
  await bloma.page.locator('[data-ai-id="mode-card-longterm"]').click()
  await bloma.page.locator('[data-ai-id="create-project-button"]').click()

  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
  await expect(bloma.page.getByText('长期型', { exact: true })).toBeVisible()
  await expect(bloma.page.getByRole('button', { name: '文档' })).toBeVisible()
})

test('[S1-STORE-003] Electron 重启后应恢复活动项目而不是重新显示两道门', async ({ bloma }) => {
  await bloma.page.locator('[data-ai-id="mode-card-quick"]').click()
  await bloma.page.locator('[data-ai-id="create-project-button"]').click()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()

  await bloma.relaunch()

  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
  await expect(bloma.page.locator('[data-ai-id="mode-selection-page"]')).toHaveCount(0)
})
