# 官方功能模块库（Official Modules）—— VibeGame 借鉴第三层 / P1 模块侧

> 2026-09-04。给编程 Agent 提供「经过验证的可复用实现参考」：系统在 loop 启动前把适用
> 当前产物类型的官方模块确定性物化到项目 `src/official-modules/{slug}/`（纯 fs，无 LLM），
> 模块地图随 system prompt 注入；Agent 按地图 read_file 后复制源码到业务文件按需改编。

## 动机与边界

- 对齐 VibeGame 模板体系第三层（自进化沉淀的可复用模块库）的**模块侧**；自动蒸馏器（P1 主体）二期再议。
- 首期模块内容为**预置手写参考实现**（素材取自既有「常见模式范式」章、骨架示例、learnings 沉淀纪律），
  真实行为验证由 Agent 接入后的 GWT 断言兜底——与「从验收项目蒸馏」的差距已知，后续可引入真实项目回流。
- 产物形态约束：vanilla ES2022、无框架、无外部依赖（CSP connect-src none）、`index.html + src/app.js`
  （web_fullstack 与 game 同构；game 为 canvas/rAF 原生，无 Phaser）。

## 机制（复用 PR-1 骨架先行哲学，事实与注入同源 + fail-open）

| 环节 | 实现 |
|---|---|
| 源目录 | `main/templates/official-modules/{category}/{slug}/`，每模块 `module.json` + 源码（`.js`/`.css`） |
| 加载 | `loadOfficialModules(type)`（main/module-library.ts）：扫描全目录，按 `categories.includes(type)` 过滤；单模块非法 → 归 `rejected` 不阻断 |
| 校验 | slug=目录名且小写 kebab、name/summary/whenToUse/whenNotToUse 齐全、categories 为合法 TemplateType、files 路径安全（无 `../`、后缀白名单）、文件存在、`.js` 无外链依赖（`import 'https?` / fetch / XHR / WebSocket / EventSource） |
| 物化 | `renderOfficialModulesToProject` → 项目 `src/official-modules/{slug}/`，幂等（存在跳过不覆盖） |
| 只读 | agent-tools `READONLY_DIR_PREFIXES` 追加 `src/official-modules/`（软保护，同 examples） |
| 注入 | `buildModuleMapInjection` 生成「模块地图」，独立于骨架地图随 loop system 注入（`buildAgentLoopSystemPrompt` 第 6 参 `moduleMap`；plan 腿经 `mergeAssetMap` 拿到骨架+模块全貌） |
| 开关 | `BLOMA_MODULES`（缺省开；0/off/false 关=现状字节级） |
| 决策日志 | `module_rendered` / `module_render_failed` / `module_rejected`（DecisionType 新增 3 项） |

**关键设计点**：模块地图与骨架地图**分离传参**——`【产物形态】` 判断仍只看骨架地图（`skeletonMap`），
避免「无骨架但有模块」的类型（personal_tool/desktop_tool）被误判为「有构建门禁」而误导 Agent 使用 ESM import。

## 首批模块清单（8 个）

**Web 通用**（categories：web_fullstack / personal_tool / desktop_tool）

| slug | 名称 | 一句话 |
|---|---|---|
| storage-state | 本地状态持久化 | localStorage 键值封装：命名空间/JSON 容错/防抖落盘/存储不可用降级内存 |
| modal-dialog | 弹层与确认框 | 原生 DOM：confirm/alert、Esc/遮罩关闭、焦点管理、Promise 返回 |
| form-validation | 表单校验 | 声明式规则（必填/类型/长度/正则/邮箱/数值范围），结构化错误 + DOM 绑定 |
| filter-list | 搜索过滤列表 | 数据层：防抖搜索/过滤条件/排序/空态判断，渲染分离 |

**游戏类**（categories：game）

| slug | 名称 | 一句话 |
|---|---|---|
| game-loop | 游戏主循环 | rAF：update/render 分离、delta 时间、暂停/恢复/销毁 |
| fsm-state | 显式状态机 | 状态表 + 单入口切换 + 进入/离开/更新钩子 |
| input-control | 键盘输入 | 按下/边沿检测、WASD+方向双通道、触摸虚拟键兜底 |
| aabb-collision | AABB 碰撞 | 相交检测/碰撞对枚举/最小穿透推出，检测与响应分离 |

注：storage-state categories 含 game（游戏最高分/存档），故 game 类型实际可用 5 个模块。

## 线上待验（不阻塞提交）

- web_fullstack / game 各跑一次 quick MVP：验证 Agent 能按地图取用模块、只读目录不被改写、
  复制改编后构建门禁无 `official-modules` 残留引用、产物自包含。
- `BLOMA_MODULES=0` 时 system prompt 与骨架先行前现状字节级一致（回归锁）。

## 范围外（本批不做）

- 自动蒸馏器（P1 主体）、外置模块覆盖（~/.proma/modules）、模块间依赖图、模块进入 GWT/安全扫描差异化、react/tsx 工程骨架。
