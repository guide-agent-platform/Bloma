---
name: ac-audit
description: Bloma 验收标准审计 SOP——多角色对抗审查（Attacker/Defender/Reviewer）与多数决裁决流程（C 测试/研究视角）
---

# 验收标准审计 SOP

## 1. 审查对象与上下文包
- 确定功能名 + 改动文件清单（git diff / git status）
- 生成审查上下文包：功能意图、涉及文件、相关测试、docs 锚点
- 不透露实现推理细节（对抗式独立视角，避免锚定）

## 2. 三角色对抗
| 角色 | 视角 | 职责 |
|---|---|---|
| Attacker | 破坏性 | 六维攻击（正确性/边界/安全/IPC/测试缺口/可维护性），只读 |
| Defender | 建设性 | 逐条 accept/refute/clarify，给最小修复方案，只读 |
| Reviewer | 中立 | 裁决 upheld/dismissed/escalate，输出按严重度排序的修复清单 |

- 三角色必须独立上下文，不可复用会话
- 多厂商模型承担：Attacker=deepseek / Defender=glm / Reviewer=qwen（`scripts/multi-vendor-run.mjs`）

## 3. 收敛与执行
- 父会话读 Reviewer 清单逐条评估采纳；文件变更只由父会话执行
- 每修一项重跑相关测试；完成标准 = 原缺陷测试转绿 + typecheck + 回归全绿
- escalate 项报告用户，不自行决断
