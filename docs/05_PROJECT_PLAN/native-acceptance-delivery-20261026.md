# 原生测试接入正式验收与免费收口 · 2026-10-26

基线 938e4ed；金额准入前的宿主收口先在 55e9ba9 独立提交。本批将普通 Node/Playwright 测试接入核心验证和交付，不再要求把整个业务过程展开为平台动作表。新增供应商请求 0，历史失败、账本和未知费用责任保留。

## 结果

现有“学期任务台”063292c4-8693-48ba-b9d9-5662f9cca830 已由生产验收/交付服务完成：8 项确认需求均通过，12 个原生业务案例执行通过，包含原冻结计划的 14 组业务操作与真实重开；核心、安全和正常启动检查通过，项目状态为 completed，形成验证版本。

测试文件由操作者把此前独立冻结业务计划转换而来，应用原有业务文件摘要不变。通过的是这次服务层验收与宿主收口，不是新的模型从零自主开发成功，也不是一次完整客户端 UI 驾驶。

最新强持久性复验的版本为 1eed3645f105b7cffc5b66e7dbe56ed7173df6b0c5cf09b3488b9676ca8e3781；证据 run-artifacts/harness-formal-complex-20261026-physical/report.json。以前的模型中断和人工回退样本没有被改成成功记录。

## 一次调用进入正式验收

```js
// tests/acceptance.mjs
export default async ({ test, page, expect, assert, dataDir, phase }) => {
  if (phase === 'reopened') {
    await test('F-001 关闭重开后仍保留姓名', async () => {
      await expect(page.locator('#list')).toHaveText('Alice');
    });
    return;
  }
  await test('F-001 保存姓名', async () => {
    await page.locator('#name').fill('Alice');
    await page.locator('#save').click();
    await expect(page.locator('#list')).toHaveText('Alice');
  });
}
```

调用 `verify_app({script:"tests/acceptance.mjs"})` 即可冻结并执行，无需先调用 register_gui_check 或提供逐点击 JSON。test 是宿主传入的 node:test API，expect 使用 Playwright 原生断言，assert 为 Node 断言；不是让零知识用户编写这些代码。业务案例名标注单个内部 F 编号，可为同一功能写多项测试。原 register_gui_check、steps 和 CLI 入口保留兼容。

同一测试文件可先通过 inspect_app(script)调试；提供 test 参数或导入 node:test 的模块会使用真正的 Node 测试运行器。测试含 phase === 'reopened' 分支时自动安排真正关闭与重开；也可显式提供 restart:true。普通开发脚本仍兼容原来的默认异步函数。

## 可信执行边界

- 宿主从当前确认需求绑定 scope/design，不允许未知或缺失的功能编号。测试放在独立目录，其相对帮助文件和输入一并冻结；业务源码可独立修复。
- 测试在独立工程进程运行，平台不向它注入模型密钥。原生 Node 测试报告器在父进程收集真实事件，打印或返回“PASS”不能替代结果。
- 每个业务案例需要实际断言记录，整体需要实际界面交互；声明但未运行、跳过、空测试均不能通过。键盘、鼠标及常见定位/输入 API 的使用也被记录。
- 同目标不能改输入、断言或公共业务逻辑过关。可修正纯定位表达式，隐藏在定位参数中的副作用仍属于固定逻辑。确认新增功能后可以追加案例，保留既有案例和公共逻辑。取消 skip/todo 允许，但没有实际运行仍不通过。
- 完全未执行断言的草稿及可明确识别的启动/协议错误，可在绑定原规则摘要的完整失败凭据下修正；真实业务断言失败不适用这个例外。已通过项目的回归基线继续约束修改。
- 冻结输入损坏、测试源码与登记版本不同、来源/环境变化、未完整写入的凭据均不能复用旧 PASS。继续使用现有核心检查、安全扫描、正常启动和源码一致性边界，没有用零退出码替代这些检查。

这仍是对实际测试的执行与范围核对，不是对所有任意业务语义的数学证明，也不是恶意项目代码的 OS 沙箱。测试是否充分依然需要审阅和更广的使用样本。

## 关闭、存储与真实窗口的修复

补充 Electron 正式测试发现了原开发观察器会直接终止进程，导致 localStorage 来不及落盘。现在先正常关闭拥有的窗口并等待退出，再做兜底清理；浏览器也先关闭、刷新存储，再停止后端。

正式浏览器测试使用真实持久配置目录跨重开，不回填开发 storageState；开发会话的暂停恢复机制仍保留。这样不能靠恢复缓存伪装数据持久化。

Windows 正常启动还暴露了两处环境差异：Electron 执行时需要明确绑定隔离/持久的 user-data-dir，不能把测试路径写死进交付入口；windowsHide:true 可能隐藏首个原生产品窗口，而不仅隐藏控制台。现在测试/用户启动分别绑定正确数据目录，桌面产品窗口可见，后台服务和 supervisor 仍隐藏。启动失败会把实际输出尾部一起返回，减少只看到退出码的盲修。

多页面调试使用宿主拥有的精确 CDP target，而不是只按 URL 猜窗口；同 URL 的第二页面不会接管原页面。正式测试结束后清理隔离 Chromium 大配置目录，保留小体积报告、诊断和测试数据；不清理真实用户配置。

## 费用不足时先执行宿主检查

账本可确定新模型请求连保守输入预留都无法准入时，如果已有冻结检查且当前是在继续原目标，直接执行宿主验收，不先发一次注定失败的模型请求。没有规则、未处理的新需求、测试失败、取消或账本损坏均不能借此交付。详见 host-first-verification-20261026.md。

当前追加 3 元窗口仍为 55 次物理请求、计价上界 0.960841 元。本批模型查询/供应商请求均为 0，金额账本摘要不变；没有清掉早期未知责任或扩大预算。本批未实现精确输入 token 计数，金额预留本身仍然保守。

## 验证与证据

- harness-native-complete-regression-20261026.log：7 文件 54 项通过，涵盖原生验收、旧协议、费用、取消、回归保留和失败凭据。该批在后续桌面启动/持久性修复前执行。
- harness-native-final-gui-regression-20261026.log：最终 GUI/启动批 4 文件 41 项通过，包含原生验收 9 项、真实 Electron/浏览器开发与恢复 4 项、执行生命周期 5 项、启动判定 23 项。与前批重叠，不相加。
- harness-native-startup-regression-20261026.log：4 文件 31 项通过，补充发布更新、点选纠错与真实进程监督；同样不累加。
- 类型检查与构建：harness-native-final-gui-types-20261026.log、harness-native-final-gui-build-20261026.log。主进程模板已经同步，未推送。
- 实际复杂案例：harness-formal-complex-20261026-physical/report.json、verify-tool.json，以及初次和重开开发观察。测试按原冻结计划转换，没有改业务预期；旧业务文件逐项摘要一致，未手动设置完成标志。生产交付函数在真实检查后生成版本。
- 早期失败日志保留：Windows 报告器路径需 file URL；一次测试控制器只识别转译后的默认导出，修正后重跑；一次开发中修改宿主源码被 SOFTWARE_VERIFY_INPUT_CHANGED 正确拒绝。这些不当作产品成功次数。

汇总机器证据见 native-acceptance-delivery-20261026-evidence.json。

当前支持的是 Node/Playwright 应用测试入口，未宣称适配所有测试框架。原复杂项目的正式服务通路已完成；新模型从零生成并自主完成这套流程的效果，仍待后续有授权预算的独立实测。
