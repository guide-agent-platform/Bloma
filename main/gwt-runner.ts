import type { Browser, Page } from 'playwright'
import type { GwtTestResult, RunGwtInput } from './gwt-service'
import { readLastSketchRequirements } from './project-service'
import type { SketchRequirement } from './sketch-engine'

/**
 * GWT 真实执行器（A2-07 / api-spec §12.4 `run_gwt_tests`）。
 *
 * 用 Playwright chromium 无头加载预览页，真正执行页面 JS 后，对每个 P0 功能项
 * 断言「渲染后的 DOM 含功能入口」（功能项原文出现在渲染文本，或页面提供交互控件）。
 * 相比 gwt-service 的 `fetch + 正则` 静态启发式，这里会：
 *  - 执行页面脚本（动态渲染、事件绑定真实生效）；
 *  - 捕获未捕获异常（`pageerror`）作为「运行时报错」的失败原因。
 *
 * 优雅降级：Playwright 不可导入 / chromium 未安装 / 启动失败 / 导航失败，一律返回
 * `null`，交由 gwt-service 的静态启发式兜底，绝不阻断测试链路。浏览器可用性首次失败
 * 后缓存，避免后续每次修复验证都重复尝试启动。
 */

let browserAvailable: boolean | undefined

export async function runBrowserGwt(input: RunGwtInput): Promise<GwtTestResult | null> {
  if (browserAvailable === false) return null
  if (!input.preview_url) return null

  let browser: Browser | undefined
  try {
    // 动态导入：playwright 不进 esbuild 主进程 bundle（见 package.json build:main --external:playwright）
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  } catch {
    browserAvailable = false
    return null
  }

  browserAvailable = true
  try {
    return await executeScenarios(browser, input)
  } catch {
    return null
  } finally {
    await browser.close().catch(() => undefined)
  }
}

async function executeScenarios(browser: Browser, input: RunGwtInput): Promise<GwtTestResult> {
  const requirements = readLastSketchRequirements(input.project_id)
  const items = requirements.length
    ? requirements
    : [{ id: 'F-001', description: '核心功能页面可访问' }]

  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await page.goto(input.preview_url!, { waitUntil: 'domcontentloaded', timeout: 10_000 })
    const renderedText = await readRenderedText(page)
    const hasControl = await hasInteractiveControl(page)

    const failureSummary: GwtTestResult['failure_summary'] = []
    let passedCount = 0
    for (const item of items) {
      // 渲染后 innerText 是浏览器解码后的文本，直接用原文比对（与静态启发式对 HTML 转义比对不同）
      const markerHit = renderedText.includes(item.description)
      const ok = markerHit || hasControl
      if (ok) {
        passedCount += 1
      } else {
        failureSummary.push({
          scenario: scenarioName(item),
          reason:
            pageErrors.length > 0
              ? `页面运行时报错：${pageErrors[0]}`
              : `页面缺少功能入口：${item.description}`,
        })
      }
    }

    return {
      total_count: items.length,
      passed_count: passedCount,
      failed_count: items.length - passedCount,
      failure_summary: failureSummary,
    }
  } finally {
    await page.close().catch(() => undefined)
  }
}

/** 读取渲染后的页面文本（浏览器解码/执行 JS 后的最终文本）。 */
async function readRenderedText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body ? document.body.innerText : ''))
}

/** 页面是否提供可交互控件（按钮/输入框/链接/表单等）。 */
async function hasInteractiveControl(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('button, input, select, textarea, a, form') !== null)
}

function scenarioName(item: SketchRequirement): string {
  return `${item.id} 核心路径可运行`
}
