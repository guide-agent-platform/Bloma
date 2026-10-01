/**
 * 编排器核心（PR4b 拆解后）：本文件不再承载实现，能力拆入 stages/。
 * 对外导出面与拆解前完全一致（re-export hub）——importer 与 vi.mock 语义零变化。
 * 件：run-registry / sdk-glue / ready-chat / agent-dispatch / lifecycle / persistence / dispatch-support / intent-routing。
 */
export * from './stages/orchestration-contracts'
export * from './stages/run-registry'
export * from './stages/sdk-glue'
export * from './stages/agent-dispatch'
export * from './stages/lifecycle'
export * from './stages/persistence'
export * from './stages/dispatch-support'
export * from './stages/intent-routing'
