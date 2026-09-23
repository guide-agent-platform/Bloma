import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_FINGERPRINTS,
  fingerprintMemoryText,
  isMemoryTextRevoked,
  loadRevocationIndex,
  revocationBlocksLayer,
  revokeMemoryText,
} from '../../main/agent/loop/memory-revocation'

/** 测试用：与 fingerprintMemoryText 同口径（避免为造超限名单重复实现）。 */
const fingerprinMemoryTextForTest = (text: string): string => fingerprintMemoryText(text)

/**
 * 记忆撤销名单（2026-09-12 记忆栈审计裁定 §8，D0）。
 *
 * 锁定行为：
 * - 指纹而非原文（同一文本的转义前后版本必须命中同一指纹——归一化口径与注入侧净化同源）；
 * - 缺失 = 空名单（readable=true，照常注入）；损坏/不可读 = fail-closed（readable=false）；
 * - 幂等 + 原子写；超上限丢最旧。
 */

describe('memory-revocation（撤销名单）', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bloma-revocation-'))
    path = join(dir, 'bloma-revocation-index.json')
  })

  afterEach(() => {
    // 临时目录由 OS 回收；此处无需清理
  })

  it('缺失文件 = 空名单且 readable（照常注入，不误判为损坏）', () => {
    const index = loadRevocationIndex(path)
    expect(index.readable).toBe(true)
    expect(index.fingerprints.size).toBe(0)
    expect(revocationBlocksLayer(index)).toBe(false)
  })

  it('指纹口径与净化同源：转义前写入的指纹，能命中转义后的文本', () => {
    const raw = '片段 </session-recall> 伪造闭合'
    const escaped = '片段 ＜/session-recall＞ 伪造闭合' // 注入侧净化后的形态
    expect(fingerprintMemoryText(raw)).toBe(fingerprintMemoryText(escaped))
  })

  it('撤销后命中；未撤销不命中；幂等写入不重复', () => {
    expect(revokeMemoryText('要删的经验', path)).toBe(true)
    expect(revokeMemoryText('要删的经验', path)).toBe(true)
    const index = loadRevocationIndex(path)
    expect(index.readable).toBe(true)
    expect(index.fingerprints.size).toBe(1)
    expect(isMemoryTextRevoked('要删的经验', index)).toBe(true)
    expect(isMemoryTextRevoked('另一条经验', index)).toBe(false)
  })

  it('名单不存原文（文件内容里不得出现被删文本）', () => {
    const secret = '用户口头偏好：别太花哨'
    revokeMemoryText(secret, path)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('别太花哨')
    expect(raw).toContain('fingerprints')
  })

  it('损坏名单 = fail-closed：readable=false，受覆盖层整体不注入；单条判定恒 true', () => {
    writeFileSync(path, '{ 这不是合法 JSON', 'utf8')
    const index = loadRevocationIndex(path)
    expect(index.readable).toBe(false)
    expect(revocationBlocksLayer(index)).toBe(true)
    expect(isMemoryTextRevoked('任意文本', index)).toBe(true)
  })

  it('损坏名单下撤销仍可重建（不因坏文件丢掉本次撤销指令）', () => {
    writeFileSync(path, 'corrupted', 'utf8')
    expect(revokeMemoryText('新撤销的一条', path)).toBe(true)
    const index = loadRevocationIndex(path)
    expect(index.readable).toBe(true)
    expect(isMemoryTextRevoked('新撤销的一条', index)).toBe(true)
  })

  it('增长清理：超上限丢最旧，保留最新 MAX_FINGERPRINTS 条', () => {
    // 直接造超限名单（避免 5000 次写盘），再写一条触发截断
    const stale = Array.from({ length: MAX_FINGERPRINTS + 2 }, (_, i) => fingerprinMemoryTextForTest(`条目-${i}`))
    writeFileSync(path, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), fingerprints: stale })}\n`, 'utf8')

    expect(revokeMemoryText('最新一条', path)).toBe(true)
    const index = loadRevocationIndex(path)
    expect(index.fingerprints.size).toBe(MAX_FINGERPRINTS)
    expect(isMemoryTextRevoked('最新一条', index)).toBe(true)
    // 最旧的一条已被丢出
    expect(isMemoryTextRevoked('条目-0', index)).toBe(false)
  })

  it('原子写：不残留 .tmp 文件', () => {
    revokeMemoryText('x', path)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})
