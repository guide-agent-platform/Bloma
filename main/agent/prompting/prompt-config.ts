import { existsSync, readFileSync } from 'node:fs'
import { getPromptOverridePath } from '../../../storage/config-paths'

/**
 * PromptConfig — 引擎 system prompt 外置覆盖（对齐 Proma 工作区配置模式：
 * 文件即真相，存在即生效）。
 *
 * 覆盖文件位于 `{PROMA_HOME}/prompts/{name}.md`（如 `prd-system.md`），
 * 文件存在且非空白时**全量替换**内置默认提示词；不存在/读失败/空白一律返回
 * `null`，由调用方回退内置默认，绝不阻断生成链路。
 *
 * 刻意不做缓存：每次生成才读一次盘，成本可忽略，换来「改文件即时生效、
 * 无需重启」。
 *
 * 当前接线：prd-system / sketch-system / guide-system / enricher-system / normalizer-system
 * 五引擎（80c0e07 全量接入，TDD）+ loop-system（追加模式槽位，废旧管道Loop转正时由
 * mvp-system 迁移改名，默认空、追加于动态 system 之后，背板锚定段不可覆盖）。

 */
export function loadPromptOverride(name: string): string | null {
  try {
    const path = getPromptOverridePath(name)
    if (!existsSync(path)) return null
    const content = readFileSync(path, 'utf8').trim()
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}
