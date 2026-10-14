import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { DispatchExperiment } from './dispatch-experiment'
export function experimentInputsIntact(config: DispatchExperiment): boolean {
  return Object.entries(config.protected_inputs ?? {}).every(([path, hash]) => {
    const full = join(getPromaHome(), path)
    return existsSync(full) && createHash('sha256').update(readFileSync(full)).digest('hex') === hash
  })
}
