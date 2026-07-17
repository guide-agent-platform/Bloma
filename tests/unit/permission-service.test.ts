import { describe, expect, it } from 'vitest'
import { canUseTool } from '../../main/permission-service'

describe('PermissionService', () => {
  it('allows read-only tools without UI confirmation', async () => {
    await expect(canUseTool('Read', { file_path: 'README.md' }, 's1', 'ask')).resolves.toEqual({ behavior: 'allow' })
  })

  it('denies write tools in safe mode', async () => {
    await expect(canUseTool('Write', { file_path: 'app.ts' }, 's1', 'safe')).resolves.toEqual({ behavior: 'deny' })
  })
})
