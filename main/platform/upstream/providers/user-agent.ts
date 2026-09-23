/**
 * Proma User-Agent（照抄 Proma 上游 packages/core/src/providers/user-agent.ts @ bf3e98c）。
 *
 * Kimi Coding Plan 等服务端做 UA 白名单校验，必须使用自有 UA 标识。
 */

const PROMA_REPO_URL = 'https://github.com/ErlichLiu/Proma'

let _promaVersion = '0.0.0'

export function setPromaVersion(version: string): void {
  _promaVersion = version
}

export function getPromaVersion(): string {
  return _promaVersion
}

export function getPromaUserAgent(version?: string): string {
  const v = version ?? _promaVersion
  return `Proma/${v} (+${PROMA_REPO_URL})`
}
