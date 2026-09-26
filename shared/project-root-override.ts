/**
 * 项目根覆盖上下文（2026-09-26 运行审计 P1-06 收尾：独立 worktree 隔离的宿主地基）。
 *
 * 背景：Bloma 的委派子会话与父会话同进程、同 project 目录（写 lease 只防同文件并发写）。
 * 审计机制改动第 3 项「高自由度实现用独立 worktree/分支，父会话负责合并」要求子会话
 * 在**独立工作树**上工作——这需要子会话的全部工具（读/写/预览/验证）把「项目根」
 * 解析到 worktree，而不是项目主目录。
 *
 * 本模块用 AsyncLocalStorage 承载覆盖值（按异步链天然隔离：并发子会话各持自己的
 * worktree，互不串扰），是 kernel 层纯内存原语（不做 IO、不依赖 domain）。
 * 工具面统一经 `resolveProjectRoot(projectId, fallback)` 解析根——覆盖存在即走覆盖。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const overrideStorage = new AsyncLocalStorage<string>()

/** 当前异步链的项目根覆盖（无覆盖返回 undefined）。 */
export function getProjectRootOverride(): string | undefined {
  return overrideStorage.getStore()
}

/** 在指定项目根覆盖下执行（子会话 loop 及其工具构造/执行全链）。 */
export function runWithProjectRootOverride<T>(root: string, fn: () => T): T {
  return overrideStorage.run(root, fn)
}

/**
 * 解析项目根：覆盖优先，无覆盖走调用方给定的 fallback（通常是
 * `() => findProject(projectId).root_path`）。fallback 以函数传入——kernel 不依赖
 * domain 的项目服务（依赖倒置）。
 */
export function resolveProjectRoot(_projectId: string, fallback: () => string): string {
  return overrideStorage.getStore() ?? fallback()
}

/** 是否处于项目根覆盖下（隔离模式；工具面据此裁剪绑主根的验证工具）。 */
export function hasProjectRootOverride(): boolean {
  return overrideStorage.getStore() !== undefined
}
