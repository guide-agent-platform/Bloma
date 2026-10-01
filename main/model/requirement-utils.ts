/**
 * 需求项通用工具（web 线拆除刀2 自 coding/stages/iterate 迁出，2026-10-01）：
 * id 生成与修改描述清洗——品类无关纯函数，消费方经 coding/programming-orchestrator 桩接入。
 */
import type { SketchRequirement } from './prd-backplane'

/** 为追加的需求项生成不冲突的 id（F-xxx 序号递增，规避已有 id 碰撞）。（web 线拆除刀2 自 coding/stages/iterate 迁出，2026-10-01） */
export function nextRequirementId(existing: SketchRequirement[]): string {
  const max = existing.reduce((acc, item) => {
    const match = /^F-(\d+)$/.exec(item.id)
    if (!match) return acc
    const num = Number(match[1])
    return Number.isFinite(num) && num > acc ? num : acc
  }, 0)
  return `F-${String(max + 1).padStart(3, '0')}`
}

/**
 * 修改诉求 → 需求项描述：剥离否定引导与口语前缀（「啥意思，我要音乐合成器」→
 * 「音乐合成器」）。纯需求文案清洗，非代码修补；清洗后为空则保留原文，绝不改写语义。
 * （web 线拆除刀2 自 coding/stages/iterate 迁出，2026-10-01）
 */
export function refineModificationDescription(text: string): string {
  let out = text.trim()
  out = out.replace(/^(不对|不是|搞错了|弄错了|错了|这不对|货不对板|什么意思|啥意思)[，,。！!～\s]*/, '')
  out = out.replace(/^(我要的是|我想要的是|我想要|我要|我希望(?:他|它|这个)?能?|我想|能不能|可以|请帮我|帮我)[，,。！!\s]*/, '')
  out = out.replace(/^[，,。！!\s]+/, '')
  return out.trim() || text.trim()
}
