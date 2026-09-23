/**
 * 向导服务核心（PR4a 拆解后）：本文件不再承载实现，能力按流拆入 stages/。
 * 对外导出面与拆解前完全一致（re-export hub）——importer 与 vi.mock 语义零变化。
 * 流：guide-runtime / clarify-flow / guide-pipeline / requirement-confirm / research-flow / prd-pipeline。
 */
export * from './stages/guide-runtime'
export * from './stages/clarify-flow'
export * from './stages/guide-pipeline'
export * from './stages/requirement-confirm'
export * from './stages/research-flow'
export * from './stages/prd-pipeline'
