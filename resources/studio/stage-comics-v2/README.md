# Bloma 五阶段三格小漫画

2026-10-26。使用内置 `image_gen` 生成，统一沿用用户认可的“发现异常 → 追赶 bug → 抓住它”三格漫画风格：淡彩线稿、同一成年角色、镜头变化及小反转。

本组已按用户指令接入正式工作区顶部阶段条。悬停/聚焦显示对应漫画，点击可以固定和放大。完整图保留供精修；`*.thumb.webp` 为运行时使用的 1086×362 缩略图。

| 阶段 | 小剧情 | WebP 素材 | 原始 PNG |
| --- | --- | --- | --- |
| 需求 | 一点点想法 → 清单越拉越长 → 区分本次和以后 | [requirements.webp](requirements.webp) | [requirements.png](../../../outputs/ui-stage-comics-20261026-v2/requirements.png) |
| 界面 | 对齐画稿 → 用力调整 → 界面齐了，帽子歪了 | [design.webp](design.webp) | [design.png](../../../outputs/ui-stage-comics-20261026-v2/design.png) |
| 制作 | 拼上最后一块 → 软件长出腿 → 还真会跑 | [build.webp](build.webp) | [build.png](../../../outputs/ui-stage-comics-20261026-v2/build.png) |
| 验证 | 发现异常 → 追赶 bug → 抓住它 | [verify.webp](verify.webp) | [verify.png](../../../outputs/ui-stage-comics-20261026-v2/verify.png) |
| 交付 | 打包 → 搬运大包裹 → 取出小小的作品夹 | [deliver.webp](deliver.webp) | [deliver.png](../../../outputs/ui-stage-comics-20261026-v2/deliver.png) |

所有素材为 2172×724（3:1）；WebP 仅作同尺寸格式转换，未裁切或重画。原始 PNG 保留供后续精修。

- [本次四条的完整提示词与来源](prompts.json)
- [尺寸、状态和校验值](manifest.json)

本批沿用已认可的验证图作为角色、线条、纸感、分镜参考。不同阶段通过情节与动作区分，不再统一使用“坐在桌前换道具”。实际阶段状态由执行事件提供，漫画不作为验证通过的证据。提示词文件中的 candidate 状态保留生成时记录；当前接入说明见 [实施交接](../../../docs/05_PROJECT_PLAN/ui-workspace-implementation-20261026.md)。
