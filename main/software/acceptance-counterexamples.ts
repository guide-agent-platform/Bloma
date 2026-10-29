/** Design aids, not executable evidence or additional scope. */
export const ACCEPTANCE_COUNTEREXAMPLES = [
  { id: 'historical-step', applies: '同一资料多题、历史步骤追问', setup: '同一资料先问A再问B，两题相同步骤序号但内容不同。', action: '点击A的旧步骤并追问。', expected: '实际请求中的题目、消息身份和步骤内容属于A；B保持原样。', rejects: '按序号取全局最后一题；只检查输入框出现追问字样。' },
  { id: 'cross-document-note', applies: '资料、笔记和AI解释关联', setup: '资料A建立无AI关联的笔记；资料B产生新的AI回答。', action: '回到A查看原笔记，再关闭重开。', expected: 'A的笔记保持未关联，或只显示曾明确保存的A消息；B的回答不进入A。', rejects: '用最后回答兜底旧笔记；只检查卡片含AI文字。' },
  { id: 'forged-citation', applies: '可点引用和资料问答', setup: '准备真实来源块，提供合法块ID但quote写成原文不存在的句子。', action: '通过产品实际回答入口接收引用，并尝试点击。', expected: '错误quote明确拒绝或标为未核验，不能作为原文展示；正确quote可以定位并与原文逐字核对。', rejects: '合法ID、可点击或块非空就判引用真实。' },
  { id: 'search-switch', applies: '跨资料检索', setup: 'A包含唯一关键词，B不包含；先在A搜索。', action: '切换到B，清空关键词，再回到A。', expected: '输入、命中列表、计数和高亮共同对应当前资料与查询；清空后没有残留命中。', rejects: '只检查正文无高亮，忽略相邻计数。' },
  { id: 'inventory-atomicity', applies: '库存、借还、导入恢复', setup: '保留两条合法记录和库存基线，准备超库存或引用不存在对象的恢复文件。', action: '从实际入口恢复错误文件，再读取全部记录并重开。', expected: '整次操作拒绝，原记录与库存不变；错误后仍能完成合法操作。', rejects: '只检查出现错误文案，未核对部分数据是否已写入。' },
  { id: 'existing-regression', applies: '修改已有工程', setup: '保存原入口、测试、数据和用户已有未提交修改；先实际运行原测试记录基线。', action: '在副本完成指定改动，运行新旧测试并重开。', expected: '原功能与用户改动保留；原有失败与新回归分别解释；源目录不被写回。', rejects: '删除旧测试、重铺骨架或把退出码0等同产品通过。' },
] as const
export const COUNTEREXAMPLE_GUIDANCE = { cases: ACCEPTANCE_COUNTEREXAMPLES, scope: '仅供按已确认需求选择反例；不新增功能、不代表已执行或完整覆盖，不签发PASS。受控AI响应只验证本机行为，真实回答质量另验。' }
