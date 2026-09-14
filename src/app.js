// UI 主程序：总览 / 导入 / 登记与阈值 / 校准 / 隔离区 / 告警 / 报告与版本。
// 全部数据保存在本机 localStorage，离线可用。

import { METRICS, DEFAULT_METRIC_CONFIG, QUARANTINE_REASONS, RISK_LABELS, uid } from './core/schema.js';
import { loadState, saveState, mergeSeries, recordQuarantine } from './core/store.js';
import { seedDemo } from './core/seed.js';
import { parseCsv, parseJsonImport, detectFormat, ingestRows, summarizeQuarantine, parseTime } from './core/ingest.js';
import { findOverlapWindows, validateCalibration } from './core/calibrate.js';
import { recompute, publish, rollback, currentStatus } from './core/pipeline.js';

const state = loadState();
if (!state.sites.length) { seedDemo(state); saveState(state); }

let currentTab = 'overview';
let lastImportResult = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—';
const short = h => (h || '').slice(0, 8);

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 3200);
}

function save() { saveState(state); }
const sensorById = id => state.sensors.find(s => s.id === id);
const stationById = id => state.stations.find(s => s.id === id);
const metricName = m => METRICS[m]?.name || m;

// ---------- 业务动作 ----------

function importText(text) {
  const rows = detectFormat(text) === 'json' ? parseJsonImport(text) : parseCsv(text);
  const existingKeys = new Set();
  for (const [sid, pts] of Object.entries(state.series)) {
    for (const p of pts) existingKeys.add(`${sid}|${p.t}`);
  }
  const result = ingestRows(rows, {
    sensorIds: new Set(state.sensors.map(s => s.id)),
    metricCfgOf: id => sensorById(id)?.cfg,
    calibrationsOf: id => state.calibrations.filter(c => c.sensorId === id),
    existingKeys,
    now: Date.now(),
  });
  mergeSeries(state, result.accepted);
  recordQuarantine(state, result.quarantined, uid('batch'), Date.now());
  save();
  lastImportResult = result;
  return result;
}

