import type { ProjectMode, TemplateType } from '../../../shared/types'
import { loadProjectTemplate } from '../../project/project-templates'

/** PRD wording examples only; desktop execution owns its own production context. */
export function buildPrdFewShotInjection(type: TemplateType): string | null {
  const template = loadProjectTemplate(type)
  return template?.sample ? ['【同类型产品示例（仅参考措辞与粒度，不要照抄内容）】', template.sample].join('\n') : null
}

/** Categories for the legacy-readable GWT document, not desktop verification authority. */
export function gwtRequiredCategories(mode: ProjectMode, level: 'loose' | 'standard', type?: TemplateType): string[] {
  if (type === 'game') {
    const game = ['主路径(P0)', '状态机', '碰撞', '胜负边界']
    return mode === 'longterm' ? [...game, '空态'] : game
  }
  return mode === 'longterm' || level === 'standard' ? ['主路径(P0)', '边界', '空态', '异常'] : ['主路径(P0)', '边界', '异常']
}
