import config from "../audit-config.json" with { type: "json" };

export const categories = {
  design: "UI / 交互设计", frontend: "前端实现", backend: "后端 / 数据逻辑",
  setup: "环境与依赖", research: "调研与代码阅读", testing: "测试与验收",
  debug: "排查与修复", delivery: "打包与交付", communication: "沟通与总结",
  mixed: "跨模块", unknown: "证据不足",
};
export const outcomes = config.outcomes;
const specific = new Set(["design", "frontend", "backend", "debug", "testing", "delivery", "setup"]);

const rules = Object.entries(config.rules).map(([category, [name, target]]) =>
  [category, name && new RegExp(name), target && new RegExp(target)]);

function categoryFor(tool) {
  const name = tool.name.toLowerCase();
  const target = tool.target.toLowerCase();
  return rules.find(([, toolPattern, targetPattern]) => toolPattern?.test(name) || targetPattern?.test(target))?.[0] ?? "unknown";
}

export function review(row) {
  const evidence = row.evidence ?? {text: "", tools: [], source: "none", failure: ""};
  const tools = evidence.tools;
  const failed = tools.filter(tool => tool.state === "failed");
  const positive = tools.some(tool => tool.state === "ok");
  const uncertain = tools.some(tool => tool.state === "unknown");
  const groups = [...new Set(tools.map(categoryFor).filter(group => group !== "unknown"))];
  let category = groups.length > 1 ? "mixed" : groups[0] ??
    (config.phaseCategories[row.phase] ?? "unknown");
  if (row.finding?.category && row.finding.category !== "unknown" && (tools.length || evidence.text) && !specific.has(category)) category = row.finding.category;
  const reason = evidence.failure || failed.map(tool => tool.result || tool.name + " 执行失败").join("；");
  let outcome = "unknown";
  if (evidence.failure) outcome = positive ? "partial" : "failed";
  else if (failed.length) outcome = positive || uncertain ? "partial" : "failed";
  else if (positive && !uncertain) outcome = "success";
  else if (positive && uncertain) outcome = "partial";
  else if (!tools.length && evidence.text && row.finding?.outcome === "success") outcome = "success";
  const description = tools.map(tool => [tool.name, tool.target].filter(Boolean).join(" ")).join("；");
  return {
    category, outcome, reason, evidence,
    purpose: ((tools.length || evidence.text) && row.finding?.purpose) || description || (row.phase === "requirements" ? "整理与确认需求" : "缺少可归属的任务证据"),
    result: reason || ((tools.length || evidence.text) && row.finding?.result) || (positive ? "工具已返回执行结果" : evidence.text || "未记录可验证的结果"),
  };
}

export function needsAudit(row) {
  const { category, outcome } = review(row);
  return category === "unknown" || outcome === "unknown";
}

export function needsSummary(row) {
  return !failureSummary(row) && (Boolean(row.evidence.failure) || row.evidence.tools.some(tool => tool.state === "failed"));
}

export function auditDisposition(row, mode) {
  if (row.status === "running") return "running";
  if (row.finding && !needsSummary(row)) return "cached";
  if (mode === "retry" && !row.auditError) return "excluded";
  if (mode !== "retry" && row.auditError && mode !== "all") return "unknown";
  if (mode === "pending" && !needsSummary(row) && !needsAudit(row)) return "rule";
  const evidence = Boolean(row.evidence.text.trim()) || row.evidence.tools.some(tool =>
    tool.target.trim() || tool.result.trim() || tool.diagnostic?.trim() || (tool.name && tool.name !== "工具调用"));
  return evidence ? "queued" : "noEvidence";
}

export function hasFailure(row) {
  return Boolean(row.evidence.failure || row.evidence.tools.some(tool => tool.state === "failed") || row.retries?.length);
}

export function readableSummary(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /[�\r\n]|^\s*[\[{]|^\s*`|"(?:exit_code|stderr|stdout)"\s*:/.test(text) ? "" : text.slice(0, 180);
}

export function failureSummary(row) {
  return readableSummary(row.finding?.failureSummary);
}

export function browserFailure(row) {
  const logs = row.evidence.tools.filter(tool => tool.state === "failed").map(tool => tool.diagnostic || tool.result);
  if (logs.some(output => output.includes("DevTools remote debugging requires a non-default data directory"))) {
    return "Edge 的远程调试未能启动。浏览器要求使用独立的数据目录，应用检查未能继续。";
  }
  if (logs.some(output => output.includes("Remote debugging pipe file descriptors are not open"))) {
    return "Edge 启动时未能打开远程调试管道，页面验证未能继续。";
  }
  return "";
}

export function hasUnreadableFailure(row) {
  return row.evidence.tools.some(tool => tool.state === "failed" && (tool.diagnostic || tool.result).includes("�"));
}

export function readableOutput(value) {
  return value.split(/\r?\n|\\r\\n|\\n/).filter(line => !line.includes("�")).join("\n").trim();
}

export function observedFailure(row) {
  const failed = row.evidence.tools.filter(tool => tool.state === "failed");
  const tool = failed.find(tool => (tool.diagnostic || tool.result).includes("�")) ?? failed[0];
  const output = tool?.diagnostic || tool?.result || "";
  const code = /"exit_code"\s*:\s*(-?\d+)/.exec(output)?.[1];
  const retry = row.retries?.find(item => item.http >= 400);
  if (row.evidence.failure) return row.evidence.failure + "。";
  const browser = browserFailure(row);
  if (browser) return browser;
  const action = /\bmkdir\b/i.test(tool?.target ?? "") ? "创建目录失败" :
    output.includes("Failed to launch the browser process") ? "浏览器进程启动失败" :
    code ? "命令执行失败" : "工具执行失败";
  if (tool) return action + (code ? `（退出码 ${code}）` : "") + "。" +
    (output.includes("�") ? "错误输出无法读取，具体原因无法确认。" : "现有日志无法确认更具体的原因。");
  return retry ? `一次传输尝试失败（HTTP ${retry.http}）。` : "有传输尝试失败，日志未记录具体原因。";
}
