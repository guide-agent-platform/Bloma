/**
 * 产物 CSP 单一真相源（完整程序 Wave 1，2026-09-12）。
 *
 * 两处同构引用：main/platform-services.ts（沙箱内嵌 STATIC_SERVER_SCRIPT）与
 * main/coding/project-scaffold.ts（renderStaticServer 产物模板）。
 * 此前两处各自硬编码同一字符串，靠纪律同步；现在统一 import 本常量，
 * 由 tests/unit/product-csp.test.ts 锁「两处引用 + 字段齐全」，改 CSP 只改这里。
 *
 * 字段语义：
 * - media-src 'self' blob: —— 本地媒体播放（URL.createObjectURL 产物 blob、
 *   MediaRecorder 录音回放）此前回落 default-src 'self' 被拦（2026-09-12 B 站
 *   播放器案实测：blob 视频源全灭）。外链媒体仍被拦——外部流必须走产物服务端
 *   同源代理（CSP + Referer 防盗链双重原因），见 loop【媒体纪律】契约。
 */
export const PRODUCT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
].join('; ')
