# Bloma 五阶段三格小漫画

2026-10-26。使用内置 `image_gen` 生成，统一沿用用户认可的“发现异常 → 追赶 bug → 抓住它”三格漫画风格：淡彩线稿、同一成年角色、镜头变化及小反转。

验证条已获用户认可；本次补齐的需求、界面、制作、交付四条为待查看素材。没有接入正式 UI。

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

本批沿用已认可的验证图作为角色、线条、纸感、分镜参考。不同阶段通过情节与动作区分，不再统一使用“坐在桌前换道具”。漫画是进程条悬停内容的候选，实际阶段状态仍应由执行事件提供。
