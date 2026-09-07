# M5 设计：类别 → 渠道路由（跨厂商职责分工）

> 项目：向导 Agent 多智能体协同开发平台
> 文档：`docs/03_ARCHITECTURE/M5-category-routing.md`
> 日期：2026-08-19 | 状态：已确认（设计稿定稿）
> 依赖：M4 `main/model-resolution.ts`（类别→模型）、T9 `main/runtime-fallback.ts`（跨渠道回退）
> 涉及模块：`runtime-fallback.ts`、`model-resolution.ts`、`channel-manager.ts`、`storage/config-paths.ts`、`ipc.ts`、`shared/types.ts`、`preload/bridge.ts`、`renderer` 设置页
<!-- fix: ATK-I-003 -->

---

## 1. 背景与目标

**现状**：M4 已实现「文档类别 → 模型」路由，但**渠道是全局的**——`resolveChannelEnv` 只在「显式 `channel_id` 或第一个启用渠道」内解析类别模型；T9 只在**基础设施故障**时跨渠道切备用。结果：一次会话同一时刻只能用一个厂商的 key，做不到「不同职责交给不同厂商」。

**目标**：新增**类别 → 渠道**分工表。每个职责（`DocumentCategory`）可固定走某家厂商的渠道，未配置的类别保持「全局自动」。用户可提供多家 key（Kimi / GLM / DeepSeek），让平台按职责调用不同模型。

**目标映射**（用户指定）：

| 类别 | 职责 | 渠道 |
|---|---|---|
| `sketch` | 草图生成 | Kimi |
| `mvp` | MVP 生成 | GLM |
| `guide` | 向导澄清 / 意图判定 | DeepSeek |
| `prd` | PRD 提取 / 功能项加厚 | DeepSeek |
| `judge` | 裁判审查 | DeepSeek |
| `summary` | L3 蒸馏（默认关） | DeepSeek |

> 注：`gwt` 不参与渠道路由——GWT 执行走浏览器探针/静态启发式（`gwt-service.ts`/`gwt-runner.ts`），从不解析 LLM 渠道，故映射表不含 gwt（§2 调用点清单亦无 `category: 'gwt'`）。

---

## 2. 现状与差距（代码事实）

`resolveChannelEnv` 目前的主渠道选择（`runtime-fallback.ts:116`；opts 签名已含 `category: DocumentCategory`）：

```ts
const primary = opts.channelId ? getChannelByIdRaw(opts.channelId) : getFirstEnabledChannel()
```

- `resolveChannelEnv(opts: { channelId?; category; projectId?; sessionId? })` 现状已含 `category`——全部 8 处调用点各自显式传 category；M5 的 `resolvePrimaryChannel(opts)` 直接读 `opts.category` 查路由表，无需透传改造，只改主渠道选择一处。
- 渲染端 `App.tsx` 发消息**从不带 `channel_id`** → 实际恒为 `getFirstEnabledChannel()`（第一个可解密密钥的启用渠道）。
<!-- fix: ATK-F-002 -->
- 类别只决定「渠道内的哪个模型」（`model-resolution.ts` 的 `resolveCategoryModel`），**决定不了渠道**。
- 全部 8 处 `resolveChannelEnv` 调用都汇聚在编排层，改一处主渠道选择即可覆盖全链路：
  `orchestrator.ts:168`、`programming-orchestrator.ts:215/307/479/597/1061`、`repair-engine.ts:204`（mvp）、`memory-distiller.ts:98`（summary）。
- 8 处调用点无一处 `category: 'gwt'`：`categoryForStage` 只产出 sketch/judge/guide/mvp（`model-resolution.ts:93`）；`gwt-service.ts`/`gwt-runner.ts` 走浏览器探针/静态启发式、从不解析 LLM 渠道。→ gwt 不在 M5 路由范围（§1 映射表已无 gwt 行）。<!-- fix: ATK-F-005 -->

**运行时协议约束**：平台唯一查询路径是 `anthropicMessagesQuery`（`orchestrator.ts:771`），**固定请求 `${baseUrl}/v1/messages`（Anthropic Messages 协议）**。因此所有渠道必须是 Anthropic 兼容端点（`ANTHROPIC_PROTOCOL_PROVIDERS` 集合内的 `provider_type`）。

