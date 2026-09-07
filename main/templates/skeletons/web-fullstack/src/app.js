/**
 * 应用逻辑入口（骨架）：状态 / 渲染 / 事件 三段式。
 * 沙箱约束：无构建链、无外部资源、不使用 import/ESM 模块语法、不发起任何网络请求；
 * 数据一律内联或 localStorage。数据模块参考 src/examples/data-module.js 的模式。
 */
(function () {
  'use strict';

  /** 应用状态：唯一数据源，渲染与事件只经由此处读写。 */
  var state = {
    items: [], // 业务数据（内联初始数据或 localStorage 读取）
  };

  /** 空态占位：无数据时的引导文案（不是报错）。 */
  function emptyHint() {
    return state.items.length === 0 ? '暂无数据，先添加一条试试' : '';
  }

  /** 渲染：状态 → DOM。集中一个入口，避免散落的手工 DOM 拼接。 */
  function render() {
    var main = document.querySelector('.app-main');
    if (!main) return;
    // TODO(实现)：按功能项渲染列表 / 表单 / 详情；空态用 emptyHint()
  }

  /** 事件绑定：所有交互集中注册，动作先改 state 再调 render()。 */
  function bindEvents() {
    // TODO(实现)：表单提交 / 按钮点击 / 输入过滤等；示例——
    // var form = document.querySelector('#entry-form');
    // form.addEventListener('submit', function (event) {
    //   event.preventDefault();
    //   state.items.push(readEntry(form));
    //   render();
    // });
  }

  /** 状态提示条：操作反馈（成功/失败）统一出口。 */
  function showStatus(message) {
    var bar = document.getElementById('status-bar');
    if (!bar) return;
    bar.textContent = message || '';
    bar.hidden = !message;
  }

  function init() {
    bindEvents();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
