// 零渠道欢迎引导卡 Electron e2e（2026-08-28，QW#2 二期收尾验证）：
// 真实 Electron + 隔离 PROMA_HOME（零渠道）→ 进入 quick 工作区 →
// 引导卡三要素（直达按钮/门禁卡文案/10 分钟时长）真实渲染断言 + 截图存档。
// 截图输出 evidence/welcome-card.png（.gitignore，验证工件不入库）。
import { test, expect } from '../support/electron-fixture'

test('[S3-WELCOME-01-e2e] 零渠道工作区引导卡真实渲染：直达按钮与降级文案可见', async ({ bloma }) => {
  await bloma.page.locator('[data-ai-id="mode-card-quick"]').click()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()

  // r58 P1-② 直达按钮 + P1-① 卡片文案在真实 Electron 中渲染
  const goButton = bloma.page.getByRole('button', { name: /去连接 AI 模型/ })
  await expect(goButton).toBeVisible()
  await expect(bloma.page.getByText(/门禁卡/)).toBeVisible()
  await expect(bloma.page.getByText(/首次约 10 分钟/)).toBeVisible()

  await bloma.page.screenshot({ path: 'evidence/welcome-card.png', fullPage: false })
})