---

## 3. 三家渠道形态（建立渠道的硬约束）

| 厂商 | `provider_type` | 说明 |
|---|---|---|
| DeepSeek | `deepseek` | Anthropic 兼容；`buildSdkEnv` 会规范化 base_url；preset `DEEPSEEK_PRESET_MODELS` |
| Kimi | `kimi-api` | Anthropic 兼容；preset `KIMI_PRESET_MODELS`（k3 / kimi-k2.6） |
| GLM | `zhipu-coding` | **已确认**。智谱开放平台 Anthropic 兼容端点；`buildSdkEnv` 规范化 base_url，连接测试走 `testAnthropicCompatible`。**不能用 OpenAI 协议的 `zhipu`**——运行时查询固定走 `/v1/messages`，OpenAI 协议渠道会 404/协议不匹配 |

---

## 4. 核心设计

### 4.1 渠道选择优先级（新解析链）

新 `resolvePrimaryChannel(opts)`（opts 沿用 `resolveChannelEnv` 既有签名，直接读 `opts.category`），插入在 `resolveChannelEnv` 主渠道选择处：
<!-- fix: ATK-F-002 -->

```
① 显式 channel_id（调用方传入）      → getChannelByIdRaw(channelId)      // 最高，沿用现状，渲染端今天不发
② 路由表 routing[category].channel_id → 校验渠道存在 + enabled + Anthropic 协议，有效则用   // M5 新增
③ 兜底 getFirstEnabledChannel()      → 与现状一致（向后兼容）            // 无路由/路由悬空/路由禁用时
```

- **路由悬空**（指向的渠道**已删除**）：视为未设置，回退 ③，落一条 `console.warn`（不静默）；设置页 UI 同步显示警示（见 §7）。
- **渠道禁用**不属悬空：路由表保留条目（意图），解析时按未设置回退 ③、不落警示；重新启用后自动恢复（见 §7）。
- **密钥损坏**：`getChannelByIdRaw` 不做解密校验，解析阶段不可观测；由 `tryBuildChannelEnv` 落 `decrypt_failed`，走 T9 备用渠道（§4.4），不属于路由悬空回退。
<!-- fix: ATK-Z-001 -->
- **M4 不变**：路由决定「哪个渠道」，`resolveCategoryModel(channel, category)` 在赢家渠道内决定「哪个模型」（preferredModel / strongest / 同 provider 降级链）。两层正交。
- **T9 不变**：主渠道基础设施故障时仍走 `pickBackupChannelEnv` 切备用重试；内容型失败仍绝不切。
- **粒度只做全局**（已确认）：一张全局路由表，不做按项目覆盖。

### 4.2 数据模型（新配置文件）

新文件 `~/.proma/category-routing.json`（snake_case）。**不进 `channels.json`**——后者与 Proma 共用且走 camelCase，混入会破坏 `isOursChannel` 过滤与 Proma 兼容。

```jsonc
{
  "version": 1,
  "routing": {
    "sketch": { "channel_id": "<kimi channel id>", "fallback_channel_ids": ["<ds channel id>"] },
    "mvp":    { "channel_id": "<glm channel id>", "fallback_channel_ids": ["<ds channel id>"] },
    "guide":  { "channel_id": "<ds channel id>" },
    "prd":    { "channel_id": "<ds channel id>" },
    "judge":  { "channel_id": "<ds channel id>" },
    "summary":{ "channel_id": "<ds channel id>" }
    // 未列出的类别（gwt 等）缺省 → 全局自动；gwt 不解析 LLM 渠道，路由无意义
  }
}
```

类型（`shared/types.ts`）：

```ts
interface CategoryRoutingEntry {
  /** 该类别固定渠道；缺省 = 全局自动 */
  channel_id?: string
  /** 基础设施故障时的备用渠道优先顺序（第一版即含）；未设置 = 沿用 T9「任意 enabled 渠道」 */
  fallback_channel_ids?: string[]
}
type CategoryRoutingConfig = Partial<Record<DocumentCategory, CategoryRoutingEntry>>
interface CategoryRoutingFile {
  version: 1
  routing: CategoryRoutingConfig
}
```

