/**
 * think-splitter 单测（2026-09-11 交付话术改造）：
 * 流式 <think> 拆块——语义对齐 Proma session-core thinking-tags
 * （未闭合按思考处理、闭合后拆出正文、大小写不敏感），差异是流式状态机
 * （标签可能被增量切断）。
 */
import { describe, expect, it } from 'vitest'
import { createThinkStreamSplitter } from '../../main/coding/think-splitter'

const join = (r: { narration: string[]; thinking: string[] }): { narration: string; thinking: string } => ({
  narration: r.narration.join(''),
  thinking: r.thinking.join(''),
})

describe('createThinkStreamSplitter', () => {
  it('无标签文本原样透传为旁白', () => {
    const s = createThinkStreamSplitter()
    expect(join(s.push('你好，世界。'))).toEqual({ narration: '你好，世界。', thinking: '' })
    expect(join(s.end())).toEqual({ narration: '', thinking: '' })
  })

  it('完整 <think> 标签：思考与旁白分离', () => {
    const s = createThinkStreamSplitter()
    const r = join(s.push('<think>先分析需求</think>好的，开始实现。'))
    expect(r.thinking).toBe('先分析需求')
    expect(r.narration).toBe('好的，开始实现。')
  })

  it('未闭合 <think>：剩余全部按思考处理（end 冲收）', () => {
    const s = createThinkStreamSplitter()
    expect(join(s.push('正文 A<think>思考中'))).toEqual({ narration: '正文 A', thinking: '思考中' })
    expect(join(s.end())).toEqual({ narration: '', thinking: '' })
  })

  it('闭合后恢复正常旁白（可多次切换）', () => {
    const s = createThinkStreamSplitter()
    const r1 = join(s.push('<think>a</think>x'))
    const r2 = join(s.push('<think>b</think>y'))
    expect(r1).toEqual({ narration: 'x', thinking: 'a' })
    expect(r2).toEqual({ narration: 'y', thinking: 'b' })
  })

  it('标签被增量切断：跨增量缓冲不误判', () => {
    const s = createThinkStreamSplitter()
    // '<thi' + 'nk>' 跨两个增量；尾部扣住的部分在下一次 push 后归还
    const r1 = join(s.push('前缀<thi'))
    const r2 = join(s.push('nk>思考内容</th'))
    const r3 = join(s.push('ink>后缀'))
    expect(r1.narration).toBe('前缀')
    expect(r1.thinking).toBe('')
    expect(r2.thinking).toBe('思考内容')
    expect(r3.narration).toBe('后缀')
  })

  it('大小写不敏感（对齐 Proma 语义）', () => {
    const s = createThinkStreamSplitter()
    const r = join(s.push('<THINK>大写</THINK>正文'))
    expect(r.thinking).toBe('大写')
    expect(r.narration).toBe('正文')
  })

  it('空增量安全', () => {
    const s = createThinkStreamSplitter()
    expect(join(s.push(''))).toEqual({ narration: '', thinking: '' })
  })
})
