# 人物参与决策节点：实施与验收

日期：2026-10-18。基线 `d4e3939`，本批在该版本上接入已确认的人物交互方案。

## 用户决定与最终行为

- 澄清需求：人物托起选项的姿态先出现，真实选项卡从人物一侧展开。继续使用原有选项、开放回答和回传逻辑。
- 需求清单与 PRD 确认：人物展开需求册，带出真实确认内容。保留需求勾选、市调想法、PRD 全文、逐条反馈、修改池、稍后再说和确认动作。
- 用户补充认为 PRD 人物偏小，本批将此节点人物栏由 225px 放大到 300px，画面高度上限由 420px 增至 540px；总宽度由 1100px 增至 1180px，保持正文阅读空间。窄窗口自动改为紧凑排布。
- 草图确认：预览边缘只显示人物与“草图准备好啦，看看是不是你想要的？”；只有收起提醒按钮，无新遮罩、不新增确认按钮。原预览与原确认操作保持可用。
- 人物呈现为新姿态图片配合短暂进场、内容展开动画。无骨骼或逐帧角色动画。点击、键盘输入会结束展开动画；系统减少动态效果时静态展示。
- 当前窗口生命周期内，同一内容的决策动画只播放一次；收起草图提醒后切换视图再回来不重复出现。标记为限长 sessionStorage 哈希，无需求正文；存储不可用时退化为内存标记。重启后的再次展示不属于业务状态恢复。

## 实现入口

`renderer/components/CharacterDecisionStage.tsx` 包裹三个现有决策卡；`SketchCharacterReminder.tsx` 提供草图轻提醒；`use-character-reveal.ts` 只负责可取消的呈现动画；`character-cues.ts` 管理展示标记；`character-cues.css` 提供大小和响应式排布。

`WorkspaceShell.tsx` 同时识别旧 `sketch_ready` 和当前 `ux_confirm_go` 确认动作，仅在有草图、空闲且没有其他需求/资料面板时出现提醒；MVP 确认不会被误判。真实业务提交仍使用原有处理器。

本地上游参考：`proma-upstream` 的 `bf3e98c`，参考其 `sidebar-atoms` 本地布局偏好与有界会话布局缓存思路。本批适配为仅记录人物呈现标记，不替代业务持久状态，不整体引入上游布局。

## 素材与生成方式

使用内置 `image_gen`，以 `resources/studio/guide-neutral.webp` 作为人物身份、服装及画风参考，生成三种新姿态。原始 PNG 保存在 `$CODEX_HOME/generated_images/01a14e84-f7fe-7dc3-9736-0cc9e1127456/`。入库 WebP 仅经浏览器 Canvas 编码，保留透明通道及 1024×1536 尺寸，没有重绘、裁切或替换原图。

| 用途 | 最终项目路径 | 文件大小 |
| --- | --- | --- |
| 澄清选项 | `resources/studio/guide-clarify-v2.webp` | 154062 bytes |
| 需求及 PRD | `resources/studio/guide-prd-v2.webp` | 131618 bytes |
| 草图提醒 | `resources/studio/guide-sketch-v2.webp` | 132036 bytes |

完整原始提示词（公共身份约束与各姿态动作拼接后的三组文本）、生成方法、参考图、来源文件名与最终 SHA-256 均记录在 `resources/studio/guide-poses-v2.manifest.json`。核心约束是保持成年女性人物身份与原服装，分别托起三张选项卡、展开需求册、指向左侧草图；透明背景，无可读文字和水印。

## 本次验证

- 相关单测及架构规则：9 文件、58 项通过，覆盖真实选项回传、需求子集、PRD 修改池及失败恢复、不会自动提交、StrictMode、重访不重播、减少动态效果、草图/MVP 区分，以及既有会话栏拖动行为。
- `npm run typecheck`、完整 `npm run build` 通过；人物放大后重新构建 renderer。
- `scripts/verify-character-decisions.mjs`：隔离 home/user-data 的真实 Electron 窗口验证。操作真实卡片、回传选项与勾选子集、输入并提交 PRD 修改意见、收起草图提醒、点击原确认动作；人物覆盖区域的浏览器命中目标仍是原 iframe。验证 800/480 内容宽度及矮窗口的长 PRD 滚动与关闭，页面异常为 0。
- 原生窗口测试使用离线 IPC 回应和注入事件，无模型调用；它证明呈现与输入接线，不代表新一轮模型生成质量已验收。

证据目录：`run-artifacts/character-decisions/`。日志为 `unit.log`、`typecheck.log`、`build.log`、`build-renderer.log`、`native.log`；最终结果为 `native-report.json`，截图为 `clarification.png`、`requirements.png`、`prd.png`、`sketch-reminder.png`、`narrow-prd.png`。

验收过程发现并修正了弹窗 content-box 造成的窄窗口宽度溢出。最初测试夹具漏发任务终态，补齐与真实 `runAgent` 一致的 `completed` 后提醒正常出现，没有修改全局运行状态归约。原始夹具失败报告另存 `incomplete-fixture-report.json`；`initial-failure.png` 为过程诊断截图，不属于最终成功证据。额外的 iframe 合成按钮探针坐标验证不可靠，最终采用浏览器原生命中测试验证人物区域的指针穿透，不将该探针当作业务失败或成功。

## 使用

当前构建已更新；用户现有 Bloma 进程重启后加载。验收用隔离实例已退出，不会启动真实项目的生成或确认任务。
