# -*- coding: utf-8 -*-
# 一次性脚本：dispatcher-phases.ts implement 段任务书改写 + extraTools（LF 文件）
import sys

PATH = "main/desktop/dispatcher-phases.ts"
src = open(PATH, encoding="utf-8", newline="").read()

OLD = """    taskTemplate:
      '续接骨架委派实现真实桌面程序：\\n' +
      '1. 按 PRD 背板功能清单实现（驱动断言逐条变绿）；\\n' +
      '2. 产出 DELIVERY.md——运行方式 / 依赖安装 / 已知限制 / 驱动执行入口。',
    outputPath: '',
    constraints: [
      '每实现一个功能必须先有对应驱动断言（禁止无断言的实现）',
      '实现与骨架同一委派线续接（上下文不换人）',
    ],
    requiresUserConfirmation: true,
    retryLimit: 2,
    next: 'desktop-verify',
    gates: [
      {
        id: 'delivery-doc',
        kind: 'artifact',
        description: '交付说明存在（DELIVERY.md）',
        artifacts: ['DELIVERY.md'],
      },
      {
        id: 'implement-confirm',
        kind: 'manual',
        description: '实现产物经用户预览确认后方可推进验证',
      },
    ],
    extraTools: [],"""

NEW = """    taskTemplate:
      '续接骨架委派实现真实桌面程序：\\n' +
      '1. 按 PRD 背板功能清单实现，驱动断言与实现静态自洽（断言先行、真实调用被测代码、禁止平凡通过）；\\n' +
      '2. 真实红绿反馈：收口前用 run_project_driver（平台收口 spawn，本阶段唯一执行通道——子会话无 shell 是设计而非故障）跑一次驱动，失败清单交同一委派线修复后复跑；不要因「无法执行驱动」阻塞、编造或向用户索要本机运行；\\n' +
      '3. 产出 DELIVERY.md——运行方式 / 依赖安装 / 已知限制 / 驱动执行入口。',
    outputPath: '',
    constraints: [
      '每实现一个功能必须先有对应驱动断言（禁止无断言的实现）',
      '实现与骨架同一委派线续接（上下文不换人）',
    ],
    requiresUserConfirmation: true,
    retryLimit: 2,
    next: 'desktop-verify',
    gates: [
      {
        id: 'delivery-doc',
        kind: 'artifact',
        description: '交付说明存在（DELIVERY.md）',
        artifacts: ['DELIVERY.md'],
      },
      {
        id: 'implement-confirm',
        kind: 'manual',
        description: '实现产物经用户预览确认后方可推进验证',
      },
    ],
    extraTools: ['run_project_driver'],"""

if OLD not in src:
    print("MISS: implement block")
    sys.exit(1)
src = src.replace(OLD, NEW, 1)
open(PATH, "w", encoding="utf-8", newline="").write(src)
print("OK: implement taskTemplate + extraTools")

# dispatcher-loop.ts 装配
PATH2 = "main/desktop/dispatcher-loop.ts"
src2 = open(PATH2, encoding="utf-8", newline="").read()

OLD2 = """export function buildDispatcherTools(projectId: string): AgentLoopTool[] {
  const readonly = buildAgentTools({ projectId, role: 'research' }).filter((t) => READONLY_TOOL_NAMES.has(t.name))
  return [...readonly, ...buildDelegationTools('parent'), buildWebResearch(projectId)]
}"""
NEW2 = """export function buildDispatcherTools(projectId: string): AgentLoopTool[] {
  const readonly = buildAgentTools({ projectId, role: 'research' }).filter((t) => READONLY_TOOL_NAMES.has(t.name))
  // run_project_driver：常驻装配、阶段白名单放行（ada13257 根治——implement 真实红绿通道；
  // 其余阶段被 checkDispatcherToolGate 拦截教育）。工具本体在 driver-runner-tool.ts。
  return [...readonly, ...buildDelegationTools('parent'), buildWebResearch(projectId), buildProjectDriverRunnerTool(projectId)]
}"""

if OLD2 not in src2:
    print("MISS: buildDispatcherTools")
    sys.exit(1)
src2 = src2.replace(OLD2, NEW2, 1)

# import 行（挂在 probe 工具 import 附近——按现有 import 块锚点追加）
IMP_ANCHOR = "import { findProject } from '../project/project-service'"
if IMP_ANCHOR not in src2:
    print("MISS: import anchor")
    sys.exit(1)
src2 = src2.replace(IMP_ANCHOR, IMP_ANCHOR + "\nimport { buildProjectDriverRunnerTool } from './driver-runner-tool'", 1)
open(PATH2, "w", encoding="utf-8", newline="").write(src2)
print("OK: dispatcher-loop assembly + import")
print("all done")
