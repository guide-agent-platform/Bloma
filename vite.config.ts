import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  test: {
    root: __dirname,
    // 全局单测超时 30s：用例含真实 IO（mkdtemp/写盘/子流程），全量 62 文件并发时 IO 争抢
    // 可使单用例从 ~0.7s 膨胀到 >5s，默认 5s 偶发超时级联失败（2026-08-28 flaky 实测）。
    // 放宽后真 hang 的测试也能在 30s 内报失败，不影响 CI 时效（全量常态 ~9s）。
    testTimeout: 30_000,
    // PROMA_HOME 被 teardown 写成字符串 "undefined" 时统一归位，见该文件注释
    setupFiles: [resolve(__dirname, 'tests/support/proma-home-guard.ts')],
    // 启动时回收历史泄漏的测试临时 PROMA_HOME 目录（mkdtemp 命名模式 + 距上次修改 >30min），见该文件注释
    globalSetup: [resolve(__dirname, 'tests/support/tmp-home-sweep.ts')],
  },
})
