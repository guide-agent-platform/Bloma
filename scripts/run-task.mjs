#!/usr/bin/env node
/**
 * run-task.mjs — orchestrator 的 detached 执行包装器
 * 用法: node run-task.mjs <exitMarkerPath> -- <命令> [参数...]
 * 职责: 跑真实执行器，退出后把退出码写 marker（orchestrator 下轮醒来据此收口）。
 *
 * detached: true 是**硬要求**（2026-09-12 实跑事故）：执行器必须脱离父控制台，
 * 否则 Agent 侧任何 Ctrl+C/控制台关闭信号会顺着进程组杀掉长跑扫描
 * （实测 exit code 3221225786 = STATUS_CONTROL_C_EXIT，跑 5 分钟即死）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const sep = process.argv.indexOf('--')
const marker = process.argv[2]
const [cmd, ...args] = process.argv.slice(sep + 1)
const child = spawn(cmd, args, { stdio: 'inherit', detached: true, windowsHide: true })
child.on('exit', (code) => {
  try { writeFileSync(marker, String(code ?? 1), 'utf8') } catch {}
  process.exit(0) // 包装器正常退场；marker 存在即任务结束信号
})
