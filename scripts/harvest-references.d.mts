/** G2 批跑脚本纯函数类型声明（测试直测用；实现见同目录 .mjs）。 */
export interface HarvestDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T: any
  root: string
  dryRun: boolean
  search: (query: string) => Promise<Array<{ url: string; title?: string }>>
  fetchHtml: (url: string) => Promise<string>
  llm: (prompt: string) => Promise<string>
  sandbox: (refined: unknown, code: string) => Promise<{ build_pass: boolean; smoke_test_pass?: boolean; executed_at: number; error?: string }>
}
export interface HarvestResult {
  verdict: string
  reason?: string
  capability?: string
  tag?: string
  license_tier?: string
  build_pass?: boolean
  sandbox_error?: string
  sourceUrl?: string
}
export declare function harvestGap(gap: { capability: string; suggested_queries?: string[] }, deps: HarvestDeps, opts?: Record<string, unknown>): Promise<HarvestResult>
export declare function extractPatternText(html: string): string
export declare function makeCompileSandbox(repoRoot: string, T: HarvestDeps['T']): (refined: unknown, code: string) => Promise<{ build_pass: boolean; smoke_test_pass?: boolean; executed_at: number; error?: string }>
export declare const REFINE_PROMPT: string
