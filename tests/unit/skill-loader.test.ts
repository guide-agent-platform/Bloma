import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSkillLookup,
  discoverSkills,
  extractSkillCommandNames,
  preparePromptWithSkills,
  prepareTaskWithSkills,
  resolveSkillRoots,
} from '../../main/skill-loader'
import { createProject } from '../../main/project-service'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { getPromaHome } from '../../storage/config-paths'

/**
 * Skill 机制（2026-08-28，guidance v5 ①，r14 方向 A 原型 16/16 转正）：
 * SKILL.md 发现（frontmatter name 优先/目录名回退）→ 别名索引（先到先得）→
 * /skill: 命令提取（多命令去重保序）→ prompt 前置注入（strip frontmatter + XML 转义）→
 * 两级白名单根（项目 <root>/.bloma/skills + 全局 <PROMA_HOME>/skills）+ realpath 逃逸过滤。
 *
 * 安全背景（spec §六）：SkillSec-Eval 威胁矩阵 admission 阶段——白名单根 + realpath
 * 过滤是行业标准防线（2026-06「Fake AI Agent Skill」事件佐证）。
 */

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bloma-skill-test-'))
  process.env.PROMA_HOME = await mkdtemp(join(tmpdir(), 'bloma-skill-home-'))
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  restorePromaHome(process.env.PROMA_HOME)
})

/** 标准白名单根：4 个 frontmatter 变体 skill（标准/BOM+... 结尾/无 frontmatter/空文件）。 */
async function seedRootA(): Promise<string> {
  const rootA = join(base, 'skills-a')
  await mkdir(join(rootA, 'walkthrough'), { recursive: true })
  await writeFile(
    join(rootA, 'walkthrough', 'SKILL.md'),
    '---\nname: ui-walkthrough\ndescription: "UI 走查 SOP"\n---\n\n# 走查步骤\n1. 截图\n2. 对照清单',
    'utf8',
  )
  await mkdir(join(rootA, 'no-frontmatter'), { recursive: true })
  await writeFile(join(rootA, 'no-frontmatter', 'SKILL.md'), '# 纯正文 skill\n内容直接可用', 'utf8')
  await mkdir(join(rootA, 'bom-skill'), { recursive: true })
  await writeFile(join(rootA, 'bom-skill', 'SKILL.md'), '﻿---\nname: bom-name\ndescription: BOM 文件\n...\n\nBOM 正文', 'utf8')
  await mkdir(join(rootA, 'empty-skill'), { recursive: true })
  await writeFile(join(rootA, 'empty-skill', 'SKILL.md'), '', 'utf8')
  return rootA
}

describe('discoverSkills（发现与 frontmatter 变体）', () => {
  it('[S4-AGENT-020] frontmatter name 优先 / 无 frontmatter 回退目录名 / 空文件无名忽略', async () => {
    const rootA = await seedRootA()
    const skills = await discoverSkills([rootA])
    const byName = new Map(skills.map((s) => [s.name, s]))
    expect(byName.has('ui-walkthrough')).toBe(true)
    expect(byName.has('no-frontmatter')).toBe(true)
    expect(byName.has('empty-skill')).toBe(false)
    expect(skills).toHaveLength(3)
  })

  it('[S4-AGENT-021] BOM + `...` 结尾 frontmatter 正常解析（Windows 编辑器常写入 BOM）', async () => {
    const rootA = await seedRootA()
    const skills = await discoverSkills([rootA])
    const bom = skills.find((s) => s.name === 'bom-name')
    expect(bom).toBeDefined()
    expect(bom?.body).toBe('BOM 正文')
  })

  it('[S4-AGENT-022] junction 逃逸：白名单根外的 skill 被过滤（realpath 边界）', async () => {
    const rootA = await seedRootA()
    const outside = join(base, 'outside')
    await mkdir(join(outside, 'escapee'), { recursive: true })
    await writeFile(join(outside, 'escapee', 'SKILL.md'), '---\nname: escapee\n---\n逃逸内容', 'utf8')
    await mkdir(join(rootA, 'junction-link'), { recursive: true })
    let junctionCreated = false
    try {
      await symlink(outside, join(rootA, 'junction-link'), 'junction')
      junctionCreated = true
    } catch {
      // 无权限环境跳过 junction 断言（Windows 本机通常可建）
    }
    if (!junctionCreated) return
    const skills = await discoverSkills([rootA])
    expect(skills.find((s) => s.name === 'escapee')).toBeUndefined()
    // realpath 后的 filePath 必须仍在白名单根内（防御性断言：所有发现的 skill 都在根内）
    const guardedRoot = realpathSync.native(rootA)
    for (const skill of skills) {
      expect(realpathSync.native(skill.filePath).startsWith(guardedRoot)).toBe(true)
    }
  })

  it('[S4-AGENT-023] 根目录不存在 → 返回空数组（零异常）', async () => {
    const skills = await discoverSkills([join(base, 'not-exist')])
    expect(skills).toEqual([])
  })
})

