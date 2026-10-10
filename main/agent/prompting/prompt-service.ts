import { existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PromptSlotDetail, PromptSlotId, PromptSlotInfo } from '../../../shared/types'
import { getPromptOverridePath, ensureDir } from '../../../storage/config-paths'
import { writeTextFileAtomic } from '../../../storage/json-store'
import { loadPromptOverride, promptOverrideNames } from './prompt-config'
import { UX_SKETCH_SYSTEM_PROMPT } from './ux-sketch-prompt'
import { DEFAULT_SYSTEM_PROMPT as PRD_DEFAULT } from '../../guide/prd-engine-llm'
import { DEFAULT_GUIDE_SYSTEM_PROMPT as GUIDE_DEFAULT } from '../../guide/guide-agent-service'
import { DEFAULT_SYSTEM_PROMPT as ENRICHER_DEFAULT } from '../../guide/requirement-enricher'
import { DEFAULT_SYSTEM_PROMPT as NORMALIZER_DEFAULT } from '../../guide/requirement-normalizer'

/**
 * PromptService — 引擎 system prompt 外置覆盖的界面化配置服务。
 *
 * 覆盖文件位于 `{PROMA_HOME}/prompts/{id}.md`（见 prompt-config.ts），文件存在即
 * **全量替换**内置默认、改完即时生效、无需重启。本服务为设置页「提示词配置」提供
 * 槽位清单、当前生效内容读取、覆盖写入与恢复默认（删除覆盖文件）能力。
 *
 * 六槽位：prd / sketch（静态 UX 草图）/ guide / enricher / normalizer / loop（追加）。
 * 前五槽位替换内置默认；loop 由 runAgentLoop 入口追加，不替换项目/阶段锚。
 */

interface PromptSlotDef {
  id: PromptSlotId
  label: string
  description: string
  enabled: boolean
  /** enabled 槽位的内置默认内容（无覆盖时展示），未启用槽位缺省 */
  getDefault?: () => string
}

const PROMPT_SLOTS: PromptSlotDef[] = [
  {
    id: 'prd-system',
    label: 'PRD 需求提炼提示词',
    description: '从对话历史提炼产品定位、功能验收要点、范围外与假设，供桌面实现和验收使用。',
    enabled: true,
    getDefault: () => PRD_DEFAULT,
  },
  {
    id: 'sketch-system',
    label: 'UX 外观草图提示词',
    description: '根据已确认需求生成 Windows 桌面外观草图（静态 HTML），用于确认界面方向。',
    enabled: true,
    getDefault: () => UX_SKETCH_SYSTEM_PROMPT,
  },
  {
    id: 'guide-system',
    label: '向导 Agent 对话提示词',
    description: '驱动向导 Agent 需求澄清对话（二选一 JSON 输出契约）。',
    enabled: true,
    getDefault: () => GUIDE_DEFAULT,
  },
  {
    id: 'enricher-system',
    label: '功能项加厚提示词',
    description: '把薄功能项补成 story + 行为断言 + 优先级（带反编造接地守卫）。',
    enabled: true,
    getDefault: () => ENRICHER_DEFAULT,
  },
  {
    id: 'normalizer-system',
    label: '修改诉求归一化提示词',
    description: '向导群·需求归一化腿：把修改诉求整理为故事化功能项（revise/append/skip/out_of_scope 四态）。',
    enabled: true,
    getDefault: () => NORMALIZER_DEFAULT,
  },
  {
    id: 'loop-system',
    label: 'Agent Loop 追加规则',
    description: '在默认行为之上追加自定义规则（追加模式），背板锚定段不可覆盖。',
    enabled: true,
    getDefault: () => '',
  },
]

function findSlot(promptId: string): PromptSlotDef {
  const slot = PROMPT_SLOTS.find((s) => s.id === promptId)
  if (!slot) throw new Error('VALIDATION_ERROR: unknown prompt slot')
  return slot
}

function hasOverride(promptId: string): boolean {
  return loadPromptOverride(promptId) !== null
}

export function listPromptSlots(): PromptSlotInfo[] {
  return PROMPT_SLOTS.map((slot) => ({
    id: slot.id,
    label: slot.label,
    description: slot.description,
    enabled: slot.enabled,
    has_override: hasOverride(slot.id),
  }))
}

export function readPromptSlot(promptId: PromptSlotId): PromptSlotDetail {
  const slot = findSlot(promptId)
  const override = loadPromptOverride(promptId)
  const content = slot.enabled
    ? (override ?? slot.getDefault?.() ?? '')
    : ''
  return {
    id: slot.id,
    label: slot.label,
    description: slot.description,
    enabled: slot.enabled,
    has_override: hasOverride(promptId),
    content,
  }
}

export function savePromptSlot(promptId: PromptSlotId, content: string): { saved: true; prompt_id: PromptSlotId } {
  const slot = findSlot(promptId)
  if (!slot.enabled) throw new Error('VALIDATION_ERROR: prompt slot not enabled')
  if (typeof content !== 'string') throw new Error('VALIDATION_ERROR: prompt content must be text')
  const trimmed = content.trim()
  if (!trimmed) throw new Error('VALIDATION_ERROR: prompt content must not be blank')
  const path = getPromptOverridePath(promptId)
  ensureDir(dirname(path))
  writeTextFileAtomic(path, trimmed)
  return { saved: true, prompt_id: promptId }
}

export function resetPromptSlot(promptId: PromptSlotId): { reset: true; prompt_id: PromptSlotId } {
  findSlot(promptId)
  for (const name of promptOverrideNames(promptId)) {
    const path = getPromptOverridePath(name)
    if (existsSync(path)) unlinkSync(path)
  }
  return { reset: true, prompt_id: promptId }
}
