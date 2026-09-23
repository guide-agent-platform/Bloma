import { describe, expect, it } from 'vitest'
import { createDsmlDisplayFilter } from '../../../main/agent/loop/dsml-display-filter'

/**
 * R1-loop（2026-09-19 狗粮 7601e5ae）：DSML 协议残片呈现过滤器。
 * 狗粮 8 例实证形态：散文在前（可为空）、`<｜｜DSML｜｜ calls>` 开标记后整段协议
 * 残片收尾。锁四件事：正常文本直通；标记跨增量分裂不漏（holdback）；标记后整段
 * 抑制且占位至多一次；流结束冲出被扣的非标记前缀。
 */

const OPEN = '<｜｜DSML｜｜'
const SAMPLE = `${OPEN} calls>\n${OPEN} invoke name="write_file">\n</${OPEN} invoke>\n</${OPEN} calls>`

describe('R1-loop DSML 呈现过滤器', () => {
  it('正常文本原样直通（含含单个 < 的正常代码片段）', () => {
    const f = createDsmlDisplayFilter()
    expect(f.push('现在写入 server.js。')).toEqual(['现在写入 server.js。'])
    expect(f.push('const a = 1 < 2;\n')).toEqual(['const a = 1 < 2;\n'])
    expect(f.end()).toEqual([])
  })

  it('完整标记整段抑制 + 占位至多一次（狗粮 #496 形态：散文在前）', () => {
    const f = createDsmlDisplayFilter()
    const out = f.push(`Now I'll write the rebuilt bundle.\n\n${SAMPLE}`)
    expect(out[0]).toBe("Now I'll write the rebuilt bundle.\n\n")
    expect(out[1]).toContain('工具调用协议残片')
    // 后续任何增量全部抑制，不再重复占位
    expect(f.push('more')).toEqual([])
    expect(f.push(SAMPLE)).toEqual([])
    expect(f.end()).toEqual([])
  })

  it('标记跨增量分裂不漏（holdback：<、<｜、<｜｜…逐段到达）', () => {
    const f = createDsmlDisplayFilter()
    // 把「正文+标记头」切成任意 3 字符一段喂入：正文必须完整直通，标记头绝不外漏
    const raw = `旁白说明${OPEN} calls>x</${OPEN} calls>`
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += 3) chunks.push(raw.slice(i, i + 3))
    let display = ''
    for (const c of chunks) display += f.push(c).join('')
    display += f.end().join('')
    expect(display).toBe('旁白说明（检测到工具调用协议残片，已过滤；模型仍想调用工具——原文已留档，意图交由平台处置）')
    expect(display).not.toContain(OPEN)
  })

  it('疑似前缀最终不是标记 → 扣住尾部待裁决，确认非标记后放行（不吞正文）', () => {
    const f = createDsmlDisplayFilter()
    // '<｜' 是标记前缀：安全部分「比较 」即时放行，疑似尾部先扣住
    const out1 = f.push('比较 <｜')
    expect(out1).toEqual(['比较 '])
    const out2 = f.push(' 全角竖线不该被吞')
    expect(out2.join('')).toBe('<｜ 全角竖线不该被吞')
    expect(f.end()).toEqual([])
  })

  it('纯残片无散文（狗粮 #159 形态）：只出占位', () => {
    const f = createDsmlDisplayFilter()
    const out = f.push(SAMPLE)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('工具调用协议残片')
  })
})
