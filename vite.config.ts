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
    // PROMA_HOME 被 teardown 写成字符串 "undefined" 时统一归位，见该文件注释
    setupFiles: [resolve(__dirname, 'tests/support/proma-home-guard.ts')],
  },
})
