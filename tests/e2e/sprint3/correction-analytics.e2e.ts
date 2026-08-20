import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../support/electron-fixture'

/**
 * Sprint 3 · 端到端（Playwright Electron）——排期内欠账「sprint3 E2E」。
 *
 * 覆盖 Sprint 3 新增且确定性可验证的主链路（经真实 IPC + 磁盘落盘）：
 * 1. S3-CORRECT-004 点选纠错重复追问（repeat_count / should_follow_up）+ point_correction 埋点；
 * 2. mode_upgraded / satisfaction_marked / project_finalized 三类埋点 + 状态流转；
 * 3. FIRT < 60s 指标落盘（sketch_generated.duration_ms / page_count，供 research-plan §5 统计中位数）。
 */

const analyticsPath = (promaHome: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')

const projectEventsPath = (promaHome: string, projectId: string) =>
  join(promaHome, 'agent-workspaces', 'default-software-builder', 'events', `${projectId}.jsonl`)

function readAnalytics(promaHome: string): string {
  return existsSync(analyticsPath(promaHome)) ? readFileSync(analyticsPath(promaHome), 'utf8') : ''
}

test('[S3-CORRECT-004-e2e] 点选纠错经真实 IPC 重复追踪，第三次主动追问并落 point_correction 埋点', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)

  const driver = await bloma.page.evaluate(async () => {
    const api = window.electronAPI
    if (!api) return { ok: false as const, reason: 'no electronAPI' }
    const created = await api.project.create({
      request_id: 'e2e-s3-create',
      mode: 'quick',
      initial_message: '做一个待办清单页面',
    })
    if (!created.ok || !created.data) return { ok: false as const, reason: 'create failed' }
    const projectId = created.data.project_id

    // mode 'guess' 且无 user_note/text_content → extractCorrectionPrompt 为空，不触发再生成（确定性）
    const correction = (requestId: string) => ({
      request_id: requestId,
      project_id: projectId,
      session_id: 'e2e-s3-session',
      mode: 'guess' as const,
      context: {
        element_selector: '.todo-list .item',
        bounding_rect: { x: 10, y: 20, width: 100, height: 30 },
        fallback_mode: false,
      },
    })

    const first = await api.project.submitCorrection(correction('e2e-s3-correct-1'))
    const second = await api.project.submitCorrection(correction('e2e-s3-correct-2'))
    const third = await api.project.submitCorrection(correction('e2e-s3-correct-3'))

    return {
      ok: true as const,
      project_id: projectId,
      first: first.ok ? first.data : null,
      second: second.ok ? second.data : null,
      third: third.ok ? third.data : null,
    }
  })

  expect(driver.ok).toBe(true)
  const projectId = driver.project_id as string
  expect(driver.first).toMatchObject({ accepted: true, repeat_count: 1, prior_count: 0, should_follow_up: false })
  expect(driver.second).toMatchObject({ accepted: true, repeat_count: 2, prior_count: 1, should_follow_up: false })
  expect(driver.third).toMatchObject({ accepted: true, repeat_count: 3, prior_count: 2, should_follow_up: true })

  // point_correction 埋点落盘（research_safe）
  await expect
    .poll(() => readAnalytics(bloma.promaHome).includes('point_correction'), { timeout: 15_000 })
    .toBe(true)

  // 项目事件历史落盘 point_correction（带 repeat_count 供追溯）
  const eventsPath = projectEventsPath(bloma.promaHome, projectId)
  await expect
    .poll(() => existsSync(eventsPath) && readFileSync(eventsPath, 'utf8').includes('point_correction'), { timeout: 15_000 })
    .toBe(true)
})

test('[S3-ANALYTICS-e2e] 模式升级与收口埋点：mode_upgraded / satisfaction_marked / project_finalized', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)

  const driver = await bloma.page.evaluate(async () => {
    const api = window.electronAPI
    if (!api) return { ok: false as const, reason: 'no electronAPI' }
    const created = await api.project.create({
      request_id: 'e2e-s3-create-2',
      mode: 'quick',
      initial_message: '做一个记账页面',
    })
    if (!created.ok || !created.data) return { ok: false as const, reason: 'create failed' }
    const projectId = created.data.project_id

    const upgraded = await api.project.upgrade({
      request_id: 'e2e-s3-upgrade',
      project_id: projectId,
      session_id: 'e2e-s3-session',
    })
    const finalized = await api.project.finalize({
      request_id: 'e2e-s3-finalize',
      project_id: projectId,
      session_id: 'e2e-s3-session',
    })

    return {
      ok: true as const,
      mode_after_upgrade: upgraded.ok && upgraded.data ? upgraded.data.mode : undefined,
      status_after_finalize: finalized.ok && finalized.data ? finalized.data.status : undefined,
    }
  })

  expect(driver.ok).toBe(true)
  expect(driver.mode_after_upgrade).toBe('longterm')
  expect(driver.status_after_finalize).toBe('completed')

  await expect.poll(() => readAnalytics(bloma.promaHome).includes('mode_upgraded'), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => readAnalytics(bloma.promaHome).includes('satisfaction_marked'), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => readAnalytics(bloma.promaHome).includes('project_finalized'), { timeout: 15_000 }).toBe(true)
})

test('[S3-FIRT-e2e] 草图生成埋点含 FIRT 指标（duration_ms / page_count）', async ({ bloma }) => {
  await enterQuickWorkspace(bloma.page)
  await sendMessage(bloma.page, '做一个家庭记账页面，可以记录收入支出并看本月结余')

  // 草图（含 fallback 模板路径）就绪即落 sketch_generated 埋点，FIRT 指标随之落盘；
  // 无需等待 MVP 阶段的 webview，直接轮询 analytics.jsonl 即可。
  await expect
    .poll(() => {
      const contents = readAnalytics(bloma.promaHome)
      return contents.includes('sketch_generated') && contents.includes('duration_ms') && contents.includes('page_count')
    }, { timeout: 20_000 })
    .toBe(true)
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
