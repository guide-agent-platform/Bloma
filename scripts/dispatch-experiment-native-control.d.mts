export function cancelExperimentProject(input: { projectId: string; sessionId: string }): Promise<{ cancelled: boolean; session_id: string }>
