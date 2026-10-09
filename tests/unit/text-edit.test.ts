import { describe, expect, it } from 'vitest'
import { replaceUniqueText } from '../../main/agent/tools/text-edit'

describe('newline-compatible exact editing', () => {
  it('LF edits a CRLF block without changing surrounding bytes or file endings', () => {
    expect(replaceUniqueText('keep\r\nfirst\r\nsecond\r\nend\n', 'first\nsecond', 'new\nblock')).toEqual({
      ok: true, content: 'keep\r\nnew\r\nblock\r\nend\n',
    })
  })
  it('CRLF input edits an LF file', () => {
    expect(replaceUniqueText('a\nb\nc', 'a\r\nb', 'x\r\ny')).toEqual({ ok: true, content: 'x\ny\nc' })
  })
  it('rejects ambiguous newline-equivalent blocks', () => {
    expect(replaceUniqueText('a\r\nb\na\r\nb', 'a\nb', 'x')).toEqual({ ok: false, matches: 2 })
  })
  it('does not relax indentation, quotes, regex metacharacters or empty anchors', () => {
    expect(replaceUniqueText('a\r\n  b', 'a\n b', 'x')).toEqual({ ok: false, matches: 0 })
    expect(replaceUniqueText('a.b\r\nc', 'a+b\nc', 'x')).toEqual({ ok: false, matches: 0 })
    expect(replaceUniqueText('abc', '', 'x')).toEqual({ ok: false, matches: 0 })
  })
  it('a single-line replacement adopts CRLF without introducing mixed newlines', () => {
    expect(replaceUniqueText('header\r\nold\r\n', 'old', 'a\nb')).toEqual({ ok: true, content: 'header\r\na\r\nb\r\n' })
  })
})
