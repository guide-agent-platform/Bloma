import { recordManualSpeechComponentAcceptance } from '../main/desktop/speech-verification'
const [home, evidencePath] = process.argv.slice(2)
if (!home || !evidencePath) throw new Error('Explicit Bloma home and completed component evidence required')
process.env.PROMA_HOME = home
recordManualSpeechComponentAcceptance(evidencePath, '用户明确接受本次语音组件测试，确认继续沿用 DeepSeek Harness 桌面端配备的同版模型；自动参考句结果保留原值。')
console.log('Recorded scoped human acceptance; automatic logs unchanged')
