import type { ToolFeedback, ToolBudgetFact } from '../../shared/tool-feedback'
import type { DriverScenarioOutcome } from './process-driver'

/** Generic Python execution is not a declared business driver. Assertions, not
 * exit codes, determine verification; exceptions retain their stderr for inspection. */
export function scriptExecutionFacts(code: number, scenarios: DriverScenarioOutcome[], budget: ToolBudgetFact): {
  feedback: ToolFeedback; verificationStatus: 'pass' | 'fail' | 'blocked' | 'not_reported'; verdict: string
} {
  const f: ToolFeedback = { schema_version: 1, execution: code === 0 ? 'completed' : 'failed', verification: 'unverified',
    scope: 'reported_scenarios', source: 'host', exit_code: code, budget }
  if (scenarios.some(s => s.outcome === 'blocked')) {
    return { feedback: { ...f, category: 'environment', recovery: 'prepare_environment' }, verificationStatus: 'blocked', verdict: '场景回读含 BLOCKED，业务验证未完成。' }
  }
  if (scenarios.some(s => s.outcome === 'fail')) {
    return { feedback: { ...f, verification: 'failed', category: 'product_assertion', recovery: 'repair_product' }, verificationStatus: 'fail', verdict: '场景回读含 FAIL 断言，保留具体失败场景。' }
  }
  if (code !== 0) {
    return { feedback: { ...f, category: 'verification_harness', reason: 'PROCESS_EXIT_WITHOUT_FAILURE_ASSERTION', recovery: 'inspect' },
      verificationStatus: 'not_reported', verdict: '脚本执行失败，未回读有效 FAIL 断言；检查 stderr 确认错误在被测程序还是验证脚本，不能据退出码称为产品业务失败。' }
  }
  if (scenarios.some(s => s.outcome === 'pass')) return { feedback: { ...f, verification: 'passed' }, verificationStatus: 'pass', verdict: '已回读 PASS 场景；通过范围仅限这些实际报告的断言。' }
  return { feedback: f, verificationStatus: 'not_reported', verdict: '未报告业务断言，退出码 0 只表示进程正常结束。' }
}
