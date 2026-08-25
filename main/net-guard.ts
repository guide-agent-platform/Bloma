/**
 * 网络出口共享防护（net-guard）
 *
 * web_fetch 工具（agent-tools）与向导市调（guide-research）共用的 SSRF 防护与
 * HTML 文本提取：单一实现，两侧行为同变。常量亦在此单点维护。
 *
 * v1 静态判定的已知边界（明示，不静默）：不做 DNS 解析复核（DNS rebinding 不防），
 * 桌面端模型半信任场景下够用；如未来接入不可信内容源须升级为解析后复核。
 */

/** 单次抓取超时 / 响应体上限 / 返回文本缺省与硬上限（ACI 截断契约）。 */
export const NET_FETCH_TIMEOUT_MS = 15_000
export const NET_FETCH_MAX_BYTES = 2 * 1024 * 1024
export const NET_FETCH_DEFAULT_CHARS = 12_000
export const NET_FETCH_MAX_CHARS_LIMIT = 50_000

/**
 * 抓取目标校验（SSRF 防护，v1 静态判定）：
 * - 只允许 http/https；
 * - 拒绝 localhost/.local/.internal 与私网/环回/链路本地/保留段 IP 字面量；
 * - 拒绝无点主机名（公网域名必含点，同时挡掉十/十六进制 IP 编码与内网单标签名）。
 */
export function assertPublicHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: `URL 无效：${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `只允许 http/https 地址（收到 ${url.protocol}）。` }
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host.includes('.') && !host.includes(':')) {
    return { ok: false, error: `非常规主机名不允许抓取（${url.hostname}）；请使用完整公网域名。` }
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: `内网/本机地址不允许抓取（${url.hostname}）。` }
  }
  if (isDisallowedIpLiteral(host)) {
    return { ok: false, error: `内网/保留地址不允许抓取（${url.hostname}）。` }
  }
  return { ok: true, url }
}

/** 私网/环回/链路本地/保留段 IP 字面量判定（IPv4 段式 + IPv6 前缀式）。 */
export function isDisallowedIpLiteral(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a >= 224) return true // 组播/保留段
    return false
  }
  if (host.includes(':')) {
    const lower = host.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(lower)) return true // fe80::/10 链路本地
  }
  return false
}

/** HTML → 纯文本粗提取（零依赖）：去脚本/样式/注释 → 块级标签换行 → 剥标签 → 解码基本实体。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|nav|aside|main|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    // 行内格式标签（b/i/em/strong/code/span…）直接剥除不加空格：中文无词间空格语义，
    // 「流行的<b>记账</b>应用」不能变成「流行的 记账 应用」
    .replace(/<\/?(?:b|i|em|strong|code|span|small|sub|sup|u|s|mark|abbr|time)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}
