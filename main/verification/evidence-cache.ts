/**
 * W6-D6（咨询 D2 §四《验证分层与收口预检》成本控制）：静态证据按候选指纹缓存。
 *
 * 缓存键 = 产物指纹（全量产物文件的 path+mtime+size 确定性聚合，宿主可算、不依赖
 * loop 读取集）；「任何代码修改形成新候选并使相关旧证据失效」由指纹变化结构性保证。
 * 只缓存确定性静态检查（v0=安全扫描——纯函数同输入同输出）；行为类（GWT/API 契约）
 * 终验一律独立重跑，不进缓存（D2：环境敏感结果原则上独立重跑）。
 *
 * 进程内 Map（终验与预检同进程共享；键含 projectId 防跨项目串）；BLOMA_EVIDENCE_CACHE
 * 缺省 off=两处消费点直通现状（零行为差异）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 可写产物扩展（与工具路径白名单同口径） */
const ARTIFACT_EXTENSIONS = new Set(['.html', '.js', '.css'])

export function evidenceCacheEnabled(): boolean {
  return process.env.BLOMA_EVIDENCE_CACHE === '1' || process.env.BLOMA_EVIDENCE_CACHE === 'true'
}

/** 产物指纹：walk 产物目录聚合 path+mtime+size（fnv1a；与 candidateFingerprintOf 独立口径）。 */
export function computeArtifactFingerprint(rootPath: string): string {
  const basis: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${rel}/`)
      } else if (ARTIFACT_EXTENSIONS.has(extOf(entry.name))) {
        try {
          const st = statSync(join(dir, entry.name))
          basis.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`)
        } catch {
          basis.push(`${rel}:unreadable`)
        }
      }
    }
  }
  walk(rootPath, '')
  const text = basis.join('\n')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `art-${hash.toString(16).padStart(8, '0')}-${basis.length}`
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

interface CacheEntry {
  fingerprint: string
  value: unknown
  at: number
}

const cache = new Map<string, CacheEntry>()

/** 读取缓存的静态证据：开关关/键不匹配/无记录返回 undefined（消费点直通执行）。 */
export function getCachedStaticEvidence<T>(projectId: string, rootPath: string, kind: string): T | undefined {
  if (!evidenceCacheEnabled()) return undefined
  const entry = cache.get(`${projectId}::${kind}`)
  if (!entry) return undefined
  return entry.fingerprint === computeArtifactFingerprint(rootPath) ? (entry.value as T) : undefined
}

/** 写入静态证据（任何调用方执行完真扫描后登记；指纹在写入时点计算）。 */
export function setCachedStaticEvidence(projectId: string, rootPath: string, kind: string, value: unknown): void {
  if (!evidenceCacheEnabled()) return
  cache.set(`${projectId}::${kind}`, { fingerprint: computeArtifactFingerprint(rootPath), value, at: Date.now() })
}

/** 测试隔离：清空缓存。 */
export function clearEvidenceCacheForTests(): void {
  cache.clear()
}
