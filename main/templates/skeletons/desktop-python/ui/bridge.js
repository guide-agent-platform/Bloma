/* webui bridge — pywebview 桥接粘合层（批8 HTML 渲染层）
   全部页面 JS 只经本对象调 Python；业务逻辑不写裸 pywebview 调用。
   骨架已内置，照抄不改（任务书口径：UI 只管渲染与收集输入）。 */
window.App = (function () {
  "use strict";

  /** 驱动/纠错模式识别（URL 带 dport）：Api 调用走 HTTP /call 直达 Python。
   *  为什么：pywebview js_api 的回推（Python→JS 注入）与平台 /eval 的 evaluate_js
   *  并发会死锁（真机实证 2026-10-08：click 后页面 await 永不 resolve、/eval 挂死、
   *  与窗口可见性无关）；HTTP 通道不占 UI 线程，彻底避开。正常启动无 dport 仍走
   *  pywebview.api（零 HTTP 依赖）。 */
  function driveDport() {
    var m = /[?&]dport=(\d+)/.exec(window.location.search);
    return m ? m[1] : "";
  }

  /** 调 Python api 方法：await App.call("op_name", arg1, ...) → Python 返回值。
   *  失败如实抛出（UI 层 catch 后走失败态横幅，不吞异常）。 */
  async function call(op) {
    var args = Array.prototype.slice.call(arguments, 1);
    var port = driveDport();
    if (port) {
      // drive/纠错模式：HTTP /call（body 默认 text/plain——simple request 免预检；
      // 服务端 ACAO:* 已配）
      var resp = await fetch("http://127.0.0.1:" + port + "/call", {
        method: "POST",
        body: JSON.stringify({ op: op, args: args }),
      });
      var body = await resp.json();
      if (!body.ok) throw new Error(body.error || "call failed: " + op);
      return body.result;
    }
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
   *  show("running", "正在保存…") / show("failed", "保存失败", "下一步：…") / hide()
   *  注：DOM 全量 createElement/textContent 构造（不用 innerHTML 拼接——平台交付安全门
   *  对动态 innerHTML 赋值判高危；textContent 天生免注入）。 */
  function show(state, text, next) {
    var b = document.querySelector(".w-banner");
    if (!b) return;
    b.setAttribute("data-state", state);
    while (b.firstChild) b.removeChild(b.firstChild);
    if (state === "running") {
      var spin = document.createElement("span");
      spin.className = "w-spin";
      b.appendChild(spin);
    }
    var line = document.createElement("span");
    line.textContent = text;
    if (next) {
      var hint = document.createElement("span");
      hint.className = "w-next";
      hint.textContent = next;
      line.appendChild(hint);
    }
    b.appendChild(line);
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
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!items || !items.length) {
      var empty = document.createElement("div");
      empty.className = "w-empty";
      var icon = document.createElement("div");
      icon.className = "w-empty-icon";
      icon.textContent = opt.icon || "◎";
      var title = document.createElement("div");
      title.className = "w-empty-title";
      title.textContent = opt.emptyTitle || "还没有内容";
      var hint = document.createElement("div");
      hint.className = "w-empty-hint";
      hint.textContent = opt.emptyHint || "点击上方按钮创建第一个";
      empty.appendChild(icon); empty.appendChild(title); empty.appendChild(hint);
      el.appendChild(empty);
      return;
    }
    items.forEach(function (it, i) {
      var tone = AVA_TONES[(opt.toneOf ? opt.toneOf(it) : i) % AVA_TONES.length];
      var row = document.createElement("div");
      row.className = "w-row";
      row.dataset.id = String(it[opt.idKey || "id"]);
      /* 组件身份（批11 点选纠错）：列表行携带稳定 id，修改预览点选可定位 */
      row.dataset.blomaId = "list.row." + String(it[opt.idKey || "id"]);
      if (opt.ava !== false) {
        var ava = document.createElement("div");
        ava.className = "w-ava";
        ava.style.background = "linear-gradient(135deg," + tone[0] + "," + tone[1] + ")";
        ava.textContent = String(it[opt.name] || "?").slice(0, 1);
        row.appendChild(ava);
      }
      var body = document.createElement("div");
      var name = document.createElement("div");
      name.className = "w-row-name";
      name.textContent = String(it[opt.name || "name"] ?? "");
      body.appendChild(name);
      if (it[opt.sub]) {
        var sub = document.createElement("div");
        sub.className = "w-row-sub";
        sub.textContent = String(it[opt.sub]);
        body.appendChild(sub);
      }
      row.appendChild(body);
      el.appendChild(row);
    });
  }

  /** 气泡追加：App.appendBubble(listEl, {side:"ai", text, meta}) */
  var bubbleSeq = 0;
  function appendBubble(el, msg) {
    if (!el) return;
    bubbleSeq += 1;
    var div = document.createElement("div");
    div.className = "w-bubble";
    div.setAttribute("data-side", msg.side === "user" ? "user" : "ai");
    /* 组件身份（批11 点选纠错）：气泡携带序号稳定 id */
    div.setAttribute("data-bloma-id", "chat.bubble." + bubbleSeq);
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