### 4.3 新模块 `main/category-routing.ts`

- `getCategoryRoutingPath()`：`join(getPromaHome(), 'category-routing.json')`（并入 `storage/config-paths.ts` 统一管理）。
<!-- fix: ATK-I-003 -->
- `loadCategoryRouting(): CategoryRoutingConfig`：读 JSON，`version` 校验；损坏回退空表 + 警告。
- `saveCategoryRouting(routing)`：固定以 `version: 1` 组装 `CategoryRoutingFile` 后落盘。
<!-- fix: ATK-L-002 -->
- `resolveRoutedChannelId(category): string | undefined`：查路由 → `getChannelByIdRaw` → 校验 enabled **+ `isAnthropicProtocolProvider(provider_type)`（§5#10 导出）**；悬空（已删除）/非 Anthropic 协议返回 `undefined` 并 `console.warn`；禁用返回 `undefined`（不落警示，保留意图，重启用自动恢复）。解析期协议校验与 §6 保存期校验一致，防保存后 `updateChannel` 改 provider_type（如 zhipu-coding→zhipu）或人工/旧版本写入非 Anthropic 渠道 id 后运行时仍判 routed 导致 404。<!-- fix: ATK-Z-003 --><!-- fix: ATK-I-010 -->
- `getCategoryFallbackChannelIds(category): string[]`：读 `fallback_channel_ids`，过滤掉「不存在/非本项目/禁用」条目。
- 测试 seam：`setCategoryRoutingForTests(config)` / `resetCategoryRoutingForTests()`（模块级缓存，同 M4 的 `categoryConfigs` 模式）。

### 4.4 T9 备用渠道顺序扩展

`pickBackupChannelEnv(context)` 目前按 `listEnabledRawChannels()` 配置序挑第一个可用渠道。M5 改为：**先按 `fallback_channel_ids` 顺序尝试，未命中再回退到任意 enabled 渠道**（保序去重，跳过当前主渠道）：

```ts
const fallbackOrder = getCategoryFallbackChannelIds(context.category)
const candidates = [...fallbackOrder.map(getChannelByIdRaw), ...listEnabledRawChannels()]
// 遍历时：跳过非本项目/禁用/等于 context.channelId/已见过
```

未配置 `fallback_channel_ids` → 候选列表退化为 `listEnabledRawChannels()`，行为与现状完全一致。

### 4.5 与 M4 / T9 的边界

| 层 | 职责 | 不做什么 |
|---|---|---|
| M4 `resolveCategoryModel` | 渠道内「类别→模型」 | 不选渠道 |
| M5 `category-routing` | 「类别→渠道」主路由 + 备用顺序 | 不选模型、不判故障 |
| T9 `runtime-fallback` | 基础设施故障跨渠道切换留痕 | 不动路由表；内容型失败不切 |

---

## 5. 改动点清单（代码级）

| # | 模块 | 改动 |
|---|---|---|
| 1 | `storage/config-paths.ts` | 新增 `getCategoryRoutingPath()` |
| 2 | 新增 `main/category-routing.ts` | 见 §4.3：load/save/resolve/fallback + 测试 seam |
| 3 | `main/runtime-fallback.ts` | `resolveChannelEnv` 主渠道改走 `resolvePrimaryChannel(opts.category)`（§4.1，opts 签名不变）<!-- fix: ATK-F-002 -->；`pickBackupChannelEnv` 支持 fallback 顺序（§4.4） |
| 4 | `shared/types.ts` | IPC 常量 + 类型 + ElectronAPI 契约（§6）；将 `DocumentCategory` 从 `main/model-resolution.ts` 迁移至 shared/types.ts（main 侧 `export type { DocumentCategory } from '../shared/types'` 兼容既有导入）<!-- fix: ATK-Z-002 --> |
| 5 | `main/ipc.ts` | 两个 handler：`category-routing:list` / `category-routing:update`（校验 + 返回视图模型） |
| 6 | `preload/bridge.ts` | 白名单暴露两个通道 |
| 7 | `renderer` | ChannelSettingsPage 内新增「职责分工」区 + atoms 消费（§7） |
| 8 | `main/decision-log.ts` | `DecisionType` 增 `'category_route'` |
| 9 | 测试 | §10 |
| 10 | `main/channel-manager.ts` | 导出 `isAnthropicProtocolProvider(provider)`（把私有 `ANTHROPIC_PROTOCOL_PROVIDERS` 判定暴露给 §6 update 校验 / §9.1 协议过滤）<!-- fix: ATK-F-004 --> |

