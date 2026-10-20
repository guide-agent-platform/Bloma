/**
 * 用户文本意图词表测试（刀1，2026-10-02 确认协议与呈现层战役）。
 *
 * 核心回归锁：反义词优先（'不通过' 含子串 '通过' 的反向误置位事故防御）；
 * 英文词边界（'ok' 不命中 'skip'）；词表三态分类。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyUserDesktopIntent,
} from '../../../main/desktop/user-intent-lexicon'

describe('classifyUserDesktopIntent 词表三态', () => {
  it('停止词命中 → stop', () => {
    for (const text of ['先停一下', '不通过，重新做', '重做', '取消', 'stop it now', 'Cancel this']) {
      expect(classifyUserDesktopIntent(text)).toBe('stop')
    }
  })

  it('继续词命中（无反义干扰）→ continue', () => {
    for (const text of ['继续', '可以了', '没问题，推进', 'ok', 'OK, go on', '确认通过']) {
      expect(classifyUserDesktopIntent(text)).toBe('continue')
    }
  })

  it('普通文本 → none（不误触发）；高误伤日常词已删（脑测修复 4：长句含「先别/等等/不急」不再误停）', () => {
    for (const text of ['把按钮改成红色', '这个程序是干什么的', '帮我看看日志', '弹窗先别太多', '等等我看看再说', '不急你慢慢来', '']) {
      expect(classifyUserDesktopIntent(text)).toBe('none')
    }
  })
})

describe('反义词优先（实证防御——竞品裁决 A2 同款事故）', () => {
  it('「不通过/没通过」含子串「通过」仍判 stop', () => {
    expect(classifyUserDesktopIntent('不通过')).toBe('stop')
    expect(classifyUserDesktopIntent('没通过')).toBe('stop')
    expect(classifyUserDesktopIntent('测试没通过，需要修复')).toBe('stop')
  })

  it('「先别推进」含子串「推进」仍判 stop', () => {
    expect(classifyUserDesktopIntent('先别推进')).toBe('stop')
  })

  it('「不满意」含子串「满意」不判 continue（stop 词表收录「不满意」）', () => {
    expect(classifyUserDesktopIntent('不满意')).toBe('stop')
  })
})

describe('英文词边界与大小写', () => {
  it('纯 ASCII 词走 \\b 词边界：ok 不误命中 skip/tokenize', () => {
    expect(classifyUserDesktopIntent('skip this step')).toBe('none')
    expect(classifyUserDesktopIntent('tokenize the input')).toBe('none')
    expect(classifyUserDesktopIntent('ok')).toBe('continue')
    expect(classifyUserDesktopIntent('OK')).toBe('continue')
  })

  it('continue/resume/approve 大小写不敏感', () => {
    expect(classifyUserDesktopIntent('CONTINUE')).toBe('continue')
    expect(classifyUserDesktopIntent('please Resume')).toBe('continue')
    expect(classifyUserDesktopIntent('Approve it')).toBe('continue')
  })
})

describe('host commands versus product prose', () => {
  it('does not pause for product controls, quoted commands or negated stop requests', () => {
    for (const text of ['增加取消按钮', '任务执行时显示停止按钮', '请把停止按钮改红', '按钮文字叫“取消”', '不要停止', 'do not stop', 'add a cancel button']) {
      expect(classifyUserDesktopIntent(text), text).toBe('none')
    }
    expect(classifyUserDesktopIntent('不要停止，继续执行')).toBe('continue')
    expect(classifyUserDesktopIntent('请停止当前任务')).toBe('stop')
  })
})
