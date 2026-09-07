// 剪贴板图片粘贴 Electron e2e（2026-08-29 r67，clipboard-image-paste P1）：
// 真实 Electron + 隔离 PROMA_HOME → quick 工作区 → 合成 paste 事件（真实 DataTransfer/File）→
// 附件 chip 真实渲染 + pastedImage.save IPC 真实落盘（pasted-images/<sessionId>/*.png）→
// 零渠道发送联动（WC-P2）：直达设置页而非裸报错。截图存档 evidence/clipboard-paste.png。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../support/electron-fixture'

/** 1x1 红点 PNG（真实字节） */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('[S3-PASTE-01-e2e] 粘贴截图→chip 渲染→IPC 落盘→发送直达设置页（全链路真实闭环）', async ({ bloma }) => {
  await bloma.page.locator('[data-ai-id="mode-card-quick"]').click()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()

  // 真实 paste 事件：renderer 上下文构造 DataTransfer + File（Chromium 完整支持）
  await bloma.page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const textarea = document.querySelector('textarea')!
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    textarea.dispatchEvent(event)
  }, PNG_1PX_BASE64)

  // chip 真实渲染（缩略预览 dataURL + 可达名）
  const chip = bloma.page.locator('[data-ai-id="paste-image-chip"]')
  await expect(chip).toBeVisible()
  const thumb = bloma.page.locator('[data-ai-id="paste-image-thumb"]')
  await expect(thumb).toBeVisible()
  const src = await thumb.getAttribute('src')
  expect(src?.startsWith('data:image/png;base64,')).toBe(true)

  // IPC 存盘真实闭环：pasted-images/<sessionId>/*.png 落在隔离 PROMA_HOME
  const pastedRoot = join(bloma.promaHome, 'pasted-images')
  await expect
    .poll(() => {
      if (!existsSync(pastedRoot)) return 0
      return readdirSync(pastedRoot).flatMap((session) =>
        readdirSync(join(pastedRoot, session)).filter((f) => f.endsWith('.png')),
      ).length
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1)

  // 零渠道发送联动（WC-P2）：不发 run 不裸报错——直达设置页
  const input = bloma.page.locator('textarea')
  await input.fill('看看这张报错截图')
  await bloma.page.getByRole('button', { name: '发送消息' }).click()
  await expect(bloma.page.getByRole('tab', { name: '模型渠道' })).toBeVisible()

  await bloma.page.screenshot({ path: 'evidence/clipboard-paste.png', fullPage: false })
})
