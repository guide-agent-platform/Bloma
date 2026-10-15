// Preparation follows both renderer card families. The desktop platform is fixed;
// delegated choices preserve the existing request instead of introducing a web path.
export function selectPreparationChoice(choices) {
  const enabled = choices.filter(choice => choice.visible && choice.enabled && typeof choice.id === 'string')
  const desktop = enabled.find(choice => /^(桌面程序|桌面应用|本地桌面程序)/.test(choice.text?.trim() ?? ''))
  if (desktop) return desktop.id
  const delegate = enabled.find(choice => choice.id === 'clarification-option-auto'
    || /^(你帮我决定|你帮我定|交给你|按推荐|委托|直接生成)/.test(choice.text?.trim() ?? ''))
  return delegate?.id
}

export function assertPreparationResume(project, config) {
  if (!project?.project_id || project.project_id !== config?.project_id || config.state !== 'prepare') {
    throw new Error('EXPERIMENT_PREPARATION_NOT_RESUMABLE')
  }
}

export function preparationTokenCap(command, value) {
  if (value === undefined) return 640000
  const cap = Number(value)
  if (command !== 'prepare' || !Number.isSafeInteger(cap) || cap < 1024 || cap > 640000) {
    throw new Error('EXPERIMENT_INVALID_PREPARATION_TOKEN_CAP')
  }
  return cap
}

export function selectClarificationAnswer(question, answers) {
  const matching = answers.filter(answer => Array.isArray(answer.contains) && answer.contains.length
    && answer.contains.every(part => typeof part === 'string' && part && question.includes(part))
    && typeof answer.answer === 'string' && answer.answer.trim())
  return matching.length === 1 ? matching[0].answer : undefined
}
