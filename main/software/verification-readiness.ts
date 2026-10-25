import { existsSync, readFileSync } from 'node:fs'
import { guiSuitePath, parseGuiSuite } from '../desktop/gui-acceptance'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'

/** A read-only next action, never verification evidence or an extra gate. */
export function guiVerificationReadiness(projectId: string) {
  try {
    const project = findProject(projectId), brief = readPrdBackplane(projectId), scope = prdScopeFingerprint(brief)
    if (!brief.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope) {
      return { state: 'scope_unconfirmed', verification: 'not_run', note: '当前目标或界面方向尚未确认，不能据开发观察交付。' }
    }
    if (!existsSync(guiSuitePath(projectId))) return { state: 'rules_missing', verification: 'not_run', next_tool: 'register_gui_check',
      note: '主路径能运行时就登记本次业务规则，再verify_app按真实失败修复；不必等所有外观打磨完。' }
    const suite = parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8')))
    if (suite.scope_hash !== scope || suite.design_hash !== project.ux_confirmation.design_hash) {
      return { state: 'rules_stale', verification: 'not_run', next_tool: 'read_production_context', note: '现有规则与当前确认版本不一致，先核对verification-gui协议，不得降低预期。' }
    }
    return { state: 'rules_registered', verification: 'not_run', next_tool: 'verify_app',
      note: '已登记当前版本的规则，可运行宿主验收；开发观察不代表通过。' }
  } catch {
    return { state: 'rules_unreadable', verification: 'not_run', next_tool: 'read_production_context', note: '无法读取当前确认或规则，先核对verification-gui协议，不得跳过验证。' }
  }
}
