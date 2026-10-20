/** Stored legacy report types and the old Web preview entry check.
 * Current desktop verification uses CORE_CHECK and verification-fingerprint.
 * Historical documents remain readable through the document service. */
export interface GwtFailureSummary {
  scenario: string
  reason: string
  /**
   * 失败归类（2026-09-26 照抄批·对方 AC L-001 回炉分流）：product=产品类（进修复轮）；
   * precondition=前置缺失（不可自动验证——不烧修复预算）；selector=映射类（找不到控件，
   * 失败原因带控件清单可修——修复轮处理）。缺省（存量/静态兜底路径）按 product 对待。
   * mapping=编译器无法构造可靠步骤（删除/撤销族、未实现 op）——测试侧能力缺口，
   * 不烧预算不放行（审计修复批补全）。缺省（存量/静态兑底路径）按 product 对待。
   */
  kind?: 'product' | 'precondition' | 'selector' | 'mapping'
}

export interface GwtTestResult {
  total_count: number
  passed_count: number
  failed_count: number
  failure_summary: GwtFailureSummary[]
  /**
   * 待评估断言（§8.1）：行为断言解析出了效果词表但产物未现关键词（可能走
   * SVG/canvas/@keyframes 等不落关键词的合法实现）→ 静态模式无法判定，不计失败，
   * 由行为脚本/LLM 裁判兜底。信息性字段，裁判不作硬约束依据。
   */
  unverified?: string[]
  /**
   * 产物入口聚合指纹（2026-09-25 挂账②，对方 entryFingerprint 直译——多文件聚合口径）：
   * index.html + src/** 递归 + dist/app.js 逐文件 sha256 组合。报告落盘时计算；
   * 仅保留历史报告的数据字段；当前桌面证据使用独立的源码与环境指纹。
   */
  entry_fingerprint?: EntryFingerprint
  /**
   * 探针降级标记（2026-09-25 对齐批·环境豁免）：true = 浏览器探针不可用，结果是
   * 静态启发式兜底判定——失败不可归因产物缺陷（静态口径的假红/待评估），
   * 修复轮据此不烧预算（对齐 Proma-Easy「环境类不入修复循环」铁律）。
   */
  probe_degraded?: boolean
}

export interface EntryFingerprint {
  /** 关键产物文件内容的组合 sha256（hex） */
  sha256: string
  /** 关键产物文件总字节数 */
  size: number
  /** 参与指纹的文件数 */
  files: number
}

export interface RunGwtInput {
  project_id: string
  session_id: string
  preview_url?: string
}

export function hasInteractiveEntry(html: string, appJs: string): boolean {
  if (!html || !appJs) return false
  const hasControl = /<(button|input|select|textarea|a|form)\b/i.test(html)
  const hasLogic = /\b(addEventListener|onclick|oninput|onchange|onsubmit|function)\b/i.test(appJs)
  return hasControl && hasLogic
}
