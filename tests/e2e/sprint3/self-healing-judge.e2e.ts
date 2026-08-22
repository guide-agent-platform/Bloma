import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'

/**
 * Sprint 3 · self-healing-judge 权限让渡（Playwright Electron）——排期内欠账「sprint3 E2E」。
 *
 * 覆盖 self-healing-judge.feature @S3-JUDGE-009（本轮新增场景）：
 * 危险级回滚（rollback_snapshot）必须经用户确认，拒绝时不执行、内容不被改动，
 * 且用户可见文案不暴露技术堆栈（P0 文案安全）。
 *
 * 说明：完整熔断回滚链（修复失败达上限 → 自动回滚健康快照 + rollback_done）依赖真实
 * LLM 渠道与多轮失败修复，无法在无渠道的 E2E 环境稳定驱动——该链路由 acceptance
 * `auto-repair.test.ts` 覆盖。本 E2E 聚焦其「权限让渡」门禁在真实 Electron + 真实 IPC
 * 下可确定性验证的收口：deny 拒绝危险回滚 → 内容未改动 + P0 安全文案。
 *
 * 已知依赖（allow-all × dangerous 契约，F8 产品缺陷单独立项）：
 * 本用例前提「allow-all 下 dangerous 级仍弹确认窗」当前成立——主进程 canUseTool
 * allow-all 时 warning 放行、dangerous 仍进 pendingRequests；渲染端 permissionModeAtom
 * 不随主进程 setMode 广播（恒为默认 'ask'），PermissionDialog 因此照常渲染。若未来
 * 修复 atom 同步，需同步统一 PermissionDialog 的 allow-all 分支契约，否则本用例会挂起。
 *
 * 驱动路径（与 correction-analytics.e2e.ts 同风格）：
 * 1. 进入 quick 工作区（mode-card-quick 已创建项目），权限切 allow-all
 *    （warning 级 create_snapshot 自动放行，dangerous 级回滚仍弹确认窗）；
 * 2. 对该项目创建两个快照；
 * 3. reload 走回访恢复，时间轴加载快照列表；
 * 4. 点击非当前快照 chip → 确认弹窗 → 确认回到这里 → snapshot.rollback
 *    （dangerous 级 → 权限确认窗 → 拒绝）；
 * 5. 断言：UI 播报「当前版本没有被改动」且不含技术堆栈；磁盘指针未变（仍指向 snapB）、
 *    无 user_undo 埋点、无 rollback_guard 保护快照（回滚未执行）。
 *
 * 文档依据：self-healing-judge.feature @S3-JUDGE-009、sprint-plan.md §6、testing-standards.md §8。
 */

const analyticsPath = (promaHome: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')

const snapshotsDir = (promaHome: string, projectId: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'snapshots', projectId)

const projectsJsonPath = (promaHome: string) => join(promaHome, 'projects.json')

function readAnalytics(promaHome: string): string {
  return existsSync(analyticsPath(promaHome)) ? readFileSync(analyticsPath(promaHome), 'utf8') : ''
}

/** 读 projects.json 中某项目的 current_snapshot_id（磁盘指针，回滚事务第一步即落盘）。 */
function readCurrentSnapshotId(promaHome: string, projectId: string): string | null {
  if (!existsSync(projectsJsonPath(promaHome))) return null
  const index = JSON.parse(readFileSync(projectsJsonPath(promaHome), 'utf8')) as {
    projects?: Array<{ project_id?: string; current_snapshot_id?: string }>
  }
  return index.projects?.find((p) => p.project_id === projectId)?.current_snapshot_id ?? null
}

test('[S3-JUDGE-009-e2e] 危险回滚被用户拒绝 → 快照指针未变 + P0 安全文案 + 无 user_undo/guard', async ({ bloma }) => {
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

    // ② 创建两个快照（危险回滚的目标 + 拒绝后应保持的当前版本）
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

  // P0 文案安全：对话区可见文本不暴露代码/堆栈/内部标识。
  // 单元素定位（chat-panel 全库唯一）——修复审查 R1：原「选择器组 + .catch」在 strict
  // mode 下双命中抛错被吞、恒真空操作；探针已复现（test-results/probe-f1.cjs）。
  const panel = bloma.page.locator('[data-ai-id="chat-panel"]')
  const visibleText = (await panel.count())
    ? await panel.innerText()
    : await bloma.page.locator('body').innerText()
  expect(visibleText).not.toMatch(/node_modules|Error: |at |TypeError|ReferenceError/)

  // ⑦ 回滚未执行的磁盘铁证：快照指针未被回滚事务改写。
  //    注意：经 IPC 直接 snapshots.create 不写项目指针（指针由编程编排更新），
  //    因此基线是 null；deny 后指针必须**保持 null**（若回滚执行过，指针会变成目标快照 id）。
  //    deny 已由上一断言（P0 文案）确认结算，此处为单采样兜底（负向 poll 首帧即返回）。
  expect(readCurrentSnapshotId(bloma.promaHome, projectId)).toBe(null)

  // ⑧ 磁盘无 user_undo 埋点、无 rollback_guard 保护快照（同上，单采样兜底）
  expect(readAnalytics(bloma.promaHome).includes('user_undo')).toBe(false)
  const snapDir = snapshotsDir(bloma.promaHome, projectId)
  expect(listSnapshotFolders(snapDir).some((meta) => meta.includes('rollback_guard'))).toBe(false)
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
