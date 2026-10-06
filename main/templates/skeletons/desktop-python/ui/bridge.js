/* webui bridge — pywebview 桥接粘合层（批8 HTML 渲染层）
   全部页面 JS 只经本对象调 Python；业务逻辑不写裸 pywebview 调用。
   骨架已内置，照抄不改（任务书口径：UI 只管渲染与收集输入）。 */
window.App = (function () {
  "use strict";

  /** 调 Python api 方法：await App.call("op_name", arg1, ...) → Python 返回值。
   *  失败如实抛出（UI 层 catch 后走失败态横幅，不吞异常）。 */
  async function call(op) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (window.pywebview && pywebview.api && pywebview.api[op]) {
      var raw = await pywebview.api[op].apply(null, args);
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    // 桥未就绪（页面先于 pywebview 注入加载）——排队重试一次
    await new Promise(function (r) { setTimeout(r, 120); });
    if (window.pywebview && pywebview.api && pywebview.api[op]) {
      var raw2 = await pywebview.api[op].apply(null, args);
      try { return JSON.parse(raw2); } catch (e) { return raw2; }
    }
    throw new Error("桥未就绪：pywebview.api." + op);
  }

  /** 状态反馈条（UX 契约状态机的唯一呈现位）。
   *  show("running", "正在保存…") / show("failed", "保存失败", "下一步：…") / hide() */
  function show(state, text, next) {
    var b = document.querySelector(".w-banner");
    if (!b) return;
    b.setAttribute("data-state", state);
    b.innerHTML = (state === "running" ? '<span class="w-spin"></span>' : "") +
      "<span>" + text + (next ? '<span class="w-next">' + next + "</span>" : "") + "</span>";
    b.style.display = "flex";
  }
  function hide() {
    var b = document.querySelector(".w-banner");
    if (b) { b.removeAttribute("data-state"); b.style.display = "none"; }
  }

  /** 列表区渲染：App.renderList(el, items, {name:"name", sub:"sub", ava:"initial", tone:0})
   *  items 为 Python 返回的对象数组；键名映射后生成 w-row。 */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var AVA_TONES = [
    ["#f59e0b", "#ef4444"], ["#0ea5e9", "#6366f1"], ["#f97316", "#eab308"],
    ["#10b981", "#0ea5e9"], ["#8b5cf6", "#ec4899"], ["#64748b", "#334155"],
  ];
  function renderList(el, items, opt) {
    opt = opt || {};
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<div class="w-empty"><div class="w-empty-icon">' + (opt.icon || "◎") +
        '</div><div class="w-empty-title">' + esc(opt.emptyTitle || "还没有内容") +
        '</div><div class="w-empty-hint">' + esc(opt.emptyHint || "点击上方按钮创建第一个") + "</div></div>";
      return;
    }
    el.innerHTML = items.map(function (it, i) {
      var tone = AVA_TONES[(opt.toneOf ? opt.toneOf(it) : i) % AVA_TONES.length];
      return '<div class="w-row" data-id="' + esc(it[opt.idKey || "id"]) + '">' +
        (opt.ava === false ? "" :
          '<div class="w-ava" style="background:linear-gradient(135deg,' + tone[0] + "," + tone[1] + ')">' +
          esc((it[opt.name] || "?").slice(0, 1)) + "</div>") +
        '<div><div class="w-row-name">' + esc(it[opt.name || "name"]) + "</div>" +
        (it[opt.sub] ? '<div class="w-row-sub">' + esc(it[opt.sub]) + "</div>" : "") +
        "</div></div>";
    }).join("");
  }

  /** 气泡追加：App.appendBubble(listEl, {side:"ai", text, meta}) */
  function appendBubble(el, msg) {
    if (!el) return;
    var div = document.createElement("div");
    div.className = "w-bubble";
    div.setAttribute("data-side", msg.side === "user" ? "user" : "ai");
    div.textContent = msg.text || "";
    if (msg.meta) {
      var m = document.createElement("div");
      m.className = "w-bubble-meta";
      m.textContent = msg.meta;
      div.appendChild(m);
    }
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  return { call: call, show: show, hide: hide, renderList: renderList, appendBubble: appendBubble, esc: esc };
})();