---

## 6. IPC 契约（四层全链路）

`IPC_CHANNELS` 新增：

```ts
CATEGORY_ROUTING_LIST: 'category-routing:list'
CATEGORY_ROUTING_UPDATE: 'category-routing:update'
```

`category-routing:list` 返回**视图模型**（含渠道名/模型预览，供 UI 直接渲染；不带明文 key）：

```ts
interface CategoryRoutingView {
  category: DocumentCategory
  label: string         // 中文职责名（每类别一个，与 §1 职责列逐字一致）：sketch=草图生成、mvp=MVP 生成、guide=向导澄清 / 意图判定、prd=PRD 提取 / 功能项加厚、judge=裁判审查、summary=L3 蒸馏（默认关）<!-- fix: ATK-I-006 --><!-- fix: ATK-F-005 --><!-- fix: ATK-I-009 -->
  channel_id?: string   // 配置值；dangling 态仍保留原配置值用于展示
  fallback_channel_ids?: string[] // 配置的备用渠道顺序；dangling 态保留原配置值供展示/编辑，全量覆盖保存时可回读
  channel_name?: string // 当前解析到的渠道名（routed=路由渠道；auto/dangling=生效的全局默认渠道）
  model_name?: string   // M4 在该渠道解析到的模型名（预览；auto/dangling 为全局默认渠道解析结果）
  effective: 'routed' | 'auto' | 'dangling' // routed=命中路由；auto=全局默认（含禁用渠道生效期）；dangling=已删除渠道
}
interface CategoryRoutingListResult {
  version: number
  views: CategoryRoutingView[]
}
```
<!-- fix: ATK-L-004 --><!-- fix: ATK-I-004 --><!-- fix: ATK-U-001 --><!-- fix: ATK-U-002 -->

`category-routing:update` 输入：

```ts
interface CategoryRoutingUpdateInput {
  routing: CategoryRoutingConfig  // 全量覆盖，缺省类别 = 未配置
}
```

校验（main 进程）：`routing` 结构非法（非对象/条目类型错误）才返回 `VALIDATION_ERROR`；`channel_id` 与 `fallback_channel_ids` 每一项须引用「存在且 `isOursChannel`」的渠道（`getChannelByIdRaw`），且 `isAnthropicProtocolProvider(provider_type)` 为真（§5#10 导出的 `ANTHROPIC_PROTOCOL_PROVIDERS` 判定，Anthropic 兼容，防 OpenAI 协议渠道运行时 404）；**非 Anthropic 协议引用**（含存在且 `isOursChannel` 但启用/禁用的 OpenAI 协议渠道）在保存时被**剥离**并 `console.warn`（不写悬空入库、不阻塞其余类别保存；属「引用无效」而非结构非法，故不返回 `VALIDATION_ERROR`，与 §9.1「剥离」口径一致<!-- fix: ATK-I-007-wording -->）；引用「已删除/非本项目」渠道的条目同剥离 + `console.warn`；引用「禁用渠道」的条目保留（重新启用后自动恢复，见 §7）——**仅当该禁用渠道亦满足 Anthropic 协议**：禁用且非 Anthropic 协议的渠道按「非 Anthropic 协议」剥离 + `console.warn`（重启用后仍 404，保留意图无意义）；非 `DocumentCategory` 的未知键（如 `"foo"`）在保存时剥离并 `console.warn`（与已删除引用同处理，不阻塞其余类别保存）。测试须同步更新 `tests/acceptance/sprint0/ipc-contract.test.ts` 的 `expectedChannels`（`scripts/docs-check.mjs` 清单为子集守卫，新增通道不强制同步）。
<!-- fix: ATK-L-005 --><!-- fix: ATK-G-002 --><!-- fix: ATK-L-001 --><!-- fix: ATK-F-003 --><!-- fix: ATK-F-004 --><!-- fix: ATK-U-003 -->

