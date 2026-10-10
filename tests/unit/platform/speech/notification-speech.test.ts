import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speakNotification } from '../../../../main/platform/speech/notification-speech'
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
let child: EventEmitter & { stdin: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  spawn.mockReset().mockReturnValue(child)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('本地中文通知播报', () => {
  it('拒绝空文本、超长文本、非文本与非法音量，不创建进程', () => {
    for (const text of ['', '  ', '字'.repeat(301), {}, null]) expect(() => speakNotification(text, 0.5)).toThrow('VALIDATION_ERROR')
    for (const volume of [-1, 2, NaN, Infinity, '0.5']) expect(() => speakNotification('你好', volume)).toThrow('VALIDATION_ERROR')
    expect(spawn).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'win32')('文本通过 JSON stdin，命令为固定脚本，中文与特殊字符不进入命令', async () => {
    const text = '你好"; $(Write-Output danger) \n再见'
    const result = speakNotification(text, 0.55)
    const [binary, args, options] = spawn.mock.calls[0]
    expect(binary).toBe('powershell.exe')
    expect(options.windowsHide).toBe(true)
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    expect(script).toContain('ConvertFrom-Json')
    expect(script).not.toContain('danger')
    expect(JSON.parse(child.stdin.read().toString())).toEqual({ text, volume: 55 })
    child.emit('close', 0)
    await expect(result).resolves.toEqual({ spoken: true })
  })
  it.runIf(process.platform === 'win32')('进程无法启动与缺少中文嗓音都返回原因', async () => {
    const result = speakNotification('你好', 0.5)
    child.emit('error', new Error('ENOENT'))
    await expect(result).rejects.toThrow('无法启动')
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    spawn.mockReturnValue(child)
    const missing = speakNotification('你好', 0.5)
    child.stderr.write('未安装 Windows 中文嗓音')
    child.emit('close', 1)
    await expect(missing).rejects.toThrow('未安装 Windows 中文嗓音')
  })
  it.runIf(process.platform === 'win32')('卡住的播报进程在 30 秒终止', async () => {
    vi.useFakeTimers()
    const result = speakNotification('你好', 0.5)
    const rejected = expect(result).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(child.kill).toHaveBeenCalled()
  })
})
