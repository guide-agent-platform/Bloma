import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * PROMA_HOME global isolation (2026-09-25 test pollution fix):
 * Redirect all test disk writes (createProject / recordSessionActivity /
 * appendSessionMessage ...) into a per-process temp dir. Before this guard only
 * scrubbed polluted values — most tests never set PROMA_HOME themselves, so two
 * test days accumulated 80 unnamed empty projects in the real projects.json and
 * 13 non-UUID test session jsonl files in the real agent-sessions/ (user saw a
 * flood of empty conversations in the app). Tests that set PROMA_HOME themselves
 * still win: this assignment runs at setup-module load, any later assignment
 * overrides it; clearPollutedPromaHome only removes polluted values.
 */
const TEST_PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-vitest-home-'))
process.env.PROMA_HOME = TEST_PROMA_HOME

/**
 * 全局密闭守卫（2026-09-19 验收批发现）：本机 setx 的实验开关会随新进程环境渗入测试
 * （BLOMA_REAL_SCAFFOLD 等 10 个）——未钉开关的测试随机器环境漂移（prd-interface-spec
 * 快照实证：setx 后隔天新终端跑套件即红）。清扫后所有开关回落代码缺省值；需要 on 的
 * 用例在测试内显式设 env（既有模式），密闭且与机器环境无关。PROMA_HOME 同理由下方
 * 钩子兑底。
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BLOMA_')) delete process.env[key]
}
// Existing tests exercise the legacy confirmation protocol. The independent GUI
// preparation tests explicitly opt in and verify the new-project rollout path.
process.env.BLOMA_AUTO_GUI_ACCEPTANCE = '0'

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