---

## 7. 设置 UI 面（renderer）

在 `ChannelSettingsPage` **内新增「职责分工」区**（已确认），6 行职责 + 操作：

- 每行：中文职责名 + 职责说明 + **渠道下拉**（选项：`自动/全局默认` + 各渠道名）+ **生效模型预览**（`M4 在该渠道解析到的模型名`，供用户确认实际会用哪家）。
- 悬空态：路由指向**已删除**的渠道 → 行内显示警示文案（如「指向的渠道已被删除，当前回退全局默认」），`effective: 'dangling'`；悬空行提供「恢复自动」操作（清除该行 `channel_id`，解除悬空）。渠道**禁用不属悬空**——保留条目（意图），见下段「禁用」处理。
- 「恢复全部默认」按钮：清空 routing 落盘为 `{}`。
- 渠道**禁用**不影响路由表（保留意图），禁用期间生效时按未设置处理，重新启用后自动恢复；渠道**删除**无「重新启用」路径——被删除渠道的路由悬空，行内「恢复自动」清除或由后续保存自动剥离（§6），需用户重新选择渠道。
- 每类别可展开「备用渠道顺序」（`fallback_channel_ids`，多选排序），第一版即支持，折叠为高级选项。

---

## 8. 留痕与可观测性

- 路由是**静态配置**，非事件——不新增用户可见系统行（避免刷屏，与 T9 `[channel-switch]` 的语义区分开）。
- 新增决策日志条目 `category_route`：当主进程路由解析命中路由表（`resolvePrimaryChannel` 选中 `routing[category].channel_id`，即视图模型 `effective: 'routed'`；由解析结果判定，非依赖渲染端字段）时记录；按「项目+会话+类别」聚合，30 秒窗口内同键只落一次（节流复用 T9 的 30s Map 模式，非永久去重；`projectId`/`sessionId` 缺失时与 T9 `recordChannelSwitch` 一致直接跳过不落日志，节流键不进入 Map，避免含 `undefined` 的键跨会话/项目碰撞误吞），`detail` 含 `{ category, channel_id, channel_name, model, source: 'category_routing' }`。支撑回访/审计重建「哪一步用了哪家」。
<!-- fix: ATK-L-007 --><!-- fix: ATK-F-001 --><!-- fix: ATK-I-001 -->
- 保留 `[runAgent] channel X 解析成功（类别 Y）` 的 `console.debug`，测试排障仍可用。
- **后续项**（不在本稿范围）：T8 埋点逐类重核时，确认每次调用的 `channel + category` 已上报，以支撑三家成本/失败率对比。

---

## 9. 边界与风险

1. **协议约束**：GLM 渠道用 `zhipu-coding`（Anthropic 兼容，已确认）；误配 OpenAI 协议会静默 404——main 进程 update 校验会**剥离**非 Anthropic 兼容渠道的引用（§6，非 `VALIDATION_ERROR`）；解析侧 `resolveRoutedChannelId` 亦按 `isAnthropicProtocolProvider` 复核（§4.3，防保存后渠道被 `updateChannel` 改协议或配置被人工/旧版本写入非 Anthropic 渠道 id 后仍判 routed）；设置 UI 的渠道下拉亦按 `provider_type` 过滤。 <!-- fix: ATK-G-002 --><!-- fix: ATK-Z-003 --><!-- fix: ATK-I-007 -->
2. **厂商行为漂移**：三家对 system prompt / JSON 输出顺从度不同，M5 不改 `prompts/shared.ts`；建议按类别记录 parse 失败率（已有决策日志/埋点可支撑），漂移后再决定是否按类别微调 prompt。
3. **成本/延迟差异**：三家定价、限流不同；`max_tokens` 目前是渠道级（M4 温度表已按类别），如需**按类别独立 max_tokens**，记为后续项。
4. **悬空引用**：路由指向已删渠道 → 回退全局 + 警告 + UI 警示；update 保存时剥离已删除引用、不写悬空入库（§6）。 <!-- fix: ATK-L-005 -->
5. **向后兼容**：无路由配置文件（fresh/存量）时行为与现状完全一致——`category-routing.json` 缺省 = `{}`。
6. **`summary` 类别**：L3 蒸馏默认关，配置了也无害。

