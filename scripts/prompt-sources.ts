import { describePromptSource } from '../main/agent/prompting/prompt-config'
import { writeFileSync } from 'node:fs'
const home = process.argv[2]
if (!home) throw new Error('Explicit Bloma home required')
process.env.PROMA_HOME = home
const report = { captured_at: new Date().toISOString(), scope: 'configured override/default precedence; actual rendered system hash is recorded per SDK request',
  sources: ['sketch-system', 'loop-system'].map(describePromptSource) }
writeFileSync('run-artifacts/robustness-prompt-sources.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
