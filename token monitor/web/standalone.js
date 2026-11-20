import { mountTokenMonitor } from './app.js';

async function json(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
  return body;
}

mountTokenMonitor(document.body, {
  read: () => json('/api/usage'),
  refreshPrices: () => json('/api/pricing/refresh', {method: 'POST'}),
  auditModels: () => json('/api/audit/models'),
  auditStart: filter => json('/api/audit/start', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(filter)}),
  auditStatus: () => json('/api/audit/status'),
  auditStop: () => json('/api/audit/stop', {method: 'POST'}),
  openSource: (_provider, url) => window.open(url, '_blank', 'noopener,noreferrer'),
});
