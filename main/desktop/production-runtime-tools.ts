/** Shared legacy-runtime tooling retained until old projects have a copy migration. */
import type {AgentLoopTool} from '../agent/loop/agent-loop'
import type {DelegationRunRole} from '../../shared/delegation-run-context'
import {buildAgentTools} from '../agent/tools/agent-tools'
import {buildDomainTools} from '../coding/tool-handlers'
import {buildResourceDiscoveryTool} from './resource-discovery'
import {buildProductionContextTool} from './production-context'
import {buildChildScriptRunnerTool} from './child-exec-tool'
import {buildInstallPackagesTool} from './install-packages-tool'
import {buildDriveAppTool} from './drive-app-tool'
import {DEFAULT_DESKTOP_EXECUTION_LIMITS,type DesktopExecutionLimits} from './execution-limits'
import {execFileProbeSpawn,isDesktopEnvReady,probeDesktopEnv,type ProbeSpawn} from './check-env'


/**
 * 桌面线子会话工具集（首跑深修 2026-09-26）：真实工程件皆产物——项目内除基础设施
 * 目录（node_modules/.git/data-backups）外皆可写。原缺省走 web 静态规则（src/ 子树 +
 * .html/.js/.css），会拒绝 00_ARCH/*.md|.json、.py 等桌面交付物（首跑实证：门禁
 * 产物写不进去，架构子会话只能写探测文件）。realFullstackVariant 语义即「真实工程件」，
 * 命名沿用既有选项，后续统一。
 *
 * 安全门禁装配（全链路审查 P0-2，2026-10-01）：桌面线产物含在本机真实 spawn 执行的
 * Python（driver/scaffold）——implement/custom 子会话拼接 buildDomainTools 获得
 * run_security_scan（扫描器已扩 .py 与 Python 危险调用硬红线），生成方必须自扫自修；
 * worktree 隔离模式下 buildDomainTools 返回空（验证归父会话，防假验证，语义不变）。
 */
export function buildDesktopChildTools(projectId: string, role: DelegationRunRole, editFormat: 'diff' | 'whole', limits: DesktopExecutionLimits = DEFAULT_DESKTOP_EXECUTION_LIMITS): AgentLoopTool[] {
  return [
    buildResourceDiscoveryTool(projectId),
    buildProductionContextTool(projectId),
    ...buildAgentTools({ projectId, role, editFormat, realFullstackVariant: true }),
    ...buildDomainTools({ projectId, role, editFormat, realFullstackVariant: true }),
    // 方案 B（2026-10-05）：implement 子会话受控执行刀——quick 无契约时真实红绿
    // 自测的唯一通道（eba1cb83 实证：4 个自测脚本写了没门跑）；仅 implement 角色装配。
    // 迁移批同族加 install_packages（声明制 venv 安装，P1 依赖自由度）。
    ...(role === 'implement' || role === 'custom'
      ? [buildChildScriptRunnerTool(projectId, { maxRuns: limits.script_runs }), buildInstallPackagesTool(projectId, { maxCalls: limits.install_calls })]
      : []),
    // 探索驱动测试 A 档（2026-10-05，实施稿预审修订版）：research 子会话装配驱动桥。
    // 探索者与 implement 结构性分离（反自证）：只读面 + 驱动面，无任何写工具；
    // 不进调度员常驻面（探索由 verify 编排器委派，见 dispatcher-phases verify 任务书）。
    ...(role === 'research' ? [buildDriveAppTool(projectId)] : []),
  ]
}


/**
 * 桌面环境探测工具（首跑深修）：在真实主机执行 env 探测并回读结果——desktop-arch
 * 环境清单 [实证] 的唯一实测来源（此前子会话无任何执行通道，只能阻塞或编造）。
 * 探测项/三分类/超时复用 check-env；spawn 可注入（测试桩零真实子进程）。
 */
export function buildDesktopEnvProbeTool(spawn: ProbeSpawn = execFileProbeSpawn): AgentLoopTool {
  return {
    name: 'probe_desktop_env',
    description:
      '在真实主机探测 Windows 桌面开发环境（python 版本 / venv 模块 / PyInstaller 打包器），' +
      '逐项返回真实命令、状态（ok/not-found/timeout/exec-failed）与输出。' +
      'desktop-arch 环境清单与选型结论的 [实证] 来源；失败项按分类如实报告，不要编造。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      const results = await probeDesktopEnv(spawn)
      const lines = results.map(
        (item) => `- ${item.id}: ${item.status}${item.version ? ` (v${item.version})` : ''}｜${item.detail}｜命令: ${item.probeCommand}`,
      )
      return {
        output: `桌面环境探测结果（真实执行，非推断）：\n${lines.join('\n')}\n就绪判定（三项全 ok）：${isDesktopEnvReady(results) ? '是' : '否'}`,
        detail: { results },
      }
    },
  }
}
