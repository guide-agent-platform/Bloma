# 星屿画室正式接入

日期：2026-10-13。实施前 HEAD `9ba2663`。用户确认成年人物、淡紫画室与 fumo 形象，要求直接应用到程序；随后明确 fumo 只保留形象，不加动作。本批不推进科学实验或真实模型生成任务。

## 最终行为

- 首页、项目列表、工作区、设置页采用同一侧栏与淡紫/鼠尾草绿的白色画室外观。主页面可进入已有项目；最近项目来自真实项目列表，没有演示项目或虚构进度。
- 首页选择快速/长期模式只更新本地选择；点击「开始制作」才走原有 `project.create` 和初始想法提交链。保留创建失败提示、busy 禁用与同步 ref 防重复。首页未提交想法和模式在设置/项目列表往返中保留。
- 人物采用用户确认的成年默认、轻微歪头抬手、脸红举拳三张姿态。普通点击回应，4.5 秒内连续五次点击进入佯怒；回应 1.8 秒、佯怒 3.6 秒后恢复，佯怒时再点击不会无限延长。卸载清理定时器，按系统减少动态效果偏好关闭姿态过渡。动作不调用模型或修改项目。
- fumo 仅为侧栏、聊天头像、项目空状态中的静态图片，不挂载按钮、点击反应或动作定时器。
- 草图确认的主按钮移至工作区页脚，继续调用原确认处理。资料、材料、版本、协作与真实状态、归档/导出/改名/删除保留。画布宽高适应、完整文档测量与缩放沿用上一批修复。
- 设置页从主页面进入时返回主页面，从项目列表进入时返回项目列表；原工作区返回路径保持。没有重新挂载草图来实现动画，也没有对消息正文截断。

## 接线与素材

`StudioCompanion.tsx` 管理本地人物反应和静态布偶展示；`StudioPageFrame.tsx` 复用导航与页面框架；`refined.css` 提供批准的外观。首页只重组原业务入口，App 负责真实项目/会话/路由；ProjectHistoryPage 保留现有业务处理。素材与最终提示词见 `resources/studio/README.md`。

按钮的短颜色/阴影过渡与按下反馈沿用此前按件参考的本地 Proma `bf3e98c` `apps/electron/src/renderer/components/ui/button.tsx`，适配到现有 React/CSS/Lucide 组件，没有引入 Radix、Tailwind 或动画库。普通 UI 创建路径和已有 E2E/狗粮入口探针同步为「选模式 → 点开始」，没有执行真实模型狗粮。

## 验证证据

- 类型检查与完整构建通过：`run-artifacts/refined-typecheck-final.log`、`refined-build-final.log`。已更新本地 dist/dist-main。
- 全量单测通过：261 文件、2384 项，`run-artifacts/refined-unit-final.log`。执行在最后的模式选择事件去重和页脚禁用边界收口之前；这些入口改动已补跑下面的定向回归及 `refined-footer-tests.log`，未将旧卡片文案或内部欢迎消息的存在当作当前 UI 成功标准。
- 最终入口检查通过：3 文件、47 项，`run-artifacts/refined-entry-tests-final.log`，覆盖显式开始、初始想法、创建失败/异常/busy、模式选择不创建及既有工作区入口。
- 集成检查通过：2 文件、8 项，`run-artifacts/refined-integration-final.log`。
- `scripts/verify-studio-interface.mjs` 使用独立 PROMA_HOME/user-data、无模型渠道与固定本地草图，真实 Electron 检查通过，页面异常 0。证据 `run-artifacts/studio-refined-native/report.json`、`refined-studio-native-final.log`。
- Electron 验证长草图在四档窗口内完整适配、动态内容增减、缩放后真实鼠标交互、专注/资料切换保持草稿；首页人物回应与五连点佯怒/恢复、fumo 无交互、设置返回来源、项目筛选、首页草稿/模式留存、原生快速双击只创建一个空项目、减少动态效果。最后截图等待图片解码和页面入场结束，避免把初始空图当成功证据。

截图 `home.png`、`home-wave.png`、`home-blush.png`、`projects.png`、`new-workspace.png` 保存于上述 native 目录。未重启用户原有实例，未修改真实项目与实验数据；正常重新打开 Bloma 后加载本次构建。
