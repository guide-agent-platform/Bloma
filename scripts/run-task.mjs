#!/usr/bin/env node
/**
 * run-task.mjs — orchestrator 的 detached 执行包装器
 * 用法: node run-task.mjs <exitMarkerPath> -- <命令> [参数...]
 * 职责: 跑真实执行器，退出后把退出码写 marker（orchestrator 下轮醒来据此收口）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const sep = process.argv.indexOf('--')
const marker = process.argv[2]
const [cmd, ...args] = process.argv.slice(sep + 1)
const child = spawn(cmd, args, { stdio: 'inherit', detached: false })
child.on('exit', (code) => {
  try { writeFileSync(marker, String(code ?? 1), 'utf8') } catch {}
  process.exit(0) // 包装器正常退场；marker 存在即任务结束信号
})
