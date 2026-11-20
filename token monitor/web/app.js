import { auditDisposition, categories, outcomes, review, hasFailure, hasUnreadableFailure, browserFailure, failureSummary, observedFailure, readableOutput, readableSummary } from './review.js';

const labels = {uncached: "非缓存输入", read: "缓存读取", write: "缓存写入", output: "输出"};
const keys = Object.keys(labels);
const statuses = {completed: "已完成", error: "异常", failed: "失败", running: "未记录结束", cancelled: "已取消", unknown: "未知"};
const pageSize = 15;
const number = new Intl.NumberFormat("zh-CN");
const clock = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
const datetime = new Intl.DateTimeFormat("zh-CN", {year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"});
const yuan = new Intl.NumberFormat("zh-CN", {style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 3});
const deepSeekTieredPricingSince = Date.parse("2026-08-16T16:00:00Z");
// Published mainland China holiday periods, encoded as inclusive MMDD pairs.
const chinaHolidays = {
  2026: [[101, 103], [215, 223], [404, 406], [501, 505], [619, 621], [925, 927], [1001, 1007]],
  2027: [[101, 103], [205, 213], [403, 405], [501, 505], [609, 609], [915, 915], [1001, 1007]],
};

function deepSeekRateTier(at) {
  if (!Number.isFinite(at) || at < deepSeekTieredPricingSince) return undefined;
  const date = new Date(at);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 0 || day === 6 || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return "offPeak";
  const holidays = chinaHolidays[date.getUTCFullYear()];
  if (!holidays) return undefined;
  // Both peak windows fall on the same calendar date in UTC and Beijing time.
  const monthDay = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  return holidays.some(([first, last]) => monthDay >= first && monthDay <= last) ? "offPeak" : "peak";
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function table(headers, rows) {
  const result = element("table");
  const head = result.createTHead().insertRow();
  for (const title of headers) {
    const th = element("th", "", title);
    th.scope = "col";
    head.append(th);
  }
  const body = result.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
    }
  }
  return result;
}

export function mountTokenMonitor(root, transport) {
  const $ = id => root.querySelector("#" + id);
  let stopped = false;
  let timer;
  let auditStatus = null;
  let auditCommand = null;
  let auditRevision = 0;
  let auditSessionOptions = "";
  let moduleDrilldown = false;
  const state = {data: null, raw: "", query: {project: "", start: -Infinity, end: Infinity}, page: 0};
  const idFor = value => JSON.stringify(value);
  const inRange = item => (!state.query.project || item.project === state.query.project) &&
    item.at >= state.query.start && item.at < state.query.end;
  const emptyCounts = () => Object.fromEntries(keys.map(key => [key, 0]));
  const sum = (counts, selected = keys) => selected.reduce((total, key) => total + (counts[key] ?? 0), 0);
  const totalCounts = rows => rows.reduce((counts, row) => {
    keys.forEach(key => { counts[key] += row.counts[key] ?? 0; });
    return counts;
  }, emptyCounts());
  const count = n => n == null ? "—" : number.format(n);
  const modelLabel = row => row.provider + " / " + row.model;
  const dateLabel = at => datetime.format(at);

  function findPrice(row) {
    const catalog = state.data.pricing[row.provider];
    if (!catalog || /plan|coding/.test(row.channel)) return null;
    const name = row.model.toLowerCase();
    const undated = name.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
    const alias = row.provider === "DeepSeek" && /^deepseek-v4-flash(-vision-exp)?$/.test(name)
      ? "deepseek-flash" : undated;
    const rate = catalog.models[name] ?? catalog.models[alias];
    return rate ? {rate, catalog} : null;
  }

  function pricePair(row) {
    const found = findPrice(row);
    if (!found || row.missing) return null;
    const keysUsed = keys.filter(key => row.counts[key] > 0);
    const calc = rates => keysUsed.some(key => rates[key] == null) ? null :
      keysUsed.reduce((total, key) => total + rates[key] * row.counts[key], 0) / 1_000_000;
    const {rate} = found;
    const tier = row.provider === "DeepSeek" && rate.peak ? deepSeekRateTier(row.at) : undefined;
    if (tier) {
      const amount = calc(tier === "peak" ? rate.peak : rate);
      return amount == null ? null : [amount, amount];
    }
    const low = calc(rate);
    const high = calc(rate.peak ?? rate);
    return low == null || high == null ? null : [low, high];
  }

  function costLabel(min, max) {
    const format = usd => {
      const value = usd * state.data.fx.rate;
      return value > 0 && value < 0.001 ? "<¥0.001" : yuan.format(value);
    };
    const low = format(min), high = format(max);
    return low === high ? low : low + "–" + high;
  }

  function renderMetrics(rows) {
    const counts = totalCounts(rows);
    const priced = rows.map(pricePair).filter(Boolean);
    const amount = priced.reduce(([lo, hi], [min, max]) => [lo + min, hi + max], [0, 0]);
    $("total").textContent = count(sum(counts));
    $("input").textContent = count(sum(counts, ["uncached", "read", "write"]));
    $("input-sub").textContent = "缓存命中 " + count(counts.read) + " · 写入 " + count(counts.write);
    $("output").textContent = count(counts.output);
    $("calls").textContent = count(rows.length) + " 次模型请求";
    $("cost").textContent = priced.length ? costLabel(...amount) : "—";
    const rangeNote = amount[0] !== amount[1] ? "部分时段未确定 · " : "";
    $("cost-sub").textContent = rows.length ? rangeNote + "可估价 " + priced.length + " / " + rows.length + " 次请求" : "人民币 · 公开文本费率";
  }

  function localDay(at) {
    const dt = new Date(at);
    return [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()].map((part, i) => String(part).padStart(i ? 2 : 4, "0")).join("-");
  }

  function renderChart() {
    if (!state.data) return;
    const view = root.querySelector("[name=view]:checked").value;
    const selected = [...$("legend").querySelectorAll("input:checked")].map(input => input.value);
    const byResult = view === "module" && $("module-results").checked;
    $("module-option").hidden = view !== "module";
    $("result-legend").hidden = !byResult;
    const plotted = byResult ? Object.keys(outcomes) : selected;
    const legend = byResult ? outcomes : labels;
    const grouping = new Map();
    const rows = state.data.rows.filter(inRange);
    if (view === "phase") Object.values(state.data.phases).forEach(label => grouping.set(label, emptyCounts()));
    if (view === "outcome") Object.values(outcomes).forEach(label => grouping.set(label, emptyCounts()));
    const groupingBy = {
      phase: row => state.data.phases[row.phase], model: modelLabel, time: row => localDay(row.at),
      module: row => review(row).category, outcome: row => outcomes[review(row).outcome],
    };
    for (const row of view === "module" ? rows.filter(row => row.phase === "production") : rows) {
      const group = groupingBy[view](row);
      const counts = grouping.get(group) ?? (byResult ? Object.fromEntries(plotted.map(key => [key, 0])) : emptyCounts());
      if (byResult) counts[review(row).outcome] += sum(row.counts, selected);
      else keys.forEach(key => { counts[key] += row.counts[key] ?? 0; });
      grouping.set(group, counts);
    }
    const groups = [...grouping];
    if (view === "time") groups.sort(([left], [right]) => left.localeCompare(right));
    if (["model", "module"].includes(view)) groups.sort(([, left], [, right]) => sum(right, plotted) - sum(left, plotted));
    const max = groups.reduce((top, [, counts]) => Math.max(top, sum(counts, plotted)), 1);
    $("chart-caption").textContent = {
      time: "按请求开始日期汇总 · " + groups.length + " 个有记录的日期",
      phase: "按工作流步骤汇总 · 历史记录可按角色推断",
      model: "按供应商与模型汇总 · " + groups.length + " 个模型组合",
      module: "制作阶段按请求的任务汇总。包含所勾选的缓存上下文，可取消「缓存读取」查看其余用量。点击模块查看请求明细。",
      outcome: "按每次请求的结果汇总已上报 Token",
    }[view];
    const bars = groups.map(([group, counts]) => {
      const isModule = view === "module";
      const name = isModule ? categories[group] : group;
      const row = element(isModule ? "button" : "div", isModule ? "chart-row chart-module" : "chart-row");
      if (isModule) {
        row.type = "button";
        row.addEventListener("click", () => {
          moduleDrilldown = true;
          $("task-filter").value = group;
          $("outcome-filter").value = "";
          $("search").value = "";
          state.page = 0;
          renderTurns(state.data.rows.filter(inRange));
          focusTurns();
        });
      }
      const values = plotted.map(key => legend[key] + " " + count(counts[key])).join("，");
      const track = element("div", "track");
      track.setAttribute("role", "img");
      track.setAttribute("aria-label", name + "，" + values);
      track.title = values;
      for (const key of plotted) {
        const section = element("span", key);
        section.style.width = (counts[key] * 100 / max) + "%";
        track.append(section);
      }
      row.append(element("span", "chart-name", name), track, element("strong", "chart-total", count(sum(counts, plotted))));
      return row;
    });
    const message = selected.length ? "所选项目和时间内暂无请求。" : "勾选至少一种 Token 类别以显示图表。";
    $("chart").replaceChildren(...(selected.length && bars.length ? bars : [element("p", "empty", message)]));
  }

  function requestReview(row) {
    const data = review(row);
    const detail = element("details", "request-audit");
    detail.append(element("summary", "", categories[data.category] + " · " + outcomes[data.outcome] +
      (row.auditError ? " · 审查未知错误" : "")));
    if (row.auditError) detail.append(element("p", "", "审查错误 · " + row.auditError));
    const failed = hasFailure(row);
    const summary = failed && !hasUnreadableFailure(row) ? failureSummary(row) : "";
    detail.append(element("p", "", "目的 · " + (failed ? readableSummary(row.finding?.purpose) || "详见技术详情" : data.purpose)));
    detail.append(element("p", "", (failed ? "失败原因 · " : "结果 · ") +
      (failed ? browserFailure(row) || summary || observedFailure(row) : readableOutput(data.result) || "未记录可读的结果")));
    const technical = element("details", "audit-technical");
    technical.append(element("summary", "", "技术详情"));
    const proof = {id: "工具 ID 匹配", time: "历史时间匹配", none: "无可核对的会话关联"};
    technical.append(element("p", "", proof[data.evidence.source]));
    if (row.finding) technical.append(element("p", "", row.finding.model + " 评估 · " + categories[row.finding.category] + " / " + outcomes[row.finding.outcome]));
    if (summary && row.finding.summaryModel) technical.append(element("p", "", "摘要模型 · " + row.finding.summaryModel));
    const feedback = readableOutput(data.evidence.text);
    if (feedback) detail.append(element("p", "", "原回复 · " + feedback));
    const list = element("ul", "audit-evidence");
    for (const tool of data.evidence.tools) {
      const label = {ok: "已返回", failed: "失败", unknown: "结果未知"}[tool.state];
      list.append(element("li", "", [tool.name, readableOutput(tool.target), label, readableOutput(tool.diagnostic || tool.result)].filter(Boolean).join(" · ")));
    }
    for (const retry of row.retries ?? []) {
      list.append(element("li", "", "传输尝试 #" + retry.index + " · " + (retry.http ? "HTTP " + retry.http + " · " : "") + (statuses[retry.status] || retry.status) + " · 无独立用量"));
    }
    if (list.childElementCount) technical.append(list);
    detail.append(technical);
    return detail;
  }

  function renderAudit(rows) {
    const records = rows.map(row => ({row, ...review(row)}));
    const failures = records.filter(item => item.outcome === "failed" || item.outcome === "partial" || item.row.failed);
    const completed = records.filter(item => item.outcome === "success").map(item => item.row);
    const failed = failures.filter(item => item.outcome === "failed").map(item => item.row);
    const partial = failures.filter(item => item.outcome === "partial").map(item => item.row);
    const retries = rows.reduce((total, row) => total + row.failed, 0);
    const assessed = rows.filter(row => row.finding).length;
    $("audit-summary").textContent = "已完成 " + count(sum(totalCounts(completed))) + " Token · 失败 " + count(sum(totalCounts(failed))) +
      " Token · 部分完成 " + count(sum(totalCounts(partial))) +
      " Token · 无独立用量的传输尝试 " + count(retries) + " 次 · 本地模型已审查 " + count(assessed) + " / " + count(rows.length) + " 次请求";
    const grouped = new Map();
    for (const item of records) {
      if (item.row.phase !== "production") continue;
      const group = grouped.get(item.category) ?? {total: 0, success: 0, failed: 0, partial: 0, unknown: 0};
      const tokens = sum(item.row.counts);
      group.total += tokens;
      group[item.outcome] += tokens;
      grouped.set(item.category, group);
    }
    const resultKeys = ["success", "failed", "partial", "unknown"].filter(key =>
      key !== "partial" || [...grouped.values()].some(group => group.partial > 0));
    $("audit-breakdown").replaceChildren(...(grouped.size ? [table(["制作模块", "总 Token", ...resultKeys.map(key => outcomes[key])],
      [...grouped].sort(([, a], [, b]) => b.total - a.total).map(([name, total]) =>
        [categories[name], count(total.total), ...resultKeys.map(key => count(total[key]))]))] : []));
    $("failure-title").textContent = "失败、部分完成与未计量传输 · " + count(failures.length) + " 条请求";
    const open = new Set([...$("failure-list").querySelectorAll("details[open]")].map(item => item.dataset.request));
    $("failure-list").replaceChildren(...failures.map(({row}) => {
      const item = requestReview(row);
      item.dataset.request = idFor([row.project, row.id]);
      item.open = open.has(item.dataset.request);
      item.querySelector("summary").append(" · " + dateLabel(row.at) + " · " + (row.missing ? "已知 " : "") + count(sum(row.counts)) + " Token");
      const cost = pricePair(row);
      if (cost) item.querySelector("summary").append(" · " + costLabel(...cost));
      return item;
    }));
  }

  function turnView(turn, rows, openIds) {
    const details = element("details", "turn");
    details.dataset.turn = idFor([turn.project, turn.session, turn.id]);
    details.open = openIds.has(details.dataset.turn);
    const summary = element("summary");
    const subject = element("span");
    subject.append(element("span", "turn-title", turn.request));
    const meta = [dateLabel(turn.at), state.data.projects[turn.project]];
    if (rows.some(row => row.inferred)) meta.push("轮次关联为推断");
    if (turn.unlinked) meta.push("独立请求");
    subject.append(element("span", "turn-meta", meta.join(" · ")));
    const grouping = element("span");
    for (const phase of new Set(rows.map(row => row.phase))) {
      grouping.append(element("span", "stage", state.data.phases[phase]));
    }
    const models = [...new Set(rows.map(modelLabel))];
    grouping.append(element("span", "turn-model", models.join("、") || "暂无请求记录"));
    summary.append(subject, grouping, element("strong", "number", rows.some(row => !row.missing || sum(row.counts)) ? count(sum(totalCounts(rows))) : "—"));
    const body = element("div", "turn-detail");
    body.append(element("p", "", "用户摘要 · " + turn.request));
    body.append(element("p", "", "回复摘要 · " + (readableOutput(turn.reply || "") || "暂无可提取的回复")));
    if (rows.length) {
      const counts = totalCounts(rows);
      const purposes = [...new Set(rows.map(row => categories[review(row).category]))];
      body.append(element("p", "", "本轮任务 · " + purposes.join("、")));
      const results = Object.keys(outcomes).map(outcome => [outcomes[outcome], rows.filter(row => review(row).outcome === outcome).length]);
      body.append(element("p", "", "本轮结果 · " + results.filter(([, total]) => total).map(([label, total]) => label + " " + total + " 次").join(" · ")));
      if (rows.some(row => row.phase_inferred)) body.append(element("p", "", "部分历史请求的阶段按运行角色推断。"));
      body.append(element("p", "", keys.map(key => labels[key] + " " + count(counts[key])).join(" · ")));
      const wrapper = element("div", "wide-table");
      const showRequests = () => wrapper.replaceChildren(table(["请求开始", "任务与结果", "阶段", "供应商 / 模型", ...Object.values(labels), "估算人民币", "传输状态"],
        rows.slice().sort((a, b) => a.at - b.at).map(row => {
          const cost = pricePair(row);
          const status = (statuses[row.status] ?? row.status) + (row.missing ? " · 缺用量" : "") +
            (row.failed ? " · " + row.failed + " 次未成功传输" : "");
          const model = element("span", "", modelLabel(row));
          model.title = [row.host, row.channel].filter(Boolean).join(" · ");
          return [dateLabel(row.at), requestReview(row), state.data.phases[row.phase] + (row.phase_inferred ? "（历史推断）" : ""), model,
            ...keys.map(key => count(row.counts[key])), cost ? costLabel(...cost) : "—", status];
        })));
      if (details.open) showRequests();
      else details.addEventListener("toggle", () => { if (details.open && !wrapper.childElementCount) showRequests(); });
      body.append(wrapper);
    } else {
      body.append(element("p", "", "当前筛选范围内没有关联的请求用量。"));
    }
    details.append(summary, body);
    return details;
  }

  function renderTurns(rows) {
    const byTurn = new Map();
    const taskFilter = $("task-filter").value, outcomeFilter = $("outcome-filter").value;
    for (const row of rows) {
      if (moduleDrilldown && row.phase !== "production") continue;
      const audit = review(row);
      if (taskFilter && audit.category !== taskFilter || outcomeFilter && audit.outcome !== outcomeFilter) continue;
      const id = idFor(row.turn);
      if (!byTurn.has(id)) byTurn.set(id, []);
      byTurn.get(id).push(row);
    }
    const query = $("search").value.trim().toLowerCase();
    const turns = state.data.turns.filter(turn => {
      const calls = byTurn.get(idFor([turn.project, turn.session, turn.id])) ?? [];
      return (calls.length || !taskFilter && !outcomeFilter && inRange(turn)) &&
        [turn.request, turn.reply, state.data.projects[turn.project], ...calls.flatMap(row => {
          const audit = review(row);
          return [modelLabel(row), audit.purpose, audit.result, categories[audit.category], ...audit.evidence.tools.map(tool => tool.target)];
        })].some(value => value.toLowerCase().includes(query));
    }).sort((a, b) => b.at - a.at);
    const pages = Math.ceil(turns.length / pageSize);
    state.page = Math.min(state.page, Math.max(0, pages - 1));
    $("turn-count").textContent = (moduleDrilldown ? "制作阶段 · " : "") + count(turns.length) + " 条对话或独立请求";
    $("clear-module").hidden = !moduleDrilldown;
    $("pagination").hidden = pages <= 1;
    $("page-label").textContent = (state.page + 1) + " / " + pages;
    $("previous").disabled = !state.page;
    $("next").disabled = state.page >= pages - 1;
    const openIds = new Set([...$("turns").querySelectorAll("details[open]")].map(item => item.dataset.turn));
    const children = turns.slice(state.page * pageSize, (state.page + 1) * pageSize).map(turn =>
      turnView(turn, byTurn.get(idFor([turn.project, turn.session, turn.id])) ?? [], openIds));
    $("turns").replaceChildren(...(children.length ? children : [element("p", "empty", "没有符合条件的对话。")]));
  }

  function focusTurns() {
    const heading = $("turns-title");
    heading.focus({preventScroll: true});
    heading.scrollIntoView({block: "start", inline: "nearest"});
  }

  function renderPrices(rows) {
    $("exchange-rate").textContent = "参考汇率 · 1 USD = " + state.data.fx.rate.toFixed(3) + " CNY · " + state.data.fx.date;
    const catalog = state.data.pricing;
    $("price-sources").replaceChildren(...Object.entries(catalog).map(([provider, entry]) => {
      const link = element("button", "source-button", provider + " · " + (entry.state === "live" ? "官网已同步" : "缓存"));
      link.type = "button";
      link.addEventListener("click", async () => {
        try { await transport.openSource(provider, entry.url); }
        catch { $("price-update").textContent = "无法打开官方价格页"; }
      });
      link.title = entry.error ? "上次刷新失败：" + entry.error : "打开官方价格页";
      return link;
    }));
    const models = new Map(rows.map(row => [idFor([row.provider, row.model, row.channel]), row]));
    if ($("all-models").checked) {
      models.clear();
      for (const [provider, entry] of Object.entries(catalog)) {
        for (const model of Object.keys(entry.models)) models.set(idFor([provider, model]), {provider, model, channel: ""});
      }
    }
    const rates = [...models.values()].sort((a, b) => modelLabel(a).localeCompare(modelLabel(b))).map(row => {
      const found = findPrice(row);
      if (!found) return [modelLabel(row), ...keys.map(() => "—"), "无可用公开费率"];
      const {rate, catalog: entry} = found;
      const updated = rate.as_of ?? entry.as_of;
      const live = entry.state === "live" && rate.as_of === entry.checked;
      return [modelLabel(row), ...keys.map(key => {
        const low = rate[key];
        const high = rate.peak?.[key];
        return low == null ? "—" : costLabel(low, high ?? low);
      }), (live ? "官网" : "缓存") + " · " + updated.slice(0, 10)];
    });
    $("price-table").replaceChildren(models.size ?
      table(["供应商 / 模型", ...Object.values(labels), "来源 / 日期"], rates) :
      element("p", "empty", "当前筛选无模型调用，可勾选查看全部已知模型。"));
  }

  function render() {
    if (!state.data) return;
    const rows = state.data.rows.filter(inRange);
    const notices = [];
    const incomplete = rows.filter(row => row.missing || row.failed).length;
    if (incomplete) notices.push(incomplete + " 次请求有缺失用量或未成功传输，合计只包含已上报用量。");
    const {malformed, unreadable} = state.data.issues;
    if (malformed) notices.push("已跳过 " + malformed + " 条无效日志。");
    if (unreadable) notices.push(unreadable + " 个日志文件暂不可读。");
    $("notice").hidden = !notices.length;
    $("notice").textContent = notices.join(" ");
    renderMetrics(rows);
    renderChart();
    renderAudit(rows);
    renderAuditSessions();
    renderAuditPlan(rows);
    renderTurns(rows);
    if ($("prices").open) renderPrices(rows);
  }

  function setProjects() {
    const project = $("project");
    const pending = project.value;
    const options = Object.entries(state.data.projects).sort(([, left], [, right]) => left.localeCompare(right, "zh"));
    project.replaceChildren(new Option("全部项目", ""), ...options.map(([id, name]) => new Option(name, id)));
    project.value = options.some(([id]) => id === pending) ? pending : "";
  }

  async function load() {
    try {
      const revision = auditRevision;
      const [data, job] = await Promise.all([transport.read(), transport.auditStatus()]);
      if (stopped) return;
      const raw = JSON.stringify(data);
      if (raw !== state.raw) {
        state.data = data;
        setProjects();
        render();
        state.raw = raw;
      }
      if (!auditCommand && revision === auditRevision) {
        auditStatus = job;
        renderAuditStatus();
      }
      $("live").dataset.state = "ready";
      $("live").textContent = "已同步 " + clock.format(Date.now());
    } catch {
      if (stopped) return;
      $("live").dataset.state = "error";
      $("live").textContent = "连接中断，等待重连";
    } finally {
      if (!stopped) timer = setTimeout(load, 5000);
    }
  }

  const dateFields = [$("start"), $("end")];
  function updateDatePlaceholders() {
    for (const field of dateFields) field.toggleAttribute("data-empty", !field.value);
  }
  updateDatePlaceholders();

  $("filters").addEventListener("submit", event => {
    event.preventDefault();
    const start = $("start").value ? new Date($("start").value).getTime() : -Infinity;
    const end = $("end").value ? new Date($("end").value).getTime() + 60_000 : Infinity;
    if (start >= end) {
      $("end").setCustomValidity("结束时间须晚于或等于开始时间");
      $("end").reportValidity();
      return;
    }
    state.query = {project: $("project").value, start, end};
    state.page = 0;
    render();
  });
  for (const field of dateFields) {
    field.addEventListener("input", () => {
      $("end").setCustomValidity("");
      updateDatePlaceholders();
    });
    field.addEventListener("change", updateDatePlaceholders);
  }
  $("clear-filters").addEventListener("click", () => {
    $("filters").reset();
    $("end").setCustomValidity("");
    updateDatePlaceholders();
    $("filters").requestSubmit();
  });
  $("legend").addEventListener("change", renderChart);
  $("module-results").addEventListener("change", renderChart);
  root.querySelector(".switcher").addEventListener("change", renderChart);
  for (const [id, options] of [["task-filter", categories], ["outcome-filter", outcomes]]) {
    $(id).append(...Object.entries(options).map(([value, label]) => new Option(label, value)));
  }
  for (const id of ["search", "task-filter", "outcome-filter"]) $(id).addEventListener(id === "search" ? "input" : "change", () => {
    if (id === "task-filter") moduleDrilldown = false;
    state.page = 0;
    if (state.data) renderTurns(state.data.rows.filter(inRange));
  });
  $("clear-module").addEventListener("click", () => {
    $("task-filter").value = "";
    $("task-filter").dispatchEvent(new Event("change"));
    $("task-filter").focus();
  });
  for (const [id, step] of [["previous", -1], ["next", 1]]) {
    $(id).addEventListener("click", () => {
      state.page += step;
      renderTurns(state.data.rows.filter(inRange));
      focusTurns();
    });
  }
  function refreshPriceView() {
    if (state.data) renderPrices(state.data.rows.filter(inRange));
  }
  $("prices-open").addEventListener("click", () => {
    $("prices").showModal();
    refreshPriceView();
  });
  $("prices-close").addEventListener("click", () => $("prices").close());
  $("all-models").addEventListener("change", refreshPriceView);
  $("audit-models").addEventListener("click", async () => {
    const button = $("audit-models");
    button.disabled = true;
    try {
      const models = await transport.auditModels();
      $("audit-model").replaceChildren(new Option("自动选择", ""), ...models.map(model => new Option(model, model)));
      $("audit-model-status").textContent = models.length ? "检测到 " + models.length + " 个本地模型" : "Ollama 未安装本地模型";
    } catch { $("audit-model-status").textContent = "无法连接 Ollama，请启动本机服务（127.0.0.1:11434）"; }
    finally { button.disabled = false; }
  });

  function renderAuditSessions() {
    const select = $("audit-session");
    const selected = select.value;
    const projectFilter = state.query.project;
    const sessions = new Map();
    for (const row of state.data.rows) {
      if (projectFilter && row.project !== projectFilter) continue;
      const key = idFor(row.turn.slice(0, 2));
      const session = sessions.get(key);
      if (session) session.last = Math.max(session.last, row.at);
      else sessions.set(key, {project: row.project, id: row.turn[1], last: row.at});
    }
    for (const turn of state.data.turns) {
      if (turn.unlinked) continue;
      const session = sessions.get(idFor([turn.project, turn.session]));
      if (session && (!session.first || turn.at < session.first.at)) session.first = turn;
    }
    const options = [...sessions].sort(([, a], [, b]) => b.last - a.last).map(([key, session]) => {
      const project = state.data.projects[session.project] || session.project;
      const subject = session.first?.request.slice(0, 45) || `会话 ${session.id.slice(0, 8)}`;
      return [key, `${project} · ${dateLabel(session.first?.at ?? session.last)} · ${subject}`];
    });
    if (selected && !sessions.has(selected) && (!projectFilter || JSON.parse(selected)[0] === projectFilter)) {
      const id = JSON.parse(selected)[1];
      options.push([selected, `会话 ${id.slice(0, 8)}（暂无记录）`]);
    }
    const signature = idFor(options);
    if (signature === auditSessionOptions) return;
    auditSessionOptions = signature;
    select.replaceChildren(new Option("全部会话", ""), ...options.map(([key, label]) => new Option(label, key)));
    select.value = options.some(([key]) => key === selected) ? selected : "";
  }

  function renderAuditPlan(rows) {
    const mode = $("audit-mode").value;
    const selected = $("audit-session").value;
    $("audit-run").textContent = selected ? "审查选定会话" : "审查当前筛选";
    const totals = {rule: 0, cached: 0, noEvidence: 0, queued: 0, unknown: 0, running: 0, excluded: 0};
    for (const row of rows) {
      if (!selected || selected === idFor(row.turn.slice(0, 2))) totals[auditDisposition(row, mode)]++;
    }
    const labels = [["rule", "规则已判定"], ["cached", "已有缓存"], ["noEvidence", "证据不足，跳过"], ["queued", "待模型审查"]];
    if (totals.unknown) labels.push(["unknown", "跳过既有未知错误"]);
    if (totals.running) labels.push(["running", "请求仍在进行"]);
    if (totals.excluded) labels.push(["excluded", "其余调用，跳过"]);
    $("audit-plan").textContent = labels.map(([key, label]) => label + " " + count(totals[key]) + " 条").join(" · ");
  }
  for (const id of ["audit-mode", "audit-session"]) {
    $(id).addEventListener("change", () => {
      if (state.data) renderAuditPlan(state.data.rows.filter(inRange));
    });
  }

  const batchName = batch => [state.data?.projects[batch.project] || batch.project,
    batch.title || batch.session.slice(0, 8), `第 ${batch.index}/${batch.total} 批`, batch.retry && "重试"].filter(Boolean).join(" · ");
  const elapsed = milliseconds => (Math.max(0, milliseconds) / 1000).toFixed(1) + " 秒";
  function renderBatchProgress() {
    const batch = auditStatus?.activeBatch;
    $("audit-batch-progress").hidden = !batch;
    if (batch) $("audit-batch-progress").textContent = `${batchName(batch)} · 本批 ${batch.requests} 条 · 已等待 ${elapsed(Date.now() - batch.startedAt)}`;
  }

  function renderAuditStatus() {
    const job = auditStatus;
    const busy = job?.state === "running" || job?.state === "stopping";
    $("audit-run").disabled = busy || Boolean(auditCommand);
    $("audit-stop").hidden = !busy;
    $("audit-stop").disabled = Boolean(auditCommand) || job?.state === "stopping";
    $("audit-spinner").hidden = !busy && !auditCommand;
    renderBatchProgress();
    const history = job?.batchHistory ?? [];
    $("audit-timings").hidden = !history.length;
    $("audit-timing-list").replaceChildren(...[...history].reverse().map(batch => element("li", "",
      `${batchName(batch)} · ${batch.requests} 条 · 输入 ${count(batch.inputBytes)} 字节 · 耗时 ${elapsed(batch.elapsedMs)}` +
      (batch.unresolved ? ` · ${batch.unresolved} 条未完成 · ${batch.error}` : ""))));
    if (auditCommand === "start") {
      $("audit-status").textContent = "正在启动审查…";
      return;
    }
    if (auditCommand === "stop") {
      $("audit-status").textContent = "正在提交停止请求…";
      return;
    }
    if (!job) {
      $("audit-status").textContent = "";
      return;
    }
    const finished = job.unknownErrors ? "审查结束，有未知错误" :
      job.processed || job.skippedNoEvidence || job.skippedUnknownErrors ? "审查完成" : "当前范围没有待审查的请求";
    const title = {running: "正在审查", stopping: "正在审查，将在本批结束后停止", stopped: "已停止",
      completed: finished, error: "审查失败"};
    $("audit-status").textContent = [title[job.state], job.model,
      "已处理 " + count(job.processed) + " 条", job.remaining ? "剩余 " + count(job.remaining) + " 条" : "",
      job.skippedNoEvidence ? "证据不足，跳过 " + count(job.skippedNoEvidence) + " 条" : "",
      job.unknownErrors ? "未知错误 " + count(job.unknownErrors) + " 条" : "",
      job.skippedUnknownErrors ? "跳过既有未知错误 " + count(job.skippedUnknownErrors) + " 条" : "",
      job.lastAuditError ? "最近错误：" + job.lastAuditError : "", job.error].filter(Boolean).join(" · ");
  }

  async function sendAuditCommand(action, command) {
    auditCommand = action;
    auditRevision++;
    renderAuditStatus();
    let failure;
    try {
      auditStatus = await command();
    } catch (error) {
      failure = error.message;
    } finally {
      auditCommand = null;
      if (!stopped) {
        renderAuditStatus();
        if (failure) $("audit-status").textContent = failure;
      }
    }
  }

  $("audit-stop").addEventListener("click", () => sendAuditCommand("stop", () => transport.auditStop()));
  $("audit-run").addEventListener("click", () => {
    if (auditCommand || !state.data) return;
    const {project, start, end} = state.query;
    const selected = $("audit-session").value;
    const [auditProject, session] = selected ? JSON.parse(selected) : [project];
    const filter = {project: auditProject, ...(session ? {session} : {}), model: $("audit-model").value, mode: $("audit-mode").value,
      ...(Number.isFinite(start) ? {start} : {}), ...(Number.isFinite(end) ? {end} : {})};
    return sendAuditCommand("start", () => transport.auditStart(filter));
  });
  $("refresh-prices").addEventListener("click", async () => {
    const button = $("refresh-prices");
    button.disabled = true;
    $("price-update").textContent = "正在核对官网价格…";
    try {
      const pricing = await transport.refreshPrices();
      if (stopped) return;
      if (state.data) state.data.pricing = pricing;
      const live = Object.values(pricing).filter(entry => entry.state === "live").length;
      $("price-update").textContent = live + " 家官网已同步，其余显示缓存";
      render();
    } catch {
      $("price-update").textContent = "刷新失败，保留已有价格";
    } finally {
      button.disabled = false;
    }
  });
  load();
  const batchClock = setInterval(renderBatchProgress, 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(batchClock);
    $("prices").close();
  };
}