describe('buildSkillLookup / extractSkillCommandNames', () => {
  it('[S4-AGENT-024] 别名索引：name 优先 + 目录名别名可命中 + 同名先到先得（roots 顺序确定性）', async () => {
    const rootA = await seedRootA()
    const rootB = join(base, 'skills-b')
    await mkdir(join(rootB, 'dup'), { recursive: true })
    await writeFile(join(rootB, 'dup', 'SKILL.md'), '---\nname: ui-walkthrough\n---\nB 版内容', 'utf8')
    const skills = await discoverSkills([rootA, rootB])
    const lookup = buildSkillLookup(skills)
    // name 优先命中
    expect(lookup.get('ui-walkthrough')?.body).toContain('走查步骤')
    // 目录名别名（rootA 的 walkthrough 目录）
    expect(lookup.get('walkthrough')?.body).toContain('走查步骤')
    // 先到先得：rootB 的 ui-walkthrough 不覆盖 rootA
    expect(lookup.get('ui-walkthrough')?.root).toBe(realpathSync.native(rootA))
  })

  it('[S4-AGENT-025] 命令提取：多命令保序 / 重复去重 / 无命令返回空', () => {
    expect(extractSkillCommandNames('/skill:ui-walkthrough 然后用 /skill:no-frontmatter')).toEqual([
      'ui-walkthrough',
      'no-frontmatter',
    ])
    expect(extractSkillCommandNames('/skill:bom-name /skill:bom-name')).toHaveLength(1)
    expect(extractSkillCommandNames('普通消息没有命令')).toEqual([])
  })
})

describe('preparePromptWithSkills（注入）', () => {
  it('[S4-AGENT-026] 注入前置 + frontmatter 剥离 + 原文在后 + 激活记录', async () => {
    const rootA = await seedRootA()
    const lookup = buildSkillLookup(await discoverSkills([rootA]))
    const prompt = '帮我走查登录页 /skill:ui-walkthrough'
    const prep = await preparePromptWithSkills(lookup, prompt)
    expect(prep.content.startsWith('<skill name="ui-walkthrough"')).toBe(true)
    expect(prep.content.endsWith(prompt)).toBe(true)
    // frontmatter 已剥离（description 不进正文），正文保留
    expect(prep.content).not.toContain('UI 走查 SOP')
    expect(prep.content).toContain('# 走查步骤')
    expect(prep.activatedSkills).toEqual(['ui-walkthrough'])
  })

  it('[S4-AGENT-027] 未知命令静默忽略：返回原文不报错不注入', async () => {
    const rootA = await seedRootA()
    const lookup = buildSkillLookup(await discoverSkills([rootA]))
    const prompt = '/skill:nonexistent 普通文本'
    const prep = await preparePromptWithSkills(lookup, prompt)
    expect(prep.content).toBe(prompt)
    expect(prep.activatedSkills).toEqual([])
  })

  it('[S4-AGENT-028] name 含引号/尖括号已 XML 转义', async () => {
    const rootA = await seedRootA()
    const skills = await discoverSkills([rootA])
    const weird = new Map([['weird', { ...skills[0], name: 'we"ird<n>', body: '内容' }]])
    const prep = await preparePromptWithSkills(weird, '/skill:weird')
    expect(prep.content.startsWith('<skill name="we&quot;ird&lt;n&gt;"')).toBe(true)
  })

  it('[S4-AGENT-029] 无命令零注入：prepareTaskWithSkills 返回原文（不触 IO）', async () => {
    const prep = await prepareTaskWithSkills('普通任务没有 skill 命令', undefined)
    expect(prep.content).toBe('普通任务没有 skill 命令')
    expect(prep.activatedSkills).toEqual([])
  })
})

