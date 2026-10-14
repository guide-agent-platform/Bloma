/** Shared producer defaults; new experiments freeze these separately from model turns. */
export interface DesktopExecutionLimits { script_runs: number; install_calls: number }
export const DEFAULT_DESKTOP_EXECUTION_LIMITS: DesktopExecutionLimits = { script_runs: 12, install_calls: 4 }
