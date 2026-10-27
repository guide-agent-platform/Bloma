import type { SketchRequirement } from './prd-backplane'

/** Verification adapters attached to confirmed features, never to installed packages. */
export const REQUIREMENT_CAPABILITIES = ['llm', 'speech', 'microphone', 'prefix_rename', 'rename_undo'] as const
export type RequirementCapability = typeof REQUIREMENT_CAPABILITIES[number]

export function validRequirementCapabilities(value: unknown): value is RequirementCapability[] {
  return Array.isArray(value) && value.every(item => REQUIREMENT_CAPABILITIES.includes(item))
}

/** Old projects retain a narrow compatibility inference. New structured declarations
 * (including an explicit empty list) take precedence and are bound to the scope hash. */
export function requirementCapabilities(item: SketchRequirement): ReadonlySet<RequirementCapability> {
  const result = new Set<RequirementCapability>()
  if (item.capabilities !== undefined) {
    if (!validRequirementCapabilities(item.capabilities)) throw new Error(`INVALID_REQUIREMENT_CAPABILITIES: ${item.id}`)
    for (const capability of item.capabilities) result.add(capability)
  } else {
    const clauses = [item.description, item.story ?? '', ...(item.behavior_assertions ?? [])].join('\n')
      .split(/[，。；,;\n]|但是|但|不过/).map(text => text.trim())
      .filter(text => !/^(?:(?:本版|该功能|此功能|系统|产品|用户)\s*)?(?:不需要|无需|不用|不要|不支持|不包含|不提供|禁止)|^(?:no\b|without\b|do(?:es)? not\b)/i.test(text))
    for (const text of clauses) {
      if (/\b(?:LLM|AI)\b|大模型|真实模型|智能(?:总结|翻译|回答|对话|生成|润色)|(?:模型).*(?:调用|增强|Key|API|密钥)|(?:Key|密钥).*(?:模型|AI)/i.test(text)) result.add('llm')
      if (/(?:语音(?:输入|录入|识别|转写|转文字)|音频(?:文件)?(?:识别|转写|转文字)|(?:导入|上传).*音频.*(?:文字|转写)|麦克风|录音|\bASR\b)/i.test(text)) result.add('speech')
      if (/(?:麦克风|录音|语音(?:输入|录入))/.test(text)) result.add('microphone')
      if (/(?:文件|文件夹|目录|文件名)/.test(text) && /前缀/.test(text) && /(?:重命名|改名)/.test(text)) {
        result.add('prefix_rename')
        if (/撤销|还原/.test(text)) result.add('rename_undo')
      }
    }
  }
  if (result.has('microphone')) result.add('speech')
  if (result.has('rename_undo')) result.add('prefix_rename')
  return result
}
