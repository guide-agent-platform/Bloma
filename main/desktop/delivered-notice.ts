import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/document-engine'
import { requirementVerificationContext } from '../project/requirement-contract'
import { getDesktopPhase } from './dispatcher-phases'
import { digestDeliveryDoc } from './notice-cards'
import { verificationFingerprint } from './verification-fingerprint'
import type { DesktopDispatchRunResult } from './dispatcher-loop'
import type { CoreVerificationResult } from './core-verification'

/** Presentation only: unavailable or stale evidence must not acquire a verified label. */
export function assembleDeliveredNotice(projectId: string, projectName: string, fromPhase: string, result: DesktopDispatchRunResult) {
  const root = findProject(projectId)?.root_path
  let entryFile: string | undefined
  let deliveryDigest: string | undefined
  if (root) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, '00_SCAFFOLD', 'contract.json'), 'utf8')) as { entry?: unknown }
      if (typeof parsed.entry === 'string') entryFile = parsed.entry
    } catch { /* presentation may omit an unavailable entry */ }
    try { deliveryDigest = digestDeliveryDoc(readFileSync(join(root, 'DELIVERY.md'), 'utf8')) }
    catch { /* a missing delivery document does not invent a summary */ }
  }
  const report = result.driverReport
  let coreScope: string[] | undefined
  if (root) try {
    const core = JSON.parse(readFileSync(join(root, '00_VERIFY/core-verification.json'), 'utf8')) as CoreVerificationResult
    const current = verificationFingerprint(root, requirementVerificationContext(readPrdBackplane(projectId)))
    if (core.status === 'passed' && current && core.fingerprint === current) coreScope = [
      '登记场景回读',
      ...(core.gui_execution ? ['界面驱动入口'] : []),
      ...(core.speech ? ['固定音频经真实模型解码（物理采集另列证据）'] : []),
      ...(core.file_operations ? ['文件操作固定反例'] : []),
      ...(core.llm ? ['模型入口的本机 HTTP 请求与错误处理（外部内容质量另验）'] : []),
    ]
  } catch { /* historical projects without current evidence remain unqualified */ }
  const driverSummary = report && report.scenarios.length > 0
    ? { passed: report.scenarios.filter(scenario => scenario.outcome === 'pass').length, total: report.scenarios.length } : undefined
  let screenshotPaths: string[] | undefined
  if (root) try {
    screenshotPaths = readdirSync(join(root, '00_VERIFY', 'screenshots'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
      .map(entry => `00_VERIFY/screenshots/${entry.name}`).sort().slice(0, 4)
    if (!screenshotPaths.length) screenshotPaths = undefined
  } catch { /* no screenshots to present */ }
  return { projectName, fromPhaseTitle: getDesktopPhase(fromPhase)?.title ?? fromPhase,
    ...(coreScope ? { coreScope } : {}), ...(entryFile ? { entryFile } : {}), ...(deliveryDigest ? { deliveryDigest } : {}),
    ...(driverSummary ? { driverSummary } : {}), ...(screenshotPaths ? { screenshotPaths } : {}) }
}
