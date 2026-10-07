# webui 组件用法（PAT TERNS——实现阶段的唯一视觉真相源）

> 约定：**不写新 CSS 就不写**——先用下面的组件拼；确实缺组件再在 `kit.css` 末尾加 `.w-` 前缀类。
> 颜色/间距/字号一律 `var(--*)`（见 `tokens.css`），禁止裸值与行内样式（渐变头像除外）。
> 全部资产本地引用（`kit.css`/`bridge.js`），**禁 CDN、禁外链字体、禁 npm/构建步骤**。

## 状态反馈（UX 契约状态机的唯一呈现位）

```js
App.show("running", "正在保存…");                       // 执行中（转圈）
App.show("success", "已保存 3 条记录");                  // 成功（给数量）
App.show("partial", "导入完成：成功 24，跳过 2");         // 部分成功（分别计数）
App.show("failed", "保存失败：文件被占用", "已关闭占用程序？点重试；原数据未修改");
App.hide();
```

外壳已带 `<div class="w-banner">`；每个耗时操作必须 running→终态，失败必须带"下一步"。

## 列表（空态自动）

```js
App.renderList(document.getElementById("side-list"), items, {
  idKey: "id", name: "name", sub: "sub",        // items 来自 App.call("list_...")
  emptyTitle: "还没有形象", emptyHint: "点「新建」创建第一个",
});
```

```html
<div id="side-list"></div>  <!-- 渲染目标；可点击行加监听见下 -->
<script>
  document.getElementById("side-list").addEventListener("click", function (e) {
    var row = e.target.closest(".w-row");
    if (row) selectItem(row.dataset.id);
  });
</script>
```

## 聊天气泡（聊天类应用主视图）

```html
<div class="w-msgs" id="msgs"></div>
```
```js
App.appendBubble(msgsEl, { side: "ai", text: "回复内容", meta: "14:02" });
App.appendBubble(msgsEl, { side: "user", text: "用户输入" });
```

## 卡片 / 顶栏信息

```html
<div class="w-card">
  <div class="w-card-title">标题</div>
  <div style="color: var(--text-sub)">正文说明</div>
</div>
```
```js
document.getElementById("topbar-title").textContent = item.name;
document.getElementById("topbar-sub").textContent = "性格：" + item.personality;
```

## 表单字段（行内校验错误，禁弹窗）

```html
<div class="w-field" id="field-name">
  <label class="w-field-label">名称</label>
  <input class="w-input" id="inp-name" placeholder="必填">
  <div class="w-field-error">名称不能为空</div>
</div>
```
```js
var bad = !inp.value.trim();
document.getElementById("field-name").setAttribute("data-invalid", bad ? "true" : "false");
if (bad) return App.show("failed", "名称不能为空", "补全后重试");
```

## 结果摘要（成功/部分成功给数字）

```html
<div class="w-summary">
  <div class="w-summary-item"><div class="w-summary-num">24</div><div class="w-summary-label">成功</div></div>
  <div class="w-summary-item"><div class="w-summary-num">2</div><div class="w-summary-label">跳过</div></div>
  <div class="w-summary-item"><div class="w-summary-num" style="color: var(--danger)">0</div><div class="w-summary-label">失败</div></div>
</div>
```

## 徽章 / 按钮

```html
<span class="w-chip" data-tone="primary">性格标签</span>
<span class="w-chip" data-tone="ok">已保存</span>
<button class="w-btn w-btn--primary">保存</button>
<button class="w-btn w-btn--ghost">取消</button>
<button class="w-btn w-btn--danger">删除</button>
```

## 取消执行（长任务可取消时——job_runner 形状）

```html
<button class="w-btn w-btn--ghost" id="btn-cancel">取消任务</button>
```
```js
// 取消必须真实生效：点击后 Python 侧停止任务并推终态，状态条转「已取消」——
// 禁假取消（按钮存在但任务照跑/状态永不变化）
var r = await App.call("cancel_task");
App.show("failed", "已取消：任务未完成", "已处理部分保留，可重新发起");
// 状态条语义用 failed 文案带「已取消」说明，或自定义 App.show("success", ...) 视任务语义
```

## 待配置态（无 key 引导——LLM 类产品用户自配 key 时）

```html
<div class="w-empty">
  <div class="w-empty-icon">⚙️</div>
  <div class="w-empty-title">还没配置 AI 服务</div>
  <div class="w-empty-hint">配置后即可使用对话功能；配置只保存在本机</div>
  <button class="w-btn w-btn--primary" id="btn-settings" style="margin-top: 12px">打开设置</button>
</div>
```
- 无 key 时主功能区显示此引导（不是空白/报错）；设置入口真实可用，保存后引导消失进入正常界面。
- 密钥只存本地（如本地配置文件），**严禁写进产物代码、README 或示例中**。

## 输入行（外壳已带；收集→调桥→反馈）

```js
async function onSend() {
  var input = document.getElementById("main-input");
  var text = input.value.trim();
  if (!text) return;
  try {
    App.show("running", "处理中…");
    input.value = "";
    var r = await App.call("handle_send", text);   // Python 逻辑层
    App.show("success", r.message || "完成");
  } catch (e) {
    App.show("failed", "失败：" + e.message, "可重试");
    input.value = text;                             // 失败不丢内容
  }
}
```

## 桥接纪律（业务代码唯一允许的 Python 交互方式）

- UI → Python：只走 `await App.call("方法名", 参数...)`（`bridge.js` 已封装）
- Python → UI：Python 端 `evaluate_js("window.on_xxx(...)")` 推送，页面定义 `window.on_xxx` 接收
- UI 不持有真相：所有数据从 `App.call("list_...")` 拿；改完调 `refresh()`
- 线程规则：pywebview 的 api 调用到达非主线程——Python 端业务代码不得直接摸 UI，一律 evaluate_js

## 组件身份（批11 点选纠错，2026-10-08）

- 骨架自带元素与 `App.renderList` / `App.appendBubble` 生成的元素已自动携带 `data-bloma-id`（稳定组件身份：`action.send` / `list.row.<id>` / `chat.bubble.<n>` 等）
- **自建组件一律照抄**：外层容器加 `data-bloma-id="<区域>.<语义名>"`（如 `form.customer-name` / `card.summary`）——修改预览点选纠错靠它定位；缺省时点选层按「角色+可见文本」生成临时身份（可用但重渲染后可能漂移）
