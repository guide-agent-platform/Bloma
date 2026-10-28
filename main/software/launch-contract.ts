import type { PrdBackplane } from '../model/prd-backplane'
import type { LaunchDeclaration } from '../desktop/launch-smoke'

export function assertSoftwareDelivery(brief: PrdBackplane, launch: LaunchDeclaration) {
  const target = brief.lean_brief?.delivery ?? (brief.lean_brief?.ui === 'none' ? 'command' : 'desktop')
  const actual = launch.ui === 'browser' ? 'browser' : launch.mode === 'command' ? 'command' : 'desktop'
  if (target !== actual) throw Error(`SOFTWARE_DELIVERY_TARGET_MISMATCH: 已确认${target}，实际入口${actual}；修正正常入口即可继续，改变使用方式才需用户确认。`)
}
