import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, isDisallowedIpLiteral } from '../../main/net-guard'

/**
 * SSRF 防护专项（T-1 实测加固，2026-09-02 对抗审查）：
 * 此前 v1 静态判定对 IPv4-mapped IPv6、CGNAT 100.64/10、基准测试 198.18/15、
 * TEST-NET 文档段全放行——Node/undici 会按内嵌 IPv4 实际连接内网。
 * WHATWG URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1（十六进制形态），
 * 点分形态的字面量判定永远收不到——十六进制 mapped 必须单独拦。
 */
describe('net-guard SSRF（T-1：mapped IPv6/CGNAT/基准段/文档段）', () => {
  it('IPv4-mapped IPv6 剥壳判定：内网 mapped 拦、公网 mapped 放', () => {
    expect(isDisallowedIpLiteral('::ffff:127.0.0.1')).toBe(true)
    expect(isDisallowedIpLiteral('::ffff:10.0.0.1')).toBe(true)
    expect(isDisallowedIpLiteral('::ffff:169.254.169.254')).toBe(true) // 云元数据
    expect(isDisallowedIpLiteral('::127.0.0.1')).toBe(true) // IPv4-compatible
    expect(isDisallowedIpLiteral('::ffff:8.8.8.8')).toBe(false)
    expect(isDisallowedIpLiteral('2606:4700::1111')).toBe(false)
  })

  it('URL 级：规范化后的十六进制 mapped 同样拦截', () => {
    // new URL 把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]
    expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/x').ok).toBe(false)
    expect(assertPublicHttpUrl('http://[::ffff:169.254.169.254]/x').ok).toBe(false)
    expect(assertPublicHttpUrl('http://[::ffff:8.8.8.8]/x').ok).toBe(true)
  })

  it('CGNAT 100.64/10 与基准测试 198.18/15 拦截', () => {
    for (const host of ['100.64.1.1', '100.127.255.254', '198.18.0.1', '198.19.255.254']) {
      expect(isDisallowedIpLiteral(host), host).toBe(true)
      expect(assertPublicHttpUrl(`http://${host}/x`).ok, host).toBe(false)
    }
    expect(isDisallowedIpLiteral('100.128.0.1')).toBe(false) // /10 边界外放行
    expect(isDisallowedIpLiteral('100.63.255.254')).toBe(false)
  })

  it('TEST-NET 文档段（192.0.2/24、198.51.100/24、203.0.113/24）拦截', () => {
    for (const host of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '192.0.0.9']) {
      expect(isDisallowedIpLiteral(host), host).toBe(true)
    }
  })

  it('既有口径零回归：公网 IP/域名放行，原私网段仍拦', () => {
    for (const url of ['http://example.com/x', 'https://8.8.8.8/x', 'http://1.1.1.1/x']) {
      expect(assertPublicHttpUrl(url).ok, url).toBe(true)
    }
    for (const url of ['http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://[::1]/x', 'http://[fe80::1]/x', 'http://localhost/x']) {
      expect(assertPublicHttpUrl(url).ok, url).toBe(false)
    }
  })
})
