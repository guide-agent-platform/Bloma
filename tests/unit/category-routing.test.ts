import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../shared/types'
import { createChannel, updateChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { getCategoryRoutingPath } from '../../storage/config-paths'
import {
  buildCategoryRoutingViews,
  buildCategoryRoutingRoleViews,
  getCategoryFallbackChannelIds,
  loadCategoryRouting,
  resetCategoryRoutingForTests,
  resolveRoutedChannelId,
  roleForCategory,
  ROLE_CATEGORIES,
  ROUTABLE_ROLES,
  saveCategoryRouting,
  setCategoryRoutingForTests,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from '../../main/platform/llm/category-routing'

/**
 * 类别 → 渠道路由（M5）：每个职责可固定走某家厂商渠道，未配置类别保持全局自动。
 * 锁定行为（§4/§6/§10）：
 * - 解析优先级（显式 channel_id > 路由表 > 全局兜底）由 resolveChannelEnv 集成，
 *   本文件锁 resolveRoutedChannelId 三态回退（悬空/禁用/非 Anthropic 协议）；
 * - 悬空（已删除）→ 回退 + console.warn（不静默）；禁用 → 回退不落警示（保留意图）；
 * - 保存护栏：结构非法抛错（VALIDATION_ERROR 口径），无效引用剥离 + warn 不阻塞其余；
 * - 往返持久化 + 损坏文件回退空表。
 */

function workingSafeStorage(): void {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
}

function seedChannel(name: string, providerType: Channel['provider_type'] = 'anthropic'): Channel {
  return createChannel({
    name,
    provider_type: providerType,
    base_url: `https://${name}.example`,
    api_key: `key-${name}`,
    models: [{ id: `${name}-m1`, name: `model-${name}`, enabled: true }],
  })
}

describe('current flow routing',()=>{
 const originalPromaHome=process.env.PROMA_HOME
 beforeEach(()=>{process.env.PROMA_HOME=mkdtempSync(join(tmpdir(),'bloma-flow-routing-test-'));workingSafeStorage();resetCategoryRoutingForTests();vi.restoreAllMocks()})
 afterEach(()=>{resetCategoryRoutingForTests();restorePromaHome(originalPromaHome)})
 it('exposes exactly two groups and three active categories',()=>{
  seedChannel('a');expect(ROUTABLE_ROLES).toEqual(['guide','programming']);expect(ROLE_CATEGORIES.guide).toEqual(['guide']);expect(roleForCategory('judge')).toBeUndefined();expect(buildCategoryRoutingRoleViews().views.map(row=>row.label)).toEqual(['需求沟通','界面与制作']);expect(buildCategoryRoutingViews().views.map(row=>row.category)).toEqual(['guide','sketch','mvp'])
 })
 it('updates edited groups only and expands generation defaults',()=>{
  const a=seedChannel('a'),b=seedChannel('b');saveCategoryRouting({guide:{channel_id:a.id},sketch:{channel_id:a.id},mvp:{channel_id:b.id}})
  expect(buildCategoryRoutingRoleViews().views.find(row=>row.role==='programming')?.effective).toBe('mixed')
  updateCategoryRoutingRoles({guide:{channel_id:b.id}});expect(loadCategoryRouting()).toEqual({guide:{channel_id:b.id},sketch:{channel_id:a.id},mvp:{channel_id:b.id}})
  updateCategoryRoutingRoles({programming:{channel_id:a.id,fallback_channel_ids:[b.id]}});expect(resolveRoutedChannelId('mvp')).toBe(a.id);expect(getCategoryFallbackChannelIds('sketch')).toEqual([b.id])
 })
 it('explicit empty entries reset only the selected groups',()=>{
  const a=seedChannel('a');updateCategoryRoutingRoles({guide:{channel_id:a.id},programming:{channel_id:a.id}});updateCategoryRoutingRoles({guide:{}});expect(loadCategoryRouting()).toEqual({sketch:{channel_id:a.id},mvp:{channel_id:a.id}});updateCategoryRoutingRoles({programming:{}});expect(loadCategoryRouting()).toEqual({})
 })
 it('drops obsolete stored routes rather than exposing a compatibility profile',()=>{
  const a=seedChannel('a');setCategoryRoutingForTests({guide:{channel_id:a.id},judge:{channel_id:a.id},audit:{channel_id:a.id},prd:{channel_id:a.id},summary:{channel_id:a.id}})
  expect(resolveRoutedChannelId('judge')).toBeUndefined();expect(getCategoryFallbackChannelIds('audit')).toEqual([])
  updateCategoryRoutingRoles({});expect(loadCategoryRouting()).toEqual({guide:{channel_id:a.id}});expect(JSON.parse(readFileSync(getCategoryRoutingPath(),'utf8')).routing).toEqual({guide:{channel_id:a.id}})
 })
 it('rejects retired/unknown role and category payloads',()=>{
  expect(()=>updateCategoryRoutingRoles({judge:{}})).toThrow('CATEGORY_ROUTING_INVALID');expect(()=>updateCategoryRouting({audit:{}})).toThrow('CATEGORY_ROUTING_INVALID');expect(()=>updateCategoryRoutingRoles({guide:{audit_channel_id:'old'}})).toThrow('CATEGORY_ROUTING_INVALID')
 })
 it.each(['nope',42,null,[]])('rejects malformed top-level payload %s',input=>{expect(()=>updateCategoryRoutingRoles(input)).toThrow('CATEGORY_ROUTING_INVALID')})
 it('rejects malformed entries without writing',()=>{
  for(const input of [{guide:'bad'},{guide:{channel_id:42}},{programming:{fallback_channel_ids:'bad'}}])expect(()=>updateCategoryRoutingRoles(input)).toThrow('CATEGORY_ROUTING_INVALID')
 })
 it('removes unavailable references and preserves disabled current choices as inactive',()=>{
  const a=seedChannel('a');vi.spyOn(console,'warn').mockImplementation(()=>{});updateCategoryRoutingRoles({guide:{channel_id:'missing'}});expect(resolveRoutedChannelId('guide')).toBeUndefined();updateCategoryRoutingRoles({guide:{channel_id:a.id}});updateChannel(a.id,{enabled:false});expect(resolveRoutedChannelId('guide')).toBeUndefined();expect(loadCategoryRouting().guide?.channel_id).toBe(a.id)
 })
 it('refuses unsupported provider references',()=>{vi.spyOn(console,'warn').mockImplementation(()=>{});const a=seedChannel('unsupported','openai');updateCategoryRoutingRoles({guide:{channel_id:a.id}});expect(loadCategoryRouting()).toEqual({})})
 it('persists and reloads current route values',()=>{
  const a=seedChannel('a');updateCategoryRoutingRoles({programming:{channel_id:a.id}});resetCategoryRoutingForTests();expect(resolveRoutedChannelId('sketch')).toBe(a.id);expect(buildCategoryRoutingRoleViews().version).toBe(3)
 })
})
