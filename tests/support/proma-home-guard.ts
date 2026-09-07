import { afterEach, beforeEach } from 'vitest'

/**
 * 全局兜底：防止 `PROMA_HOME` 被污染成字符串 "undefined"。
 *
 * Node 里 `process.env.X = undefined` 会强制转成字符串 `"undefined"`，因此 teardown 里
 * 裸写恢复（本机未设 PROMA_HOME 时原值即 undefined）
 * 会让后续用例把 `"undefined"` 当相对路径用，读写落到 cwd（项目根）下的 `./undefined/`。
 *
 * 逐处加守卫要改近百个 teardown，这里统一归位：`beforeEach` 保证每个用例起点干净，
 * `afterEach` 在污染发生后立刻还原（Vitest 默认 `sequence.hooks: 'stack'`，setup 文件的
 * after 钩子最后执行，即排在各测试文件自己的 teardown 之后）。
 */
function clearPollutedPromaHome(): void {
  const env = process.env.PROMA_HOME
  // 与 storage/config-paths.ts getPromaHome() 的防御语义对齐：
  // trim 后为 "undefined"/"null"/空串 的污染值一律删除，避免相对路径读写落到 cwd。
  const trimmed = env ? env.trim() : ''
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') delete process.env.PROMA_HOME
}

/**
 * 安全恢复 PROMA_HOME（P2④ 收敛：测试文件 teardown 统一走本函数）。
 * 本机未设时原值为 undefined，直接 `process.env.PROMA_HOME = undefined` 会被 Node
 * 强制转成字符串 "undefined"，污染成相对路径；本函数正确 delete。
 */
export function restorePromaHome(original: string | undefined): void {
  if (original === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = original
}

beforeEach(clearPollutedPromaHome)
afterEach(clearPollutedPromaHome)
