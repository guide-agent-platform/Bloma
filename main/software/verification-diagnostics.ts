import { ReleaseIntegrityError } from './release-store'
import type { SoftwareVerification } from './verification'
import { NativeTestContractError } from './native-gui-tests'

export interface VerificationFailure {
  category: 'product_assertion' | 'test_adapter' | 'environment' | 'harness' | 'unknown'
  classification_basis?: 'host_runtime'|'assertion'|'unresolved'|'legacy'
  code: string
  step?: string
  expected: unknown
  actual: unknown
  paths: string[]
  allowed_changes: string[]
  next_tool: string
  next: string
}
export function verificationFailure(result: SoftwareVerification, error?: unknown): VerificationFailure | undefined {
  if (result.status === 'passed') return
  if(result.status==='unverified'&&result.independent?.semantics?.ready===false)return{
    category:'unknown',classification_basis:'unresolved',code:'INDEPENDENT_SEMANTICS_UNRESOLVED',expected:'已确认需求和可追溯的冻结独立预期',actual:result.independent.semantics,paths:[],
    allowed_changes:['核对确认来源与未明确规则，保留争议；不得让实现者修改冻结输入、断言或新增需求'],next_tool:'read_production_context(independent-design)',next:'先澄清业务预期或覆盖争议，保留现有候选和案例；这不是已确认产品缺陷，不自动修产品迎合错误预期，也不自动重发B。'}
  const summary = result.summary, gui = result.core?.host_gui
  const failed = gui?.steps.find(step => !step.passed)
  const independent=result.independent&&'diagnostic'in result.independent?result.independent.diagnostic:undefined
  const assertion = failed?.actual && typeof failed.actual === 'object' ? (failed.actual as { assertion?: { expected?: unknown; actual?: unknown } }).assertion : undefined
  const adapter = /INDEPENDENT_ADAPTER|GUI_NATIVE_(?:PATH|SYNTAX|CASE|REPORT|ASSERTIONS|EVIDENCE|COVERAGE|INPUT|TEST_SOURCE|DEPENDENCY|PACKAGE|BOOTSTRAP)|GUI_EXISTING_EXPECTATIONS|EVIDENCE_(?:PATH|DIRECTORY)|(?:TimeoutError|strict mode violation|waiting for (?:locator|getBy))/.test(summary + JSON.stringify(failed?.actual ?? ''))
  const kind=gui?.failure_kind
  const explicitAssertion=assertion&&(assertion.expected!==undefined||assertion.actual!==undefined)
  const category:VerificationFailure['category'] = result.status === 'environment_blocked' ? 'environment'
    : kind==='runtime'?'product_assertion':kind==='bootstrap'?'test_adapter':kind==='incomplete'?'harness'
    : kind==='assertion'?(explicitAssertion?'product_assertion':'unknown')
    : adapter ? 'test_adapter' : result.status === 'failed' ? 'product_assertion' : 'harness'
  const release = error instanceof ReleaseIntegrityError ? error : undefined
  return { category, classification_basis:!kind?'legacy':kind==='runtime'?'host_runtime':explicitAssertion?'assertion':'unresolved', code: summary.match(/\b[A-Z][A-Z_]{4,}\b/)?.[0] ?? (category === 'product_assertion' ? 'PRODUCT_CHECK_FAILED' : 'VERIFICATION_INCOMPLETE'),
    step: independent?.id??failed?.id, expected: independent?.expected??assertion?.expected ?? '已确认需求、冻结的业务输入与预期、候选和依赖字节保持一致', actual: independent?.actual??assertion?.actual ?? failed?.actual ?? summary.slice(0, 4000),
    paths: release?.differences.map(item => item.path) ?? (error instanceof NativeTestContractError ? error.paths.slice(0, 24) : []),
    allowed_changes: category === 'unknown'?['先核对实际界面、进程和日志；原因尚未确定，不修改业务输入或断言'] : category === 'test_adapter' ? ['测试定位的静态字面量', '有界等待时间和导航等待选项；业务输入、目标页面和断言保持冻结'] : category === 'product_assertion' ? ['应用实现；不得降低已确认预期'] : ['宿主证据目录和执行环境；不得绕过完整性校验'],
    next_tool: category === 'unknown'?'inspect_app':category === 'environment' ? 'prepare_software_environment' : category === 'test_adapter' ? 'verify_app(script)' : 'verify_app',
    next: category==='unknown'?'根因尚未确定，先用inspect_app核对实际界面、进程及日志，再决定修复位置；不放宽预期或超时掩盖问题。':release ? '将测试输出写入上下文 evidenceDir；相对截图路径自动落入该目录。不要在成品增加验收痕迹清理逻辑。业务或依赖改变需重新生成候选并实测。' : category === 'test_adapter' ? '使用实际UI修正适配后重新verify_app(script)，宿主记录新适配版本；不得修改输入和断言。' : '查看具体失败证据，修复后重新验收。' }
}
