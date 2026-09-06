/** 缺口报告纯函数的类型声明（供 vitest 直测；实现见同目录 .mjs，先例 calibrate-loop-params.d.mts）。 */

export interface GapEntry {
  kind: 'official_capability_without_pattern' | 'error_tag_without_pattern'
  capability: string
  related_templates: string[]
  suggested_queries: string[]
}

export interface GapReport {
  generated_at: string
  root: string
  verified_patterns: number
  consumable_anti_tags: number
  total_gaps: number
  gaps: GapEntry[]
}

export declare function normalizeCap(text: unknown): string
export declare function loadOfficialModules(modulesDir: string): { slug: string; name: string; categories: string[]; summary: string }[]
export declare function loadLedgerView(ledgerPath: string): Map<string, Record<string, unknown>>
export declare function buildGapReport(opts: { root?: string; modulesDir?: string }): GapReport