describe('resolveSkillRoots（两级白名单根）', () => {
  it('[S4-AGENT-030] 项目级 <root>/.bloma/skills 优先 + 全局 <PROMA_HOME>/skills 兜底', () => {
    const project = createProject({ request_id: 'req-skill-roots', mode: 'quick' })
    const roots = resolveSkillRoots(project.project_id)
    expect(roots).toHaveLength(2)
    expect(roots[0]).toBe(join(project.root_path, '.bloma', 'skills'))
    expect(roots[1]).toBe(join(getPromaHome(), 'skills'))
  })

  it('[S4-AGENT-031] 项目不存在 → 只回全局根（不抛 PROJECT_NOT_FOUND）', () => {
    const roots = resolveSkillRoots('no-such-project')
    expect(roots).toHaveLength(1)
    expect(roots[0]).toBe(join(getPromaHome(), 'skills'))
  })
})

describe('prepareTaskWithSkills（agent-loop hook 入口，真实文件系统端到端）', () => {
  it('[S4-AGENT-032] 全局根 skill 命中：命令替换为前置注入块 + 原文在后', async () => {
    const globalRoot = join(getPromaHome(), 'skills')
    await mkdir(join(globalRoot, 'dev-loop'), { recursive: true })
    await writeFile(join(globalRoot, 'dev-loop', 'SKILL.md'), '---\nname: dev-loop\ndescription: 开发循环 SOP\n---\n\n取号→开发→测试', 'utf8')
    const prep = await prepareTaskWithSkills('按流程开发 /skill:dev-loop', 'no-such-project')
    expect(prep.activatedSkills).toEqual(['dev-loop'])
    expect(prep.content.startsWith('<skill name="dev-loop"')).toBe(true)
    expect(prep.content.endsWith('按流程开发 /skill:dev-loop')).toBe(true)
    expect(prep.content).toContain('取号→开发→测试')
  })
})

// ==================== 多厂商审查 r51 采纳修复（deepseek high + aliyun high/medium） ====================

describe('审查加固（r51 multi-vendor review 采纳项）', () => {
  it('[S4-AGENT-035] escapeXmlAttr 转义单引号（aliyun high：属性注入防御补全）', async () => {
    const rootA = await seedRootA()
    const skills = await discoverSkills([rootA])
    const weird = new Map([['quote', { ...skills[0], name: "it's<ted>", body: '内容' }]])
    const prep = await preparePromptWithSkills(weird, '/skill:quote')
    expect(prep.content.startsWith('<skill name="it&#39;s&lt;ted&gt;"')).toBe(true)
  })

  it('[S4-AGENT-036] 命令提取拒绝非法首字符（-/. 开头不匹配，aliyun medium：格式严格性）', () => {
    expect(extractSkillCommandNames('/skill:-bad /skill:.bad /skill:good-name')).toEqual(['good-name'])
    expect(extractSkillCommandNames('/skill:ok.name /skill:ok_name2')).toEqual(['ok.name', 'ok_name2'])
  })

  it('[S4-AGENT-037] 项目级同名 skill 优先于全局（deepseek medium：两级根优先级端到端）', async () => {
    const project = createProject({ request_id: 'req-skill-priority', mode: 'quick' })
    const projectRoot = join(getPromaHome(), 'skills')
    await mkdir(join(projectRoot, 'dup-x'), { recursive: true })
    await writeFile(join(projectRoot, 'dup-x', 'SKILL.md'), '---\nname: dup-x\n---\n全局版内容', 'utf8')
    const projectSkillRoot = join(project.root_path, '.bloma', 'skills')
    await mkdir(join(projectSkillRoot, 'dup-x'), { recursive: true })
    await writeFile(join(projectSkillRoot, 'dup-x', 'SKILL.md'), '---\nname: dup-x\n---\n项目版内容', 'utf8')
    const prep = await prepareTaskWithSkills('用 /skill:dup-x', project.project_id)
    expect(prep.activatedSkills).toEqual(['dup-x'])
    expect(prep.content).toContain('项目版内容')
    expect(prep.content).not.toContain('全局版内容')
  })
})
