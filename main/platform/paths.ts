/**
 * main 根目录定位（PR2 立规批新增）。
 *
 * 两态约束：源码态 main 根 = main/；esbuild bundle 后全部 main/*.ts 打进
 * dist-main/main/index.js，此时 main 根 = dist-main/main/（build:main 的 cpSync
 * 把 main/templates 落到 dist-main/main/templates，两态同源）。
 *
 * 本文件自身可能在 main/platform/ 等子目录，也可能被打进 bundle——统一用
 * 「向上搜索含 templates/ 的目录」定位 main 根，最多 4 级，找不到回退自身
 * 目录（调用方均有 existsSync/try-catch 兜底，行为与旧版"路径错了返回空"一致）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function mainRootDir(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url))
  let dir = selfDir
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'templates'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return selfDir
}