function doRecompute() {
  try {
    const v = recompute(state, Date.now());
    save();
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function doPublish(versionId) {
  try {
    publish(state, versionId);
    save();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function doRollback(versionId) {
  try {
    rollback(state, versionId);
    save();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function recomputeAndPublish() {
  const r = doRecompute();
  if (!r.ok) { toast(`重算失败：${r.error}，已保留上一发布版`, true); render(); return false; }
  const p = doPublish(r.version.id);
  if (!p.ok) { toast(`发布失败：${p.error}`, true); render(); return false; }
  toast(`已重算并发布 ${r.version.id}`);
  render();
  return true;
}

// ---------- 渲染 ----------

function renderStaleBadge() {
  const { stale } = currentStatus(state);
  $('#staleBadge').classList.toggle('show', stale);
}

function renderOverview() {
  const { published, stale } = currentStatus(state);
  const el = $('#page-overview');
  if (!published) {
    el.innerHTML = `<div class="banner">尚未发布任何评估结果。请导入数据后到「报告与版本」重算并发布。
      <span><button data-action="goto-reports">前往发布</button></span></div>`;
    el.querySelector('[data-action="goto-reports"]').onclick = () => switchTab('reports');
    return;
  }
  const banner = stale
    ? `<div class="banner" data-testid="overview-stale">配置或数据已变更，以下结果为已失效的上一发布版（${esc(published.id)}）。
        <span><button data-action="republish">立即重算并发布</button></span></div>`
    : `<div class="banner ok">当前展示已发布版本 ${esc(published.id)} · 生成于 ${fmt(published.createdAt)} · 摘要 ${short(published.digest)}</div>`;
  const cards = state.sites.map(site => {
    const risk = published.results.risks[site.id];
    if (!risk) return '';
    const alerts = risk.activeAlerts.map(a =>
      `<span class="pill warn">${esc(a.metricName)} · ${esc(a.name)}${a.critical ? ' · 关键' : ''}</span>`).join('');
    const reasons = risk.reasons.length
      ? `<ul class="reasons" data-testid="degraded-reasons">${risk.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
    return `<div class="panel site-card ${risk.level}" data-site-id="${esc(site.id)}">
      <h2>${esc(site.name)} <span class="badge ${risk.level}" data-testid="risk-level">${RISK_LABELS[risk.level]}</span>
        ${stale ? '<span class="badge stale">已失效</span>' : ''}</h2>
      <dl class="kv">
        <dt>覆盖度</dt><dd data-testid="coverage">${Math.round(risk.coverage * 100)}%（${risk.fresh}/${risk.total}）</dd>
        <dt>风险评分</dt><dd>${risk.score}</dd>
        <dt>活动告警</dt><dd>${alerts || '<span class="muted">无</span>'}</dd>
      </dl>${reasons}</div>`;
  }).join('');
  el.innerHTML = banner + `<div class="grid cols2" id="siteCards">${cards}</div>`;
  const btn = el.querySelector('[data-action="republish"]');
  if (btn) btn.onclick = recomputeAndPublish;
}

function renderImport() {
  const el = $('#page-import');
  const sensorOpts = state.sensors.map(s => `${s.id}（${esc(s.name)}）`).join('、');
  el.innerHTML = `
    <div class="panel">
      <h2>导入监测数据</h2>
      <p class="muted">支持 CSV（表头 sensor,time,value）或 JSON 数组。空值按缺测隔离；重复时间戳、过期数据、
      校准重叠区读数自动隔离，不进入有效序列。已登记传感器：${sensorOpts || '无'}</p>
      <textarea id="importText" placeholder="sensor,time,value&#10;${state.sensors[0]?.id || 'S1'},2026-09-14T08:00:00Z,6.2"></textarea>
      <div class="row" style="margin-top:8px">
        <button id="importBtn">校验并导入</button>
        <input type="file" id="importFile" accept=".csv,.json,text/csv,application/json" style="flex:2">
      </div>
    </div>
    <div class="panel" id="importResultPanel" style="display:none">
      <h2>导入结果</h2>
      <div id="importSummary"></div>
      <div class="tablewrap"><table id="importQuarantineTable"></table></div>
    </div>`;
  $('#importBtn').onclick = () => {
    const text = $('#importText').value.trim();
    if (!text) { toast('请先粘贴数据', true); return; }
    try {
      const r = importText(text);
      renderImportResult(r);
      renderStaleBadge();
      toast(`导入完成：有效 ${r.accepted.length} 条，隔离 ${r.quarantined.length} 条`);
    } catch (e) { toast(`解析失败：${e.message}`, true); }
  };
  $('#importFile').onchange = async e => {
    const f = e.target.files[0];
    if (f) $('#importText').value = await f.text();
  };
  if (lastImportResult) {
    $('#importResultPanel').style.display = '';
    renderImportResult(lastImportResult);
  }
}

function renderImportResult(r) {
  const panel = $('#importResultPanel');
  if (!panel) return;
  panel.style.display = '';
  const summary = summarizeQuarantine(r.quarantined);
  $('#importSummary').innerHTML =
    `<p><span class="pill" data-testid="accepted-count">有效 ${r.accepted.length} 条</span>` +
    `<span class="pill warn" data-testid="quarantined-count">隔离 ${r.quarantined.length} 条</span>` +
    summary.map(s => `<span class="pill warn" data-reason="${s.reason}">${esc(s.label)} × ${s.count}</span>`).join('') + '</p>';
  $('#importQuarantineTable').innerHTML =
    '<tr><th>传感器</th><th>时间</th><th>原始值</th><th>隔离原因</th></tr>' +
    r.quarantined.map(q => `<tr><td>${esc(q.sensorId)}</td><td>${esc(String(q.time))}</td>
      <td>${esc(String(q.value))}</td><td>${esc(QUARANTINE_REASONS[q.reason] || q.reason)}</td></tr>`).join('');
}

function renderRegistry() {
  const el = $('#page-registry');
  const siteOpts = state.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const stationOpts = state.stations.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const metricOpts = Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${m.name}（${m.unit || '—'}）</option>`).join('');

  const sensorRows = state.sensors.map(s => {
    const st = stationById(s.stationId);
    return `<details class="sensor-editor" data-sensor-id="${s.id}">
      <summary>${esc(s.name)} · ${metricName(s.metric)} · ${esc(st?.name || '?')}
        ${s.cfg.critical ? '<span class="pill warn">关键指标</span>' : ''}</summary>
      <div class="body">
        <div class="numgrid">
          ${['warnLow', 'warnHigh', 'recoverLow', 'recoverHigh', 'openAfter', 'closeAfter', 'intervalMinutes', 'gapFactor', 'maxAgeHours', 'maxReadingAgeDays']
            .map(k => `<div><label>${k}</label><input type="number" step="any" data-cfg-key="${k}" value="${s.cfg[k]}"></div>`).join('')}
        </div>
        <label><input type="checkbox" data-cfg-key="critical" ${s.cfg.critical ? 'checked' : ''} style="width:auto"> 关键指标（失联将导致遗址评估降级）</label>
        <div class="row" style="margin-top:8px">
          <button class="small" data-action="save-cfg" data-id="${s.id}">保存阈值</button>
          <button class="small danger" data-action="del-sensor" data-id="${s.id}">删除传感器</button>
        </div>
      </div></details>`;
  }).join('');

  el.innerHTML = `
    <div class="grid cols3">
      <div class="panel"><h2>登记遗址</h2>
        <label>遗址名称</label><input id="siteName">
        <div class="row" style="margin-top:8px"><button id="addSiteBtn">添加遗址</button></div>
        <h3>已登记</h3>${state.sites.map(s => `<span class="pill">${esc(s.name)}</span>`).join('') || '<span class="muted">无</span>'}
      </div>
      <div class="panel"><h2>登记站点</h2>
        <label>所属遗址</label><select id="stationSite">${siteOpts}</select>
        <label>站点名称</label><input id="stationName">
        <div class="row" style="margin-top:8px"><button id="addStationBtn">添加站点</button></div>
        <h3>已登记</h3>${state.stations.map(s => `<span class="pill">${esc(s.name)}</span>`).join('') || '<span class="muted">无</span>'}
      </div>
      <div class="panel"><h2>登记传感器</h2>
        <label>所属站点</label><select id="sensorStation">${stationOpts}</select>
        <label>传感器名称</label><input id="sensorName">
        <label>监测指标</label><select id="sensorMetric">${metricOpts}</select>
        <label><input type="checkbox" id="sensorCritical" style="width:auto"> 关键指标</label>
        <div class="row" style="margin-top:8px"><button id="addSensorBtn">添加传感器</button></div>
      </div>
    </div>
    <div class="panel"><h2>阈值与告警迟滞参数</h2>
      <p class="muted">修改阈值会使已发布结果立即失效，需重算并发布后才恢复有效。</p>
      <div id="sensorList">${sensorRows || '<div class="empty">尚未登记传感器</div>'}</div>
    </div>`;

  $('#addSiteBtn').onclick = () => {
    const name = $('#siteName').value.trim();
    if (!name) return toast('请输入遗址名称', true);
    state.sites.push({ id: uid('site'), name }); save(); render();
  };
  $('#addStationBtn').onclick = () => {
    const name = $('#stationName').value.trim();
    if (!name) return toast('请输入站点名称', true);
    state.stations.push({ id: uid('st'), siteId: $('#stationSite').value, name }); save(); render();
  };
  $('#addSensorBtn').onclick = () => {
    const name = $('#sensorName').value.trim();
    const metric = $('#sensorMetric').value;
    if (!name) return toast('请输入传感器名称', true);
    state.sensors.push({
      id: uid('sen'), stationId: $('#sensorStation').value, name, metric,
      cfg: { ...DEFAULT_METRIC_CONFIG[metric], critical: $('#sensorCritical').checked },
    });
    save(); render();
  };
  el.querySelectorAll('[data-action="save-cfg"]').forEach(btn => {
    btn.onclick = () => {
      const sensor = sensorById(btn.dataset.id);
      const box = btn.closest('.sensor-editor');
      box.querySelectorAll('[data-cfg-key]').forEach(input => {
        const k = input.dataset.cfgKey;
        sensor.cfg[k] = input.type === 'checkbox' ? input.checked : Number(input.value);
      });
      save(); render();
      toast(`已保存「${sensor.name}」阈值，已发布结果随之失效`);
    };
  });
  el.querySelectorAll('[data-action="del-sensor"]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      state.sensors = state.sensors.filter(s => s.id !== id);
      delete state.series[id];
      state.calibrations = state.calibrations.filter(c => c.sensorId !== id);
      save(); render();
    };
  });
}

function renderCalib() {
  const el = $('#page-calib');
  const sensorOpts = state.sensors.map(s => `<option value="${s.id}">${esc(s.name)}（${metricName(s.metric)}）</option>`).join('');
  const overlapsBySensor = {};
  for (const s of state.sensors) {
    const wins = findOverlapWindows(state.calibrations.filter(c => c.sensorId === s.id));
    if (wins.length) overlapsBySensor[s.id] = wins;
  }
  const rows = state.calibrations.map(c => {
    const s = sensorById(c.sensorId);
    const overlap = overlapsBySensor[c.sensorId];
    return `<tr class="${overlap ? 'overlap-row' : ''}">
      <td>${esc(s?.name || c.sensorId)}</td><td>${fmt(c.start)}</td><td>${fmt(c.end)}</td>
      <td>${c.gain}</td><td>${c.offset}</td>
      <td>${overlap ? '<span class="pill warn">存在重叠</span>' : ''}</td>
      <td><button class="small danger" data-action="del-calib" data-id="${c.id}">删除</button></td></tr>`;
  }).join('');
  const overlapWarn = Object.keys(overlapsBySensor).length
    ? `<div class="banner" data-testid="overlap-warning">⚠ 存在校准区间重叠，重叠区内的读数将被隔离：
        ${Object.entries(overlapsBySensor).map(([sid, wins]) =>
          `${esc(sensorById(sid)?.name || sid)}（${wins.map(w => `${fmt(w.start)} ~ ${fmt(w.end)}`).join('；')}）`).join('；')}
      </div>` : '';

  el.innerHTML = `
    ${overlapWarn}
    <div class="panel"><h2>新增校准记录</h2>
      <div class="row">
        <div><label>传感器</label><select id="calibSensor">${sensorOpts}</select></div>
        <div><label>生效开始</label><input type="datetime-local" id="calibStart"></div>
        <div><label>生效结束</label><input type="datetime-local" id="calibEnd"></div>
        <div><label>增益 gain</label><input type="number" step="any" id="calibGain" value="1"></div>
        <div><label>偏移 offset</label><input type="number" step="any" id="calibOffset" value="0"></div>
      </div>
      <div class="row" style="margin-top:8px"><button id="addCalibBtn">保存校准记录</button></div>
      <p class="muted">修正公式：修正值 = 原始值 × 增益 + 偏移。新增或修改校准会使已发布结果立即失效。</p>
    </div>
    <div class="panel"><h2>校准记录</h2>
      <div class="tablewrap"><table>
        <tr><th>传感器</th><th>开始</th><th>结束</th><th>增益</th><th>偏移</th><th>状态</th><th></th></tr>
        ${rows || '<tr><td colspan="7" class="empty">暂无校准记录</td></tr>'}
      </table></div>
    </div>`;

  $('#addCalibBtn').onclick = () => {
    const rec = {
      id: uid('cal'),
      sensorId: $('#calibSensor').value,
      start: new Date($('#calibStart').value).getTime(),
      end: new Date($('#calibEnd').value).getTime(),
      gain: Number($('#calibGain').value),
      offset: Number($('#calibOffset').value),
    };
    const errs = validateCalibration(rec);
    if (errs.length) return toast(`校准记录非法：${errs.join('；')}`, true);
    state.calibrations.push(rec);
    save(); render();
    toast('校准记录已保存，已发布结果随之失效');
  };
  el.querySelectorAll('[data-action="del-calib"]').forEach(btn => {
    btn.onclick = () => {
      state.calibrations = state.calibrations.filter(c => c.id !== btn.dataset.id);
      save(); render();
    };
  });
}

function renderQuarantine() {
  const el = $('#page-quarantine');
  const summary = summarizeQuarantine(state.quarantine);
  const rows = [...state.quarantine].reverse().slice(0, 500).map(q => {
    const s = sensorById(q.sensorId);
    return `<tr><td>${esc(s?.name || q.sensorId)}</td><td>${esc(String(q.time))}</td>
      <td>${esc(String(q.value))}</td><td><span class="pill warn">${esc(QUARANTINE_REASONS[q.reason] || q.reason)}</span></td>
      <td class="muted">${fmt(q.at)}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <div class="panel"><h2>隔离区</h2>
      <p class="muted">被隔离的读数不会进入有效序列，不参与告警与风险计算。共 ${state.quarantine.length} 条。</p>
      <div id="qSummary">${summary.map(s =>
        `<span class="pill warn" data-reason="${s.reason}">${esc(s.label)} × ${s.count}</span>`).join('') || '<span class="muted">暂无隔离记录</span>'}</div>
      <div class="tablewrap" style="margin-top:10px"><table id="qTable">
        <tr><th>传感器</th><th>原始时间</th><th>原始值</th><th>隔离原因</th><th>导入时间</th></tr>
        ${rows}
      </table></div>
    </div>`;
}

function renderAlerts() {
  const el = $('#page-alerts');
  const { published, stale } = currentStatus(state);
  if (!published) {
    el.innerHTML = '<div class="banner">尚未发布评估结果，无法展示告警。</div>';
    return;
  }
  const active = published.results.activeAlerts;
  const activeHtml = active.length ? active.map(a => {
    const s = sensorById(a.sensorId);
    return `<div class="panel site-card ALERT" data-alert-sensor="${a.sensorId}">
      <b>${esc(s?.name || a.sensorId)}</b> · ${metricName(s?.metric)}
      <span class="badge ALERT">告警中</span>
      <div class="muted">自 ${fmt(a.since)} 起持续超标</div></div>`;
  }).join('') : '<div class="panel"><span class="muted">当前无活动告警</span></div>';

  const stateRows = state.sensors.map(s => {
    const res = published.results.alertsBySensor[s.id];
    if (!res) return '';
    const lastOpened = [...res.events].reverse().find(e => e.type === 'opened');
    const lastClosed = [...res.events].reverse().find(e => e.type === 'closed');
    return `<tr data-sensor-state="${s.id}">
      <td>${esc(s.name)}</td><td>${metricName(s.metric)}</td>
      <td>${res.state === 'ALERT' ? '<span class="badge ALERT">告警中</span>' : '<span class="badge OK">正常</span>'}</td>
      <td>${fmt(lastOpened?.t)}</td><td>${fmt(lastClosed?.t)}</td>
      <td class="muted">开 ${s.cfg.openAfter} 连超 / 关 ${s.cfg.closeAfter} 连恢复</td></tr>`;
  }).join('');

  el.innerHTML = `
    ${stale ? '<div class="banner">结果已失效，以下为上一发布版内容。</div>' : ''}
    <h2 style="color:#fff">活动告警</h2>
    <div id="activeAlerts">${activeHtml}</div>
    <div class="panel"><h2>各传感器告警状态（发布版 ${esc(published.id)}）</h2>
      <div class="tablewrap"><table>
        <tr><th>传感器</th><th>指标</th><th>状态</th><th>最近告警</th><th>最近关闭</th><th>迟滞参数</th></tr>
        ${stateRows}
      </table></div>
    </div>`;
}

function renderReports() {
  const el = $('#page-reports');
  const { published, stale } = currentStatus(state);
  const banner = stale
    ? `<div class="banner" data-testid="reports-stale">配置或数据已变更，结果与报告已失效。重算一致后方可发布。
        <span><button id="recomputePublishBtn">重算并发布</button></span></div>`
    : `<div class="banner ok" data-testid="reports-fresh">结果与报告为最新（${esc(published.id)} · 摘要 ${short(published.digest)}）</div>`;

  const reports = published ? state.sites.map(site => {
    const r = published.reports[site.id];
    if (!r) return '';
    return `<div class="panel site-card ${r.level}" data-report-site="${site.id}">
      <h2>${esc(r.siteName)} <span class="badge ${r.level}">${RISK_LABELS[r.level]}</span>
        ${stale ? '<span class="badge stale">已失效</span>' : ''}</h2>
      <dl class="kv">
        <dt>生成时间</dt><dd>${fmt(r.generatedAt)}</dd>
        <dt>覆盖度</dt><dd>${Math.round(r.coverage * 100)}%（${r.fresh}/${r.total}）</dd>
        <dt>有效读数</dt><dd>${r.validReadings}</dd>
        <dt>隔离读数</dt><dd>${r.quarantinedReadings}</dd>
        <dt>活动告警</dt><dd>${r.activeAlerts.length}</dd>
      </dl>
      ${r.reasons.length ? `<ul class="reasons">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('') : '<div class="panel empty">尚未发布任何版本</div>';

  const versions = [...state.versions].reverse().map(v => {
    const isPublished = v.id === state.publishedVersionId;
    const vStale = published && isPublished ? stale : true;
    return `<div class="version-item" data-version="${v.id}">
      <span class="grow"><b>${esc(v.id)}</b> · ${fmt(v.createdAt)} · 摘要 ${short(v.digest)}
        ${isPublished ? '<span class="badge OK">已发布</span>' : ''}
        ${isPublished && stale ? '<span class="badge stale">已失效</span>' : ''}
        ${!isPublished && vStale ? '<span class="pill">候选/历史</span>' : ''}</span>
      <button class="small" data-action="publish" data-id="${v.id}" ${isPublished ? 'disabled' : ''}>发布</button>
      <button class="small secondary" data-action="rollback" data-id="${v.id}" ${isPublished ? 'disabled' : ''}>回滚到此版</button>
    </div>`;
  }).join('');

  el.innerHTML = `
    ${banner}
    <div class="panel"><h2>操作</h2>
      <div class="row">
        <button id="recomputeBtn" class="secondary">仅重算（生成候选版本）</button>
        <button id="recomputePublishBtn2">重算并发布</button>
      </div>
      <p class="muted">重算对同一数据连续执行两次，结果一致才允许发布；重算失败时保留上一发布版。</p>
    </div>
    <h2 style="color:#fff">遗址报告</h2>
    <div id="reportsList" class="grid cols2">${reports}</div>
    <div class="panel"><h2>版本历史</h2><div id="versionsList">${versions || '<div class="empty">暂无版本</div>'}</div></div>`;

  const doAll = () => recomputeAndPublish();
  const b1 = $('#recomputePublishBtn'); if (b1) b1.onclick = doAll;
  $('#recomputePublishBtn2').onclick = doAll;
  $('#recomputeBtn').onclick = () => {
    const r = doRecompute();
    if (r.ok) toast(`重算完成，候选版本 ${r.version.id}（需发布）`); else toast(`重算失败：${r.error}，已保留上一发布版`, true);
    render();
  };
  el.querySelectorAll('[data-action="publish"]').forEach(btn => {
    btn.onclick = () => {
      const r = doPublish(btn.dataset.id);
      toast(r.ok ? `已发布 ${btn.dataset.id}` : `发布失败：${r.error}`, !r.ok);
      render();
    };
  });
  el.querySelectorAll('[data-action="rollback"]').forEach(btn => {
    btn.onclick = () => {
      const r = doRollback(btn.dataset.id);
      toast(r.ok ? `已回滚到 ${btn.dataset.id}（配置随版本恢复）` : `回滚失败：${r.error}`, !r.ok);
      render();
    };
  });
}

const RENDERERS = {
  overview: renderOverview,
  import: renderImport,
  registry: renderRegistry,
  calib: renderCalib,
  quarantine: renderQuarantine,
  alerts: renderAlerts,
  reports: renderReports,
};

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section.tabpage').forEach(s => s.classList.toggle('active', s.id === `page-${tab}`));
  render();
}

function render() {
  renderStaleBadge();
  RENDERERS[currentTab]();
}

document.querySelectorAll('nav.tabs button').forEach(b => { b.onclick = () => switchTab(b.dataset.tab); });

// 供自动化测试与离线调试使用
window.__app = {
  state,
  status: () => currentStatus(state),
  importText,
  doRecompute,
  doPublish,
  doRollback,
  recomputeAndPublish,
  switchTab,
  render,
  save,
};

render();
