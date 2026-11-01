import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { getPromaHome } from '../../../storage/config-paths'
import { mainRootDir } from '../paths'

export interface ScopedSkill { skill: Skill; root: string; hash: string }
export const skillDigest = (text: string) => createHash('sha256').update(text).digest('hex')
const inside = (file: string, root: string) => {
  const rel = relative(root, file)
  return rel === '' || !rel.startsWith('..') && !isAbsolute(rel)
}

/** One Pi-parsed, host-scoped catalog for both explicit and agent-selected skills. */
export async function loadSkillCatalog(projectRoot: string, includeBundled = false): Promise<Map<string, ScopedSkill>> {
  const { loadSkillsFromDir } = await import('@earendil-works/pi-coding-agent')
  const roots = [join(projectRoot, '.bloma', 'skills'), join(getPromaHome(), 'skills'),
    ...(includeBundled ? [join(mainRootDir(), 'templates', 'skills')] : [])]
  const entries = new Map<string, ScopedSkill>(), seen = new Set<string>()
  for (const candidate of roots) {
    let root: string
    try { root = realpathSync(candidate) } catch { continue }
    for (const skill of loadSkillsFromDir({ dir: root, source: 'bloma' }).skills) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      try {
        const file = realpathSync(skill.filePath)
        if (!inside(file, root) || statSync(file).size > 131072) continue
        entries.set(skill.name, { skill: { ...skill, filePath: file, baseDir: dirname(file) }, root: dirname(file), hash: skillDigest(readFileSync(file, 'utf8')) })
      } catch { /* Unavailable entries never grant a reader. */ }
    }
  }
  return entries
}

export function readCatalogSkill(entry: ScopedSkill, resource?: string): string {
  if (!inside(realpathSync(entry.skill.filePath), entry.root)) throw Error('SKILL_RESOURCE_OUTSIDE_OR_TOO_LARGE')
  if (skillDigest(readFileSync(entry.skill.filePath, 'utf8')) !== entry.hash) throw Error('SKILL_CHANGED_RELOAD_REQUIRED')
  const file = realpathSync(resource ? resolve(entry.root, resource) : entry.skill.filePath)
  if (!inside(file, entry.root) || statSync(file).size > 131072) throw Error('SKILL_RESOURCE_OUTSIDE_OR_TOO_LARGE')
  const bytes = readFileSync(file)
  if (bytes.includes(0)) throw Error('SKILL_RESOURCE_NOT_TEXT')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Host command selection; parsing/stripping skill frontmatter belongs to Pi.
 * Only discovered names are accepted; no second YAML reader or directory aliases. */
export async function prepareSkillTask(task: string, entries: Map<string, ScopedSkill>) {
  const names = [...new Set([...task.matchAll(/\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map(match => match[1]!))]
  const { stripFrontmatter } = await import('@earendil-works/pi-coding-agent')
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')
  const blocks: string[] = [], activatedSkills: string[] = []
  for (const name of names) {
    const entry = entries.get(name)
    if (!entry) continue
    const body = stripFrontmatter(readCatalogSkill(entry)).trim()
    if (!body) continue
    activatedSkills.push(name)
    blocks.push(`<skill name="${escape(name)}" location="${escape(entry.skill.filePath)}">\nReferences are relative to ${escape(entry.root)}.\n\n${body}\n</skill>`)
  }
  return { content: blocks.length ? `${blocks.join('\n\n')}\n\n${task}` : task, activatedSkills }
}
