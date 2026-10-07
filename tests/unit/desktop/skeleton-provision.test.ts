/**
 * 骨架 v2 物化测试（批8 下半，2026-10-06）。
 *
 * 覆盖：复制清单/占位符渲染/契约 command 前缀改写/幂等（skip-existing 不覆盖子会话
 * 成果）/includeScaffold 开关/骨架源齐备（物化清单与骨架目录的真实对账——新增骨架
 * 文件未登记会 missing 暴露）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionDesktopSkeletonV2 } from '../../../main/desktop/skeleton-provision'

const ROOT_FILE_SET = [
  'app.py',
  'requirements.txt',
  'README.md',
  'ui/index.html',
  'ui/tokens.css',
  'ui/kit.css',
  'ui/bridge.js',
  'ui/correction.js',
  'ui/PATTERNS.md',
] as const

const SCAFFOLD_FILE_SET = ['00_SCAFFOLD/driver-skeleton.py', '00_SCAFFOLD/contract.json'] as const

describe('provisionDesktopSkeletonV2（骨架 v2 物化）', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // Windows 句柄占用容忍
      }
    }
  })

  it('完整物化：根文件 + 00_SCAFFOLD 契约件；占位符渲染；契约 driver.command 补目录前缀', () => {
    const root = mkdtempSync(join(tmpdir(), 'bloma-skel-provision-'))
    roots.push(root)
    const result = provisionDesktopSkeletonV2(root, '明星形象平台', { includeScaffold: true })
    expect([...result.missing, ...result.failed]).toEqual([])
    expect([...result.copied].sort()).toEqual([...ROOT_FILE_SET, ...SCAFFOLD_FILE_SET].sort())
    // 占位符渲染
    const appPy = readFileSync(join(root, 'app.py'), 'utf8')
    expect(appPy).toContain('明星形象平台')
    expect(appPy).not.toContain('{{project_name}}')
    expect(readFileSync(join(root, 'ui/index.html'), 'utf8')).not.toContain('{{project_title}}')
    // 契约 command 改写：骨架样例按根目录写，物化后指向 00_SCAFFOLD/
    const contract = JSON.parse(readFileSync(join(root, '00_SCAFFOLD/contract.json'), 'utf8')) as { driver: { command: string[] } }
    const scriptParts = contract.driver.command.filter((part) => part.endsWith('driver-skeleton.py'))
    expect(scriptParts).toEqual(['00_SCAFFOLD/driver-skeleton.py'])
  })

  it('includeScaffold=false（quick/implement 腿）：只物化根文件，无 00_SCAFFOLD 契约件', () => {
    const root = mkdtempSync(join(tmpdir(), 'bloma-skel-provision-'))
    roots.push(root)
    const result = provisionDesktopSkeletonV2(root, '快速工具')
    expect([...result.missing, ...result.failed]).toEqual([])
    expect(result.copied.sort()).toEqual([...ROOT_FILE_SET].sort())
    expect(existsSync(join(root, '00_SCAFFOLD/contract.json'))).toBe(false)
  })

  it('幂等：二次物化全部 skip，不覆盖子会话已改文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'bloma-skel-provision-'))
    roots.push(root)
    provisionDesktopSkeletonV2(root, '改名前', { includeScaffold: true })
    // 子会话改写 app.py（同文件覆盖其成果的场景）
    writeFileSync(join(root, 'app.py'), '# 子会话已重写的实现\n', 'utf8')
    const second = provisionDesktopSkeletonV2(root, '改名后', { includeScaffold: true })
    expect(second.copied).toEqual([])
    expect(second.skipped.length).toBe(ROOT_FILE_SET.length + SCAFFOLD_FILE_SET.length)
    expect(readFileSync(join(root, 'app.py'), 'utf8')).toBe('# 子会话已重写的实现\n')
  })

  it('骨架源对账：物化清单里的每个文件在骨架目录真实存在（新骨架文件未登记 → missing 暴露）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bloma-skel-provision-'))
    roots.push(root)
    const result = provisionDesktopSkeletonV2(root, '对账', { includeScaffold: true })
    expect(result.missing, `骨架源缺失：${result.missing.join(',')}`).toEqual([])
  })
})
