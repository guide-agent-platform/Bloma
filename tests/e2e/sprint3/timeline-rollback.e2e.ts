import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'

/**
 * Sprint 3 · 时间轴回滚（Playwright Electron）——排期内欠账「sprint3 E2E」。
 *
 * 覆盖 timeline-rollback.feature @S3-SNAPSHOT：点击非当前快照 chip → 确认弹窗 →
 * 走真实 `snapshots.rollback`（user_undo）→ UI 恢复到该版本。
 *
 * 驱动路径（与 correction-analytics.e2e.ts 同风格：preload 白名单真实 IPC + UI 交互）：
 * 1. 进入 quick 工作区（mode-card-quick 已创建项目），权限切 allow-all
 *    （warning 级 create_snapshot 自动放行，dangerous 级回滚仍弹确认窗）；
 * 2. 对该项目创建两个快照（sketch + mvp，均为健康）；
 * 3. reload 走回访恢复，时间轴加载快照列表；
 * 4. 点击非当前快照 chip → 确认弹窗 → 确认回到这里 → snapshot.rollback
 *    （dangerous 级 → 权限确认窗 → 允许）；
 * 5. 断言确定性产物：磁盘 rollback_guard 保护快照 + UI 播报「已经回到」。
 *
 * 说明：`user_undo` 埋点的写入正确性由 acceptance（analytics-completeness T8-003）
 * 覆盖，本 E2E 不再以埋点 poll 作为阻塞断言（时序跨 Electron+reload+沙箱不稳定）。
 *
 * 文档依据：timeline-rollback.feature、sprint-plan.md §6、research-plan.md §5。
 */

const snapshotsDir = (promaHome: string, projectId: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'snapshots', projectId)

test('[S3-SNAPSHOT-001-e2e] 时间轴点击非当前快照 → 确认 → 权限允许 → 真实 IPC 回滚 + guard 快照落盘', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)

  // ① 取进入工作区时创建的项目，权限切 allow-all：
  //    warning 级 create_snapshot 自动放行，dangerous 级 rollback_snapshot 仍弹确认窗。
  const driver = await bloma.page.evaluate(async () => {
    const api = window.electronAPI
    if (!api) return { ok: false as const, reason: 'no electronAPI' }
    await api.permissions.setMode({ request_id: 'e2e-roll-perm', mode: 'allow-all' })
    const listed = await api.project.list({ request_id: 'e2e-roll-list' })
    const project = (listed.ok && listed.data?.[0]) || null
    if (!project) return { ok: false as const, reason: 'no project' }
    const projectId = project.project_id

    // ② 创建两个快照（sketch + mvp，均为健康）
    const snapA = await api.snapshots.create({
      request_id: 'e2e-roll-snap-a',
      project_id: projectId,
      kind: 'sketch',
      summary: '初版草图',
      include_documents: false,
      health_status: 'healthy',
    })
    const snapB = await api.snapshots.create({
      request_id: 'e2e-roll-snap-b',
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

  // ③ reload 走回访恢复：回填磁盘快照列表到时间轴
  await bloma.page.reload()
  await expect(bloma.page.locator('[data-ai-id="workspace-header"]')).toBeVisible()

  // 时间轴出现非当前快照 chip（title 以「回到」开头；当前快照 title 为「当前版本」）
  const snapChip = bloma.page.locator('[title^="回到「"]').first()
  await expect(snapChip).toBeVisible()

  // ④ 点击非当前快照 chip → 确认弹窗 → 确认回到这里
  await snapChip.click()
  await expect(bloma.page.locator('[data-ai-id="rollback-confirm-modal"]')).toBeVisible()
  await bloma.page.getByRole('button', { name: '确认回到这里' }).click()

  // ⑤ 回滚为 dangerous 级：主进程权限确认窗出现 → 允许
  const permissionDialog = bloma.page.locator('[data-ai-id="permission-dialog"]')
  await expect(permissionDialog).toBeVisible()
  await bloma.page.locator('[data-ai-id="permission-allow"]').click()

  // ⑥ 确定性产物 A：磁盘出现 rollback_guard 保护快照
  //    （rollbackSnapshot 事务第一步创建，metadata.json 的 kind=rollback_guard）
  const snapDir = snapshotsDir(bloma.promaHome, projectId)
  await expect
    .poll(() => listSnapshotFolders(snapDir).some((meta) => meta.includes('rollback_guard')), { timeout: 20_000 })
    .toBe(true)

  // ⑦ 确定性产物 B：UI 播报「已经回到」。
  // 注意：rollback_guard 在回滚事务第一步落盘，但 UI 播报要等 rollbackSnapshot 内部
  // runSandbox 结束（测试项目 root_path 为空，沙箱启动可能等满超时）——因此放宽到 45s。
  await expect
    .poll(() => bloma.page.locator('body').innerText().then((t) => t.includes('已经回到「')), { timeout: 45_000 })
    .toBe(true)
})

/** 读取快照目录下各快照 metadata.json 内容拼接串（校验 rollback_guard 保护快照存在）。 */
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
