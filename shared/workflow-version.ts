/** Both versions share the short guide and Pi loop. The version selects the
 * available engineering/delivery contract, never a second model runtime. */
export type ModernWorkflowVersion = 'lean-v1' | 'software-v1'
export function isModernWorkflowVersion(value: unknown): value is ModernWorkflowVersion {
  return value === 'lean-v1' || value === 'software-v1'
}
