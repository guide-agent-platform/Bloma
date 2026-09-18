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

/** B1（P0-B，2026-09-11 审计案 35c1a633）：挂载错误回流开关——契约端点失活时先取
 *  /_bloma/routes 健康端点，把真实 require 报错写进失败 reason（进修复任务 payload）。
 * 缺省 off=字节级现状（reason 维持猜测式措辞）；不改变判定语义（404/5xx 仍判失败）。 */
export function routeErrorFeedbackEnabled(): boolean {
  return process.env.BLOMA_ROUTE_ERROR_FEEDBACK === '1' || process.env.BLOMA_ROUTE_ERROR_FEEDBACK === 'true'
}

interface RouteMountError {
  file: string
  message: string
}

interface RouteMountInfo {
  mounted: string[]
  errors: RouteMountError[]
}

/** 取健康端点的挂载状态（mounted 清单 + 挂载失败清单）；端点缺席/不可达/形态异常 → null（静默降级，不动判定）。 */
async function fetchRouteHealth(previewUrl: string): Promise<RouteMountInfo | null> {
  try {
    const response = await fetch(`${previewUrl.replace(/\/+$/, '')}/_bloma/routes`, {
      signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { mounted?: unknown; errors?: unknown }
    if (!Array.isArray(body?.errors)) return null
    const errors = body.errors.filter(
      (item): item is RouteMountError =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { file?: unknown }).file === 'string' &&
        typeof (item as { message?: unknown }).message === 'string',
    )
    const mounted = Array.isArray(body?.mounted)
      ? body.mounted
          .filter(
            (item): item is { method: unknown; path: unknown } =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as { method?: unknown }).method === 'string' &&
              typeof (item as { path?: unknown }).path === 'string',
          )
          .map((item) => `${item.method} ${item.path}`)
      : []
    return { mounted, errors }
  } catch {
    return null
  }
}

/** B1 失败 reason 组装：精确匹配（endpoint 资源段 ↔ 挂载失败文件名）优先，否则附挂载失败摘要；
 *  无挂载报错但有 mounted 清单时附实际挂载路由与全路径提示（P0-3，2026-09-18 本月流水账案：
 *  模块加载成功但路由键写了全路径 'GET /api/records'，被文件名前缀拼成
 *  /api/records/api/records——旧 reason 只有猜测式措辞，模型六次盲调不可恢复）；
 *  无健康端点 → 维持现状措辞（与 off 路径同文）。 */
async function routeFailureReason(previewUrl: string, endpoint: string, status: number): Promise<string> {
  const base = `契约端点失活（HTTP ${status}，路由未实现或挂载失败）`
  const health = await fetchRouteHealth(previewUrl)
  if (!health) return base
  if (health.errors.length > 0) {
    const resource = endpoint.split('/').filter(Boolean)[1]
    const hit = resource ? health.errors.find((item) => item.file.replace(/\.js$/, '') === resource) : undefined
    if (hit) return `${base}；路由文件 ${hit.file} 挂载失败：${hit.message}`
    const digest = health.errors.slice(0, 3).map((item) => `${item.file}（${item.message}）`).join('、')
    return `${base}；挂载失败文件：${digest}`
  }
  if (health.mounted.length > 0) {
    const digest = health.mounted.slice(0, 6).join('、')
    return `${base}；服务器实际挂载的路由：${digest}——目标端点不在其中时，多为路由键写了全路径（键应写文件名前缀之后的相对路径，如 'GET /'，文件名已是 /api/ 前缀）`
  }
  return base
}

export async function checkApiContract(previewUrl: string, endpoints: InterfaceEndpoint[]): Promise<GwtFailureSummary[]> {
  const probeable = endpoints.filter((ep) => (ep.method ?? 'GET') === 'GET' && !ep.endpoint.includes(':'))
  const failures: GwtFailureSummary[] = []
  // 服务器可达性语义：首个探测若连接即失败（沙箱未起/测试环境无真实服务器），跳过
  // 整个契约检查——GWT 侧已处理服务器宕机口径，契约探测的前提是服务器在服务；
  // 一旦可达，后续单端点的失败（404/5xx/超时）才是真实的契约失活。
  let serverReachable = false
  for (const endpoint of probeable) {
    try {
      const response = await fetch(`${previewUrl.replace(/\/+$/, '')}${endpoint.endpoint}`, {
        signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
      })
      serverReachable = true
      if (response.status === 404 || response.status >= 500) {
        failures.push({
          scenario: `API 契约端点：${endpoint.method ?? 'GET'} ${endpoint.endpoint}`,
          reason: routeErrorFeedbackEnabled()
            ? await routeFailureReason(previewUrl, endpoint.endpoint, response.status)
            : `契约端点失活（HTTP ${response.status}，路由未实现或挂载失败）`,
        })
      }
    } catch (error) {
      if (!serverReachable && isConnectionError(error)) return []
      failures.push({
        scenario: `API 契约端点：${endpoint.method ?? 'GET'} ${endpoint.endpoint}`,
        reason: `契约端点探测失败（${error instanceof Error ? error.message : 'unknown'}）`,
      })
    }
  }
  return failures
}

/** 连接层错误（ECONNREFUSED/EHOSTUNREACH 等）：服务器不可达，与「可达但端点坏了」区分。 */
function isConnectionError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause?.code
  if (cause && /^(ECONN|EHOST|ENET|EAI_AGAIN)/.test(cause)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /fetch failed|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)
}
