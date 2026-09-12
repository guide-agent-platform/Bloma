import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  USAGE_FILE,
  flushMemoryUsage,
  forgetMemoryUsage,
  getLastUsedAt,
  loadMemoryUsage,
  recordMemoryUsage,
  resetMemoryUsageForTests,
} from '../../main/memory-usage'
import { REVOCATION_FILE, getRevocationIndexPath } from '../../main/memory-revocation'
import { restorePromaHome } from '../support/proma-home-guard'

/**
 * 记忆使用埋点 sidecar（2026-09-12 记忆栈审计裁定 S-2）。
 *
 * 锁定行为：
 * - **只存指纹，不存原文**（sidecar 不得成为第二份记忆副本）；
 * - 与撤销名单**分文件**（高频写不得放大安全机制的损坏概率）；
 * - 防抖落盘（record 后不立即写，flush 才落盘）；
 * - **fail-open**：损坏/丢失只影响 UI 显示，不影响注入与生成；
 * - 删除范围：forgetMemoryUsage 清理对应条目。
 */

describe('memory-usage（S-2 使用埋点 sidecar）', () => {
  let home: string
  let path: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bloma-usage-'))
    process.env.PROMA_HOME = home
    path = join(home, USAGE_FILE)
    resetMemoryUsageForTests()
  })

  afterEach(() => {
    resetMemoryUsageForTests()
    restorePromaHome(process.env.PROMA_HOME)
  })

  it('缺失 = 空记录且 readable（不误判为损坏）', () => {
    const index = loadMemoryUsage(path)
    expect(index.readable).toBe(true)
    expect(index.entries.size).toBe(0)
  })

  it('record + flush 落盘：含指纹/次数/最后使用时间，且**不存原文**', () => {
    recordMemoryUsage(['用户偏好：界面简单点'], 1_700_000_000_000)
    expect(flushMemoryUsage(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('界面简单点') // 只存指纹
    expect(raw).toContain('last_used_at')
    const index = loadMemoryUsage(path)
    expect(index.entries.size).toBe(1)
    const [, entry] = [...index.entries][0]
    expect(entry.count).toBe(1)
    expect(entry.last_used_at).toBe(1_700_000_000_000)
  })

  it('防抖：record 后未 flush 不落盘；flush 后落盘', () => {
    recordMemoryUsage(['防抖验证'], 1_700_000_000_000)
    expect(existsSync(path)).toBe(false)
    expect(flushMemoryUsage(path)).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('累计计数：同一条多次注入 count 递增，last_used_at 取最新', () => {
    recordMemoryUsage(['重复注入的经验'], 1_700_000_000_000)
    recordMemoryUsage(['重复注入的经验'], 1_700_000_009_000)
    flushMemoryUsage(path)
    const index = loadMemoryUsage(path)
    const [, entry] = [...index.entries][0]
    expect(entry.count).toBe(2)
    expect(entry.last_used_at).toBe(1_700_000_009_000)
  })

  it('forget：删除后条目消失（进删除范围）', () => {
    recordMemoryUsage(['待删除的经验'])
    flushMemoryUsage(path)
    expect(getLastUsedAt('待删除的经验', path)).toBeTypeOf('number')

    forgetMemoryUsage(['待删除的经验'], path)
    expect(getLastUsedAt('待删除的经验', path)).toBeUndefined()
    expect(loadMemoryUsage(path).entries.size).toBe(0)
  })

  it('损坏文件 = readable false，但仍可写入重建（fail-open，不影响注入）', () => {
    writeFileSync(path, '{ 损坏 JSON', 'utf8')
    expect(loadMemoryUsage(path).readable).toBe(false)

    recordMemoryUsage(['重建后的条目'])
    expect(flushMemoryUsage(path)).toBe(true)
    expect(loadMemoryUsage(path).readable).toBe(true)
    expect(getLastUsedAt('重建后的条目', path)).toBeTypeOf('number')
  })

  it('与撤销名单分文件（路径不同，互不覆盖）', () => {
    expect(USAGE_FILE).not.toBe(REVOCATION_FILE)
    expect(getRevocationIndexPath()).not.toBe(join(home, USAGE_FILE))
  })
})
