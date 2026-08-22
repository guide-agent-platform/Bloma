import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'

/**
 * Sprint 3 · self-healing-judge 权限让渡（Playwright Electron）——排期内欠账「sprint3 E2E」。
 *
 * 覆盖 self-healing-judge.feature @S2-JUDGE 的危险操作门禁语义：
 * 危险级回滚（rollback_snapshot）必须经用户确认，拒绝时不执行、内容不被改动，
 * 且用户可见文案不暴露技术堆栈（S2-JUDGE-008 / P0 文案安全）。
 *
 * 说明：完整熔断回滚链（修复失败达上限 → 自动回滚健康快照 + rollback_done）依赖真实
 * LLM 渠道与多轮失败修复，无法在无渠道的 E2E 环境稳定驱动——该链路由 acceptance
 * `auto-repair.test.ts` 覆盖。本 E2E 聚焦其「权限让渡」门禁在真实 Electron + 真实 IPC
 * 下可确定性验证的收口：deny 拒绝危险回滚 → 内容未改动 + P0 安全文案。
 *
 * 驱动路径（与 correction-analytics.e2e.ts 同风格）：
 * 1. 进入 quick 工作区（mode-card-quick 已创建项目），权限切 allow-all
 *    （warning 级 create_snapshot 自动放行，dangerous 级回滚仍弹确认窗）；
 * 2. 对该项目创建两个快照；
 * 3. reload 走回访恢复，时间轴加载快照列表；
 * 4. 点击非当前快照 chip → 确认弹窗 → 确认回到这里 → snapshot.rollback
 *    （dangerous 级 → 权限确认窗 → 拒绝）；
 * 5. 断言：UI 播报「当前版本没有被改动」且不含技术堆栈；磁盘无 user_undo 埋点、
 *    无 rollback_guard 保护快照（回滚未执行）。
 *
 * 文档依据：self-healing-judge.feature、sprint-plan.md §6、testing-standards.md §8（P0 文案）。
 */

const analyticsPath = (promaHome: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')

const snapshotsDir = (promaHome: string, projectId: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'snapshots', projectId)

function readAnalytics(promaHome: string): string {
  return existsSync(analyticsPath(promaHome)) ? readFileSync(analyticsPath(promaHome), 'utf8') : ''
}

test('[S3-JUDGE-008-e2e] 危险回滚被用户拒绝 → 内容未改动 + P0 安全文案 + 无 user_undo/guard', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)

  // ① 取进入工作区时创建的项目，权限切 allow-all（warning 级 create_snapshot 自动放行）
  const driver = await bloma.page.evaluate(async () => {
    const api = window.electronAPI
    if (!api) return { ok: false as const, reason: 'no electronAPI' }
    await api.permissions.setMode({ request_id: 'e2e-judge-perm', mode: 'allow-all' })
    const listed = await api.project.list({ request_id: 'e2e-judge-list' })
    const project = (listed.ok && listed.data?.[0]) || null
    if (!project) return { ok: false as const, reason: 'no project' }
    const projectId = project.project_id

    // ② 创建两个快照（危险回滚的目标 + 当前版本）
    const snapA = await api.snapshots.create({
      request_id: 'e2e-judge-snap-a',
      project_id: projectId,
      kind: 'sketch',
      summary: '初版草图',
      include_documents: false,
      health_status: 'healthy',
    })
    const snapB = await api.snapshots.create({
      request_id: 'e2e-judge-snap-b',
      project_id: projectId,
      kind: 'mvp',
      summary: '完整 MVP',
      include_documents: false,
      health_status: 'healthy',
    })
    if (!snapA.ok || !snapA.data || !snapB.ok || !snapB.data) {
      return { ok: false as const, reason: 'snapshot create failed' }
    }
    return { ok: true as const, project_id: projectId }
  })

  expect(driver.ok).toBe(true)
  const projectId = driver.project_id as string

  // ③ reload 走回访恢复：时间轴加载磁盘快照列表
  await bloma.page.reload()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
  const snapChip = bloma.page.locator('[title^="回到「"]').first()
  await expect(snapChip).toBeVisible()

  // ④ 点击非当前快照 chip → 确认弹窗 → 确认回到这里
  await snapChip.click()
  await expect(bloma.page.locator('[data-ai-id="rollback-confirm-modal"]')).toBeVisible()
  await bloma.page.getByRole('button', { name: '确认回到这里' }).click()

  // ⑤ dangerous 级回滚 → 主进程权限确认窗出现 → 拒绝
  const permissionDialog = bloma.page.locator('[data-ai-id="permission-dialog"]')
  await expect(permissionDialog).toBeVisible()
  await bloma.page.locator('[data-ai-id="permission-deny"]').click()

  // ⑥ UI 如实告知「当前版本没有被改动」（P0 文案，不含技术堆栈）
  await expect
    .poll(() => bloma.page.locator('body').innerText().then((t) => t.includes('当前版本没有被改动')), { timeout: 20_000 })
    .toBe(true)
  await expect
    .poll(() => bloma.page.locator('body').innerText().then((t) => t.includes('已经回到')), { timeout: 5_000 })
    .toBe(false)

  // P0 文案安全：用户可见消息不暴露代码/堆栈/内部标识
  const visibleText = await bloma.page.locator('[data-ai-id="chat-panel"], body').innerText().catch(() => '')
  expect(visibleText).not.toMatch(/node_modules|Error: |at |TypeError|ReferenceError/)

  // ⑦ 回滚未执行：磁盘无 user_undo 埋点、无 rollback_guard 保护快照
  await expect.poll(() => readAnalytics(bloma.promaHome).includes('user_undo'), { timeout: 15_000 }).toBe(false)
  const snapDir = snapshotsDir(bloma.promaHome, projectId)
  await expect
    .poll(() => listSnapshotFolders(snapDir).some((meta) => meta.includes('rollback_guard')), { timeout: 15_000 })
    .toBe(false)
})

/** 读取快照目录下各快照 metadata.json 内容拼接串（校验 rollback_guard 保护快照不存在）。 */
function listSnapshotFolders(snapDir: string): string[] {
  if (!existsSync(snapDir)) return []
  const out: string[] = []
  for (const entry of readdirSync(snapDir)) {
    const full = join(snapDir, entry)
    if (!statSync(full).isDirectory() || entry === 'archive') continue
    const metaPath = join(full, 'metadata.json')
    if (existsSync(metaPath)) out.push(readFileSync(metaPath, 'utf8'))
  }
  return out
}

async function enterQuickWorkspace(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-ai-id="mode-card-quick"]').click()
  await expect(page.locator('[data-ai-id="workspace-header"]')).toBeVisible()
}
