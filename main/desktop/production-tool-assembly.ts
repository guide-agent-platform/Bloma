import type {AgentLoopTool} from '../agent/loop/agent-loop'
import {buildDelegationTools} from '../agent/delegation/delegation-tools'


export function productionAgentTools(executorTools: AgentLoopTool[], extraTools: AgentLoopTool[]): AgentLoopTool[] {
  const tools = [...executorTools.filter(tool => tool.name !== 'ask_delegation_question'), ...buildDelegationTools('parent'), ...extraTools]
  return [...new Map(tools.map(tool => [tool.name, tool])).values()]
}
