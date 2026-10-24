import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PrdBackplane } from '../model/prd-backplane'
import { readLaunchDeclaration } from '../desktop/launch-smoke'
import { runtimeInventory, fileDigest } from './release-store'

export interface ArtifactQualification { requested: 'local' | 'source' | 'portable' | 'installer';
  kind: 'source' | 'local_runtime' | 'portable_candidate' | 'installer_candidate'; status: 'passed' | 'unverified' | 'environment_blocked';
  manifest_digest?: string; clean_environment: 'unverified'; detail: string }
export async function qualifySoftwareArtifact(root: string, brief: PrdBackplane, signal?: AbortSignal): Promise<ArtifactQualification> {
  const requested = brief.lean_brief?.distribution ?? 'local', launch = readLaunchDeclaration(root)
  const result: ArtifactQualification = { requested, kind: requested === 'source' ? 'source' : 'local_runtime', status: 'passed', clean_environment: 'unverified',
    detail: requested === 'source' ? '源码移交；运行环境和独立安装未验证。' : '本机正常入口验证；依赖本机运行环境，未证明可跨机器使用。' }
  if (!launch?.ok) return { ...result, status: 'unverified', detail: '缺少有效实际运行入口。' }
  const artifact = launch.launch.artifact
  if (artifact) {
    const file = resolve(root, artifact)
    if (!existsSync(file)) return { ...result, status: 'unverified', detail: '声明的打包产物不存在；源码不能代替成品。' }
    const rel = relative(realpathSync(root), realpathSync(file))
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(file).isFile()) return { ...result, status: 'unverified', detail: '打包产物越出项目目录或不是实际文件。' }
    result.manifest_digest = await fileDigest(file, signal)
    const actual = resolve(root, launch.launch.command[0])
    if (/\.(?:exe|appimage)$/i.test(artifact) && actual === file) result.kind = 'portable_candidate'
    else if (requested === 'installer' && /\.(?:exe|msi)$/i.test(artifact)) result.kind = 'installer_candidate'
  }
  if (requested === 'portable' || requested === 'installer') {
    if (result.kind !== (requested === 'portable' ? 'portable_candidate' : 'installer_candidate')) {
      result.status = 'unverified'; result.detail = '尚未提供与承诺相符的实际成品和运行入口。先完成打包，不能把源码包或本机依赖程序当作独立成品。'
    } else {
      result.status = 'environment_blocked'; result.detail = '成品已登记，本机行为单独验证；当前没有干净机器/虚拟环境的实际安装和运行证据，独立交付尚未完成。'
    }
  }
  // Candidate dependency links are host-owned release inputs, validated by the
  // release store. A stand-alone qualification never accepts arbitrary links.
  try { result.manifest_digest = (await runtimeInventory(root, signal)).digest }
  catch { /* release-store supplies the complete bound manifest for candidates */ }
  return result
}
export const SOFTWARE_DELIVERY_GUIDANCE = '本机使用、源码包、便携包、安装包分别报告。LAUNCH.artifact指向项目内实际成品文件，command指向实际使用入口；打包后以成品入口复验，不再用开发服务替代。本机启动通过不能证明另一台电脑可运行；便携/安装交付还需真实干净环境，缺失时保留本机试用版本并标注独立交付未完成。不得自写PASS凭据冒充新机器验证。'
