import { expect, test } from '../support/electron-fixture'

/**
 * Sprint 3 · 委派协作视图（Playwright Electron）。
 *
 * 确定性收口（无渠道可跑）：委派协作抽屉在真实 Electron + 真实 IPC 下可打开/关闭，
 * 空状态正确渲染（尚未发生 delegate 时给出用户可读提示）。
 *
 * 完整委派全链（父 loop delegate_agent → 子会话收敛 → 协作视图实时显示）依赖真实
 * Agent SDK 渠道（模型 tool use + 真实 loop），无渠道 E2E 环境无法稳定驱动，由 acceptance
 * `tests/acceptance/sprint3/agent-loop-pipeline.test.ts`（M4-C 委派全链 / S4-AGENT-008
 * 孤儿清理）覆盖同链路语义；本文件以 SKIP_BLOCKED 登记完整全链用例。
 *
 * 文档依据：api-spec §12.10（委派工具/事件，v1.4 补登）、sprint-plan §6、testing-standards §8。
 */

test('[S4-AGENT-E2E] 长期工作区中委派协作抽屉可打开/关闭且空状态正确', async ({ bloma }) => {
  // ① 进入精细打磨（longterm）工作区——协作按钮仅在 longterm 顶栏渲染
  await bloma.page.locator('[data-ai-id="mode-card-longterm"]').click()
  await bloma.page.locator('[data-ai-id="create-project-button"]').click()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()

  // ② 打开协作抽屉（WorkspaceHeader「协作」按钮门控 collaborationPanelExpandedAtom）
  const collabButton = bloma.page.locator('[data-ai-id="collaboration-button"]')
  await expect(collabButton).toBeVisible()
  await collabButton.click()

  // ③ 抽屉可见：标题 + 项目名 + 空状态提示（尚无 delegate 时用户可读文案）
  const panel = bloma.page.locator('[data-ai-id="collaboration-panel"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('委派协作', { exact: true })).toBeVisible()
  await expect(panel.getByText(/还没有委派子会话/)).toBeVisible()
  // 无委派行卡片（delegationsFamily 尚未归约出任何委派）
  await expect(panel.locator('[data-ai-id="collaboration-card"]')).toHaveCount(0)

  // ④ 关闭抽屉（门控 atom 复位，面板卸载）
  await bloma.page.locator('[data-ai-id="collaboration-panel-close"]').click()
  await expect(panel).toHaveCount(0)
})

test.skip('[S4-AGENT-E2E-全链] 委派完整全链（父 loop delegate_agent → 子会话收敛 → 协作视图实时显示）', async () => {
  // SKIP_BLOCKED：依赖真实 Agent SDK 渠道（模型 tool use + 真实 loop + delegate 工具）在
  // E2E 无渠道环境无法稳定驱动。解除条件：本机配置可用渠道 + BLOMA_AGENT_LOOP=1 + 真实
  // 模型支持 tool use。同链路语义由 acceptance `agent-loop-pipeline.test.ts` 覆盖。
})
