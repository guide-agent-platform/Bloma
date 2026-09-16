/**
 * Phase 10 落地旅程（2026-09-16）：实验开关注册表——已知开关的单一清单（主进程 env
 * 实况只读出口）。渲染端经 app:switch-state IPC 消费（I4「渲染端无 env 透传」待办的
 * 窄收口：不透传全量 env，只给受控白名单）。
 * 只读不改：开关仍由环境变量/setx 管理（或未来设置页写入，登记待办）。
 */

export interface ExperimentSwitchMeta {
  id: string
  label: string
  note: string
}

/** 已知实验开关白名单（新增开关时同步登记——与开关矩阵文档对应）。 */
export const KNOWN_EXPERIMENT_SWITCHES: ExperimentSwitchMeta[] = [
  { id: 'BLOMA_EXPERIENCE', label: '经验库', note: '事件采集与规则消费总开关' },
  { id: 'BLOMA_EXP_RULE_INJECT', label: '行动规则注入', note: 'EXP-API-001 等规则进 loop（需经验库开）' },
  { id: 'BLOMA_FEEDBACK_CARD', label: '一键反馈卡', note: '保持现状后先问反馈' },
  { id: 'BLOMA_PROJECT_GIT', label: '产物 git 化', note: '项目工作区纳入 git 版本管理' },
  { id: 'BLOMA_ROLLBACK_CODE_ONLY', label: '回滚代码/数据分离', note: '回滚只回代码，数据先备份再保留' },
  { id: 'BLOMA_CONTEXT_PACK', label: '项目侦察包', note: '变更轮 task 头注入确定性事实速览' },
  { id: 'BLOMA_CHANGE_CONTRACT', label: '变更契约', note: '三向验收（正向/负向/兼容）+基线绑定' },
  { id: 'BLOMA_DATA_MIGRATE', label: '数据迁移守卫', note: 'schema 版本+_migrate 约定+终验演练' },
  { id: 'BLOMA_EXPORT_V2', label: '导出清单 v2', note: 'export-manifest+git 基线+升级链' },
  { id: 'BLOMA_GUIDE_LOOP', label: '向导 loop 化', note: '向导澄清腿走 agent loop（09-16 已缺省 on）' },
  { id: 'BLOMA_API_RECONCILE', label: '终验静态对账', note: '前端⇄路由⇄契约三方对账（Phase 9 W1）' },
]

/** 读当前实况（'1'/'on'/'true'=开；未设与其余=关）。 */
export function readExperimentSwitches(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const meta of KNOWN_EXPERIMENT_SWITCHES) {
    const raw = (process.env[meta.id] ?? '').trim().toLowerCase()
    out[meta.id] = raw === '1' || raw === 'on' || raw === 'true'
  }
  return out
}
