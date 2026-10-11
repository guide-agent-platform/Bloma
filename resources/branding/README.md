# Bloma 临时品牌图标

2026-10-11 用户指定「霓虹AI自动化流程图标.png」暂作 Bloma 图标。`icon.png` 是原文件的完整副本，尺寸 1254×1254，保留原透明度和构图；SHA-256：`1535DA9402378C9929264FD3D4970E9D34A368F555B7994691E9B349F6F8108A`。不改变白色界面主题。

使用位置：工作区与新建项目页品牌标识、页面 favicon、主窗口图标、托盘图标。`icon.ico` 包含 16/24/32/48/64/128/256 七种尺寸；托盘 PNG 在 `../tray/icon16.png` 与 `icon32.png`。机械缩放与格式转换脚本为 `scripts/prepare-brand-icon.ps1 -Source <原图路径>`，不裁切、重绘或调色。

主窗口按平台选择 ICO 或 PNG，寻找仓库 `resources/branding` 或打包资源目录 `branding`。参考本地 Proma 上游 `bf3e98c` 的主窗口图标格式选择与存在性检查；适配 Bloma 当前 esbuild 入口及 Windows 目标，不照搬其资源复制/多平台打包设置。未来安装包需纳入该资源目录并设置其可执行文件图标；本次未构建安装包、修改现有快捷方式或替换 Electron 可执行文件。

本次类型检查与构建通过；受影响页面现有测试 2 文件/8 用例通过。独立 Electron 初始页真实图片及 favicon 加载通过，原生 PNG 与 16/32 托盘图片解码通过，ICO 七尺寸检查和 Windows 图标解码通过，页面异常 0。证据：`run-artifacts/brand-icon-typecheck.log`、`brand-icon-build.log`、`brand-icon-tests.log`、`brand-native/report.json`、`brand-native/brand.png`。探针首次错误假定素材为 1280 像素，已改为从 PNG 文件读取实际尺寸；该失败不代表资源加载故障。

用户原实例与数据未操作，独立测试实例已关闭。窗口图标接线与资源已完成，但未单独自动读取 Windows 任务栏/托盘最终像素或验证安装包快捷方式。正常重新打开 Bloma 后加载本次改动。
