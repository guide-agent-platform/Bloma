# 自动化工具入口

当前运行工具按职责使用，具体参数以对应脚本头部及当前实验配置为准。

| 入口 | 用途 |
| --- | --- |
| scripts/start.mjs | 本地依赖检查、构建和启动 |
| scripts/dispatch-experiment.mjs | 实验冻结、恢复、模型矩阵与报告 CLI |
| scripts/dispatch-experiment-native.mjs | 独立 home 的原生界面实验驱动 |
| scripts/prepare-parallel-pilot.mjs | 按明确模型配置准备新 cohort |
| scripts/inspect-production-prompts.mjs | 检查实际制作提示词装配 |
| scripts/recall-rebuild.ts | 复用现行 schema 的检索索引重建 |
| scripts/source-size-report.mjs | 可配置源码尺寸审查报告 |
| scripts/vision-diagnose.mjs、bloma-vision-mcp.cjs | 显式凭据和模型下的图像诊断与截图 |
| scripts/channel-key-reader.cjs | 获授权的旧实验兼容解密入口；不输出密钥片段，调用者负责独立临时文件与清理 |

已删除固定账号/模型的多厂商脚本、自动提交推送脚本、旧检索原型、失效经验库采集和灰度入口。不要按旧文档恢复这些入口；当前实验使用自己的明确配置、请求保护和独立运行封存。

旧 bench 读取和历史报告对应旧 Web 协议，不代表当前 Python 桌面质量。原始样本、报告及失败证据保留原版本。

Git 提交、推送与建立 PR 分开执行。预演和源码审查不需要读取渠道密钥，也不自动执行付费模型调用。
