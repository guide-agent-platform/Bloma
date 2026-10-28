/** Discovery metadata only. Full protocols remain behind the context tool. */
export const SOFTWARE_CONTEXT_CATALOG = [
  { name: 'commands', when: '安装、构建、测试或持续日志/输入', topic: 'execution', tools: ['run_command','read_process','write_process','stop_process'] },
  { name: 'runtime', when: '运行时缺失、版本不兼容或入口不确定', topic: 'launch', tools: ['inspect_software_environment','prepare_software_environment'] },
  { name: 'ui-testing', when: '真实界面操作、重开或定位失败', topic: 'verification-gui', tools: ['inspect_app','verify_app'] },
  { name: 'model-client', when: '产品需要模型请求、配置或错误处理', topic: 'verification-llm', tools: ['verify_app'] },
  { name: 'speech', when: '语音资源、转写或录音', topic: 'verification-speech', tools: ['inspect_software_capabilities','prepare_software_capability'] },
  { name: 'data-update', when: '用户数据迁移、备份与版本兼容', topic: 'data-update' },
  { name: 'delivery', when: '分发、打包或独立环境资格', topic: 'delivery' },
  { name: 'working-state', when: '续跑、压缩后恢复或避免重复排障', topic: 'working-state' },
] as const
