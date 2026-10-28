import { StringDecoder } from 'node:string_decoder'

export interface ProcessOutput { seq: number; stream: 'stdout' | 'stderr'; text: string }
/** Publish complete logical lines so credentials split across pipe chunks are
 * redacted together. Bounds apply to retained output, never an OS sandbox. */
export function createProcessOutput(redact: (text: string) => string) {
  let seq = 0, bytes = 0
  const output: ProcessOutput[] = [], pending = { stdout: '', stderr: '' }
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const append = (stream: ProcessOutput['stream'], text: string) => {
    if (!text) return
    const record = { seq: ++seq, stream, text: redact(text).slice(-16000) }
    output.push(record); bytes += record.text.length
    while (output.length > 256 || bytes > 32768) bytes -= output.shift()!.text.length
  }
  return {
    push(stream: ProcessOutput['stream'], chunk: Buffer) {
      pending[stream] += decoders[stream].write(chunk)
      const lines = pending[stream].split(/(?<=\n)|(?<=\r)/)
      pending[stream] = /[\r\n]$/.test(lines.at(-1) ?? '') ? '' : lines.pop() ?? ''
      for (const line of lines) append(stream, line)
      // Keep unfinished giant records private until a delimiter/exit; don't
      // emit fragments that could expose a split credential.
      if (pending[stream].length > 65536) pending[stream] = '[long line truncated] ' + pending[stream].slice(-32768)
    },
    flush() { for (const stream of ['stdout', 'stderr'] as const) { append(stream, pending[stream] + decoders[stream].end()); pending[stream] = '' } },
    snapshot() { return { output_seq: seq, output: output.map(line => ({ ...line })) } },
  }
}
