import { findProject } from '../project/project-service'
import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import type { DesktopRouteDeps } from './desktop-route'

/** Common check used by quick delivery, longterm review and final confirmation. */
export async function ensureCoreDelivery(input: { projectId: string; sessionId: string; requestId: string }, deps: DesktopRouteDeps): Promise<boolean> {
  const result: CoreVerificationResult = await (deps.coreVerification
    ? deps.coreVerification(input.projectId)
    : runCoreVerification({ projectId: input.projectId, sandboxRoot: findProject(input.projectId)?.root_path }))
  if (result.status === 'passed') return true
  deps.publish(input, 'message_delta', { text: `${result.summary}\n${result.missing.slice(0, 3).join('\n')}` })
  deps.persistSystem(input.sessionId, `[decision] core-verification ${result.status}: ${result.missing.join('; ')}`)
  deps.complete(input.sessionId, input.projectId, 'incomplete')
  return false
}
