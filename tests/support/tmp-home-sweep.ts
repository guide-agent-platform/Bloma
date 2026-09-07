import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 全局回收：测试泄漏的临时 PROMA_HOME 目录（2026-09-07 实测 TEMP 累积 5.4 万+）。
 *
 * 根因：测试用 `mkdtempSync(join(tmpdir(), 'bloma-accept-loop-'))` 等建目录、teardown
 * 的 `restorePromaHome` 只还原环境变量不删目录；自动化长期跑测即无限积灰。
 *
 * 策略：vitest globalSetup 启动时清扫 TEMP 中「命中 mkdtemp 命名模式 + 最后修改早于
 * 30 分钟前」的目录。并发跑测中的目录（含同时运行的多个 vitest 实例）都远新于 30 分钟
 * 且随用例读写持续刷新 mtime，不会误删；历史泄漏物借任意一次测试运行自动回收。
 * 删除尽力而为（force），文件被占用（Windows EBUSY/EPERM）跳过，下轮再清。
 */
const MKDTEMP_LIKE = /^(?:bloma|proma)-[a-z0-9-]+-[A-Za-z0-9]{6}$/
const MAX_AGE_MS = 30 * 60 * 1000

export default async function tmpHomeSweep(): Promise<() => void> {
  const now = Date.now()
  let removed = 0
  let skipped = 0
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!MKDTEMP_LIKE.test(name)) continue
      const p = join(tmpdir(), name)
      try {
        const st = statSync(p)
        if (!st.isDirectory() || now - st.mtimeMs < MAX_AGE_MS) continue
        rmSync(p, { recursive: true, force: true })
        removed++
      } catch {
        skipped++
      }
    }
  } catch {
    /* tmpdir 不可读：清扫是卫生不是功能，静默跳过 */
  }
  if (removed > 0 || skipped > 0) {
    console.log(`[tmp-home-sweep] 回收测试临时目录 ${removed} 个${skipped ? `（${skipped} 个被占用跳过，下轮再清）` : ''}`)
  }
  return () => {}
}