---

## 10. 测试计划

- 新增 `tests/unit/category-routing.test.ts`：
  - 优先级：显式 `channel_id` > 路由 > 全局兜底；
  - 悬空引用（渠道删除）→ 回退全局 + 警告日志；禁用渠道 → 回退全局 + 保留条目（意图），重启用后恢复（区分 §7 已删除/禁用两态）；
  - `saveCategoryRouting` / `loadCategoryRouting` 往返 + 损坏文件回退；
  - `getCategoryFallbackChannelIds` 过滤不存在/禁用条目；
  - `category-routing:update` 校验分支全覆盖（§6 护栏的客观度量）：结构非法 → `VALIDATION_ERROR`；已删除/非本项目引用 → 剥离 + `console.warn`；非 Anthropic 协议引用（含启用与禁用渠道）→ 剥离 + `console.warn`；禁用且 Anthropic 协议渠道 → 保留；未知键（`"foo"`）→ 剥离 + `console.warn`；其余类别正常保存不被阻塞；
  - `resolveRoutedChannelId` 协议复核：保存后渠道被 `updateChannel` 改成非 Anthropic 协议 / 配置人工写入 OpenAI 协议渠道 id → 解析返回 `undefined`（不判 routed）（§4.3/§9.1）；
  - 测试 seam 注入/复位。
- 扩展 `tests/unit/channel-fallback.test.ts`：
  - 路由主渠道生效：sketch 类别解析到 Kimi 渠道 env（断言 `buildSdkEnv` 收到的 base_url/model）；
  - 路由主渠道 build 失败 → 先按 `fallback_channel_ids` 顺序切 → 再任意渠道；
  - 无路由配置时与现有用例行为一致（回归）。
- `tests/acceptance/sprint0/ipc-contract.test.ts`：`expectedChannels` 增加两个新通道（`scripts/docs-check.mjs` 清单为子集守卫，新增通道不强制同步）。<!-- fix: ATK-F-003 -->
- renderer `ChannelSettingsPage`「职责分工」区：`effective === 'dangling'` 时显示悬空警示文案；「恢复自动」清除 `channel_id` 后 `effective` 变 `auto`（组件测试断言，支撑 §11.4）。<!-- fix: ATK-G-003 -->
- **mock 注意**（沿用约定）：`channel-manager` 必须 `importOriginal` + spread；桩渠道必须带 enabled 模型。
- acceptance：三渠道流（ds/glm/kimi）跑通，断言各阶段解析到对应厂商渠道 env。

---

## 11. 验收标准

1. 无 `category-routing.json` 时全流程行为与现状一致（回归用例覆盖）。
2. 配置三家渠道 + 目标映射后：sketch 走 Kimi、mvp 走 GLM、其余 4 类（guide/prd/judge/summary）走 DeepSeek——显式逐类配置（见 §4.2），**不依赖** `getFirstEnabledChannel()` 恰为 DeepSeek；gwt 不参与路由。单测断言 env；线上以 `[runAgent]` debug 日志核对，并以脚本断言决策日志 `category_route` 映射为 sketch→kimi、mvp→glm、guide/prd/judge/summary→deepseek，替代纯人工核对。 <!-- fix: ATK-G-001 --><!-- fix: ATK-F-005 --><!-- fix: ATK-U-004 -->
3. 任一厂商渠道故障：该类别自动切备用（按 `fallback_channel_ids` 顺序优先）重试，决策日志落 `runtime_channel_switch`，不静默。
4. 删除被路由引用的渠道：设置页出现悬空警示，运行回退全局默认，不崩溃。

---

## 12. 决策记录（2026-08-19 评审确认）

| 问题 | 决策 |
|---|---|
| GLM 渠道形态 | `zhipu-coding`（智谱 Anthropic 兼容） |
| `fallback_channel_ids` 进第一版 | 进 |
| 设置 UI 位置 | ChannelSettingsPage 内新增「职责分工」区 |
| 路由粒度 | 只做全局，不做按项目覆盖 |
