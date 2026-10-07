/* correction.js — 修改预览点选层（批11 点选纠错，2026-10-08）
   仅在 ?correction=1 时由 index.html 条件加载。职责：
   - 常驻标识条：修改预览 / 数据只读 / 已选计数 / 完成点选
   - 悬停高亮可修改组件 + 角色标签跟随
   - 点击（capture 拦截业务事件）→ 反馈面板：组件信息 + 问题类型三选 + 一句话说明
   - 窄实时预览：低风险确定性候选（外观强调 / 文字替换）页内即时生效，不落盘
   - 选区经 App.call("correction_pick", ...) 落盘 picks.jsonl（平台轮询文件交接）
   - 程序化入口 window.CorrectionSimulate.pick(target, {kind, note}) —— 狗粮/Agent
     自动化走与真人点击完全相同的收集与落盘路径（双入口同形约束）
   纪律：动态 UI 一律 createElement/textContent（禁 innerHTML——平台交付安全门红线）。 */
(function () {
  "use strict";

  /* 静态加载零副作用守卫（安全扫描红线：禁运行时动态建 script 节点加载——
     正常启动本脚本到此即停，仅平台以 ?correction=1 拉起时激活点选层）。 */
  if (location.search.indexOf("correction=1") < 0) return;

  var qs = new URLSearchParams(location.search);
  var seq = 0;
  var picked = 0;

  /* ── 可点组件角色表（closest 优先级自上而下） ─────────────────── */
  var PICKABLE = [
    ["button, .w-btn", "button", "按钮"],
    ["input, textarea, select, .w-input", "input", "输入框"],
    [".w-banner", "banner", "状态提示条"],
    [".w-empty", "empty", "空状态"],
    [".w-bubble", "bubble", "气泡"],
    [".w-row", "list-row", "列表行"],
    [".w-chip", "chip", "标签"],
    [".w-card", "card", "卡片"],
  ];

  function pickableOf(el) {
    for (var i = 0; i < PICKABLE.length; i++) {
      var hit = el.closest(PICKABLE[i][0]);
      if (hit) return { el: hit, role: PICKABLE[i][1], roleLabel: PICKABLE[i][2] };
    }
    return null;
  }

  /** 组件稳定身份：data-bloma-id 优先，缺省按角色+内容指纹生成语义 id。 */
  function componentIdOf(el, role) {
    if (el.dataset && el.dataset.blomaId) return el.dataset.blomaId;
    var scope = (document.querySelector(".w-topbar-title") || {}).textContent || "";
    var text = (el.textContent || "").trim().slice(0, 12);
    return role + (text ? ":" + text : "") + (scope ? "@" + scope.slice(0, 10) : "");
  }

  function displayNameOf(el, roleLabel) {
    var text = (el.value || el.placeholder || el.textContent || "").trim();
    text = text.replace(/\s+/g, " ").slice(0, 14);
    return text ? roleLabel + "「" + text + "」" : "这个" + roleLabel;
  }

  /* ── 常驻标识条 ──────────────────────────────────────────────── */
  var bar = document.createElement("div");
  bar.className = "w-corr-bar";
  var barIcon = document.createElement("span");
  barIcon.className = "w-corr-bar-icon";
  barIcon.textContent = "✎";
  var barText = document.createElement("span");
  barText.textContent = "修改预览 · 数据只读 · 直接点选你想改的地方";
  var barCount = document.createElement("span");
  barCount.className = "w-corr-count";
  barCount.style.display = "none";
  var barDone = document.createElement("button");
  barDone.className = "w-corr-done";
  barDone.textContent = "完成点选";
  bar.appendChild(barIcon); bar.appendChild(barText); bar.appendChild(barCount); bar.appendChild(barDone);
  document.body.appendChild(bar);
  document.documentElement.classList.add("w-corr-on");

  function updateCount() {
    barCount.style.display = picked > 0 ? "inline-block" : "none";
    barCount.textContent = "已选 " + picked + " 处";
  }

  /* ── 悬停高亮 + 角色标签 ─────────────────────────────────────── */
  var hoverEl = null;
  var tip = document.createElement("div");
  tip.className = "w-corr-tip";
  tip.style.display = "none";
  document.body.appendChild(tip);

  function clearHover() {
    if (hoverEl) hoverEl.classList.remove("w-corr-hover");
    hoverEl = null;
    tip.style.display = "none";
  }

  document.addEventListener("pointerover", function (e) {
    if (panelOpen || e.target.closest(".w-corr-bar, .w-corr-panel, .w-corr-tip")) { clearHover(); return; }
    var hit = pickableOf(e.target);
    if (!hit) { clearHover(); return; }
    if (hoverEl !== hit.el) {
      clearHover();
      hoverEl = hit.el;
      hoverEl.classList.add("w-corr-hover");
      tip.textContent = hit.roleLabel + " · 点选标记";
      tip.style.display = "block";
    }
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 130) + "px";
    tip.style.top = Math.max(e.clientY - 34, 8) + "px";
  }, true);

  /* ── 反馈面板 ────────────────────────────────────────────────── */
  var panelOpen = false;

  function closePanel() {
    var p = document.querySelector(".w-corr-panel");
    if (p) p.remove();
    panelOpen = false;
  }

  /** 候选：低风险确定性预览（页内即时生效，不落盘；记录进 pick.preview 供回炉参考）。 */
  function buildCandidates(hit) {
    var list = [];
    if (hit.role === "button" || hit.role === "chip" || hit.role === "banner") {
      list.push({
        id: "emphasis",
        label: "更醒目一些",
        apply: function (el) {
          el.style.boxShadow = "0 0 0 3px rgba(59, 130, 246, .25), var(--shadow-1, 0 1px 3px rgba(0,0,0,.08))";
          el.style.fontWeight = "700";
          el.style.transform = "scale(1.03)";
          return "外观强调（阴影/加粗/微放大）";
        },
      });
    }
    if (hit.role === "input") {
      list.push({
        id: "placeholder",
        label: "占位提示更清楚",
        apply: function (el) {
          if (el.placeholder) el.placeholder = el.placeholder + "（在这里输入）";
          return "补强占位提示";
        },
      });
    }
    if (hit.role === "empty") {
      list.push({
        id: "empty-hint",
        label: "引导文案更明确",
        apply: function (el) {
          var hint = el.querySelector(".w-empty-hint");
          if (hint && hint.textContent.indexOf("——") < 0) hint.textContent = hint.textContent + "——按提示操作即可";
          return "空态引导补强";
        },
      });
    }
    return list;
  }

  function openPanel(hit) {
    closePanel();
    panelOpen = true;
    var el = hit.el;
    var panel = document.createElement("div");
    panel.className = "w-corr-panel";

    var head = document.createElement("div");
    head.className = "w-corr-panel-head";
    var name = document.createElement("span");
    name.className = "w-corr-panel-name";
    name.textContent = "已选中：" + displayNameOf(el, hit.roleLabel);
    var close = document.createElement("span");
    close.className = "w-corr-panel-close";
    close.textContent = "×";
    close.addEventListener("click", closePanel);
    head.appendChild(name); head.appendChild(close);

    var kinds = document.createElement("div");
    kinds.className = "w-corr-kinds";
    var kindValue = "guess";
    var kindDefs = [["guess", "让系统猜"], ["visual", "外观 / 布局"], ["function", "功能 / 操作"]];
    var kindBtns = kindDefs.map(function (def) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "w-corr-kind" + (def[0] === "guess" ? " active" : "");
      b.textContent = def[1];
      b.addEventListener("click", function () {
        kindValue = def[0];
        kindBtns.forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
      kinds.appendChild(b);
      return b;
    });

    var note = document.createElement("input");
    note.className = "w-input w-corr-note";
    note.placeholder = "可补一句说明（不填也行）";

    /* 窄实时预览候选（MVP-E）：低风险确定性修改，点击即时生效 */
    var cands = buildCandidates(hit);
    var previewApplied = null;
    var candRow = null;
    if (cands.length > 0) {
      candRow = document.createElement("div");
      candRow.className = "w-corr-cands";
      var candLabel = document.createElement("span");
      candLabel.className = "w-corr-cands-label";
      candLabel.textContent = "试试：";
      candRow.appendChild(candLabel);
      cands.forEach(function (c) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "w-corr-kind w-corr-cand";
        b.textContent = c.label;
        b.addEventListener("click", function () {
          var detail = c.apply(el);
          previewApplied = { applied: c.id, detail: detail };
          b.classList.add("active");
          b.textContent = c.label + " ✓";
        });
        candRow.appendChild(b);
      });
    }

    var actions = document.createElement("div");
    actions.className = "w-corr-actions";
    var okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "w-btn w-btn--primary w-corr-ok";
    okBtn.textContent = "记下这一处";
    okBtn.addEventListener("click", function () { recordPick(hit, { kind: kindValue, note: note.value.trim(), preview: previewApplied }); closePanel(); });
    var skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "w-btn w-btn--ghost";
    skipBtn.textContent = "取消";
    skipBtn.addEventListener("click", closePanel);
    actions.appendChild(okBtn); actions.appendChild(skipBtn);

    panel.appendChild(head);
    panel.appendChild(kinds);
    panel.appendChild(note);
    if (candRow) panel.appendChild(candRow);
    panel.appendChild(actions);
    document.body.appendChild(panel);

    /* 面板定位：贴近被选组件，视口边界自适应翻转 */
    var rect = el.getBoundingClientRect();
    var pw = 300;
    var left = Math.min(Math.max(rect.left, 12), window.innerWidth - pw - 12);
    var top = rect.bottom + 10;
    if (top + 240 > window.innerHeight) top = Math.max(rect.top - 250, 56);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    setTimeout(function () { note.focus(); }, 60);
  }

  /* ── 点击捕获（capture 拦截，防触发真实业务动作） ─────────────── */
  document.addEventListener("click", function (e) {
    if (e.target.closest(".w-corr-bar, .w-corr-panel, .w-corr-tip")) return;
    e.preventDefault();
    e.stopPropagation();
    var hit = pickableOf(e.target);
    if (!hit) return;
    openPanel(hit);
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panelOpen) closePanel();
  }, true);

  /* ── 落盘 ─────────────────────────────────────────────────────── */
  function recordPick(hit, opt) {
    seq += 1;
    picked += 1;
    updateCount();
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var payload = {
      type: "pick",
      seq: seq,
      ts: new Date().toISOString(),
      componentId: componentIdOf(el, hit.role),
      role: hit.role,
      roleLabel: hit.roleLabel,
      displayName: displayNameOf(el, hit.roleLabel),
      text: (el.value || el.textContent || "").trim().slice(0, 60),
      kind: opt.kind,
      note: opt.note || "",
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      dpr: window.devicePixelRatio || 1,
      source: "user",
      ...(opt.preview ? { preview: opt.preview } : {}),
    };
    try {
      App.call("correction_pick", JSON.stringify(payload)).catch(function () {});
    } catch (e) { /* 桥未就绪等：面板照常关闭，下一处重试 */ }
  }

  barDone.addEventListener("click", function () {
    try {
      App.call("correction_pick", JSON.stringify({ type: "done", count: picked, ts: new Date().toISOString() })).catch(function () {});
    } catch (e) { /* 同上 */ }
    barText.textContent = "已记录 " + picked + " 处——回到 Bloma 开始修改";
    barDone.disabled = true;
    barDone.textContent = "已提交";
  });

  /* ── 程序化入口（狗粮/Agent 自动化）：与真人点击同一收集与落盘路径 ── */
  window.CorrectionSimulate = {
    /** pick("[data-bloma-id='x']" 或元素, {kind:"visual", note:"..."}) → 静默落盘 */
    pick: function (target, opt) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return { ok: false, error: "target-not-found" };
      var hit = pickableOf(el);
      if (!hit) return { ok: false, error: "not-pickable" };
      recordPick(hit, opt || { kind: "guess", note: "" });
      return { ok: true, seq: seq };
    },
    /** 完成标记（狗粮收口用） */
    done: function () { barDone.click(); },
  };
})();
