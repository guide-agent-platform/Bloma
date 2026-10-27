/** Persisted short-guide formats remain readable. Execution policy separately
 * permits software-v1; recognizing lean-v1 never upgrades or executes it. */
export type ModernWorkflowVersion = 'lean-v1' | 'software-v1'
export function isModernWorkflowVersion(value: unknown): value is ModernWorkflowVersion {
  return value === 'lean-v1' || value === 'software-v1'
}
