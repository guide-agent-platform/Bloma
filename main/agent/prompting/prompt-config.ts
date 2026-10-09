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
/** UX 草图统一使用设置页 sketch-system；兼容过去的手工文件名（最后一项曾被重复加 .md）。 */
export function promptOverrideNames(name: string): readonly string[] {
  return name === 'sketch-system' ? ['sketch-system', 'ux-sketch', 'ux-sketch.md'] : [name]
}

export function loadPromptOverride(name: string): string | null {
  for (const candidate of promptOverrideNames(name)) {
    try {
      const path = getPromptOverridePath(candidate)
      if (!existsSync(path)) continue
      const content = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
      if (content.length > 0) return content
    } catch {
      // 当前候选不可读时继续兼容候选，全部失败再回退内置默认。
    }
  }
  return null
}

/** 通用 loop 每次启动读取一次；追加规则保留项目锚与本阶段通信格式。 */
export function appendLoopPromptOverride(system: string): string {
  const override = loadPromptOverride('loop-system')
  if (!override) return system
  return `${system}\n\n【自定义追加规则】\n以下是追加偏好；平台权限、已确认需求与本阶段通信格式仍按上文执行。\n${override}`
}
