/**
 * API 契约存活检查（完整程序阶段 2，2026-09-06）。
 *
 * 背板 interface_spec 是前后端契约真相源（PRD 工程腿产出 → 随锚定注入 loop →
 * 编程 Agent 按它实现 server/routes）。本模块在终验侧把「契约里声明的端点」逐个
 * 探测：404（路由未实现/挂载失败）或 5xx（路由运行错误）计为契约失活。
 *
 * 探测范围：无参 GET 端点——带路径参数/写类端点无法无副作用探测，跳过（其行为
 * 由 GWT 场景与裁判覆盖）。失败以 GwtFailureSummary 形态返回，调用方并入测试结果，
 * 修复回流/熔断/让渡口径完全复用（修复轮按 location「API 契约端点：…」定向修路由）。
 */
import type { GwtFailureSummary } from '../gwt-service'
import type { InterfaceEndpoint } from '../model/prd-backplane'

/** 单端点探测超时：契约端点应答应当是本地毫秒级（基础设施超时口径，陷阱 16）。 */
const API_PROBE_TIMEOUT_MS = 2_000

export async function checkApiContract(previewUrl: string, endpoints: InterfaceEndpoint[]): Promise<GwtFailureSummary[]> {
  const probeable = endpoints.filter((ep) => (ep.method ?? 'GET') === 'GET' && !ep.endpoint.includes(':'))
  const failures: GwtFailureSummary[] = []
  for (const endpoint of probeable) {
    try {
      const response = await fetch(`${previewUrl.replace(/\/+$/, '')}${endpoint.endpoint}`, {
        signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
      })
      if (response.status === 404 || response.status >= 500) {
        failures.push({
          scenario: `API 契约端点：${endpoint.method ?? 'GET'} ${endpoint.endpoint}`,
          reason: `契约端点失活（HTTP ${response.status}，路由未实现或挂载失败）`,
        })
      }
    } catch (error) {
      failures.push({
        scenario: `API 契约端点：${endpoint.method ?? 'GET'} ${endpoint.endpoint}`,
        reason: `契约端点探测失败（${error instanceof Error ? error.message : 'unknown'}）`,
      })
    }
  }
  return failures
}
