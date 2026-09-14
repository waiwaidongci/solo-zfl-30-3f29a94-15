// 数据导入与隔离。
// 导入行: { sensorId, time, value }。逐行判定，问题行进入隔离区并给出原因，
// 只有全部通过的读数经校准修正后进入有效序列。
// 隔离规则（按序判定）: 未登记传感器 → 非法/未来时间戳 → 过期 → 缺测 →
// 重复时间戳 → 校准区间重叠。

import { QUARANTINE_REASONS, round3 } from './schema.js';
import { correctReading } from './calibrate.js';

export { QUARANTINE_REASONS };

const DAY_MS = 86400000;

export function parseTime(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim();
  if (/^-?\d{10,13}$/.test(s)) {
    const n = Number(s);
    return s.length === 10 ? n * 1000 : n; // 秒或毫秒
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

// CSV: 表头 sensor,time,value（也接受 sensorId/timestamp）。空 value 视为缺测行。
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const iSensor = header.findIndex(h => ['sensor', 'sensorid', '传感器'].includes(h));
  const iTime = header.findIndex(h => ['time', 'timestamp', '时间'].includes(h));
  const iValue = header.findIndex(h => ['value', 'val', '读数'].includes(h));
  if (iSensor < 0 || iTime < 0 || iValue < 0) {
    throw new Error('CSV 表头需包含 sensor,time,value');
  }
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return {
      sensorId: (cols[iSensor] || '').trim(),
      time: (cols[iTime] || '').trim(),
      value: (cols[iValue] ?? '').trim(),
    };
  });
}

// JSON: [{ sensor|sensorId, time|timestamp, value }]
export function parseJsonImport(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON 需为数组');
  return data.map(d => ({
    sensorId: String(d.sensorId ?? d.sensor ?? ''),
    time: d.time ?? d.timestamp ?? '',
    value: d.value,
  }));
}

export function detectFormat(text) {
  const s = String(text).trim();
  return s.startsWith('[') || s.startsWith('{') ? 'json' : 'csv';
}

// ctx: {
//   sensorIds: Set<string>,
//   metricCfgOf: (sensorId) => 指标配置(含 maxReadingAgeDays),
//   calibrationsOf: (sensorId) => 校准记录数组,
//   existingKeys: Set<`${sensorId}|${t}`> 已入库读数键,
//   now: number,
// }
export function ingestRows(rows, ctx) {
  const accepted = [];
  const quarantined = [];
  const seen = new Set(ctx.existingKeys || []);
  const push = (kind, row, extra = {}) =>
    (kind === 'ok' ? accepted : quarantined).push({ ...row, ...extra });

  for (const raw of rows) {
    const sensorId = String(raw.sensorId ?? '').trim();
    const row = { sensorId, time: raw.time, value: raw.value };

    if (!ctx.sensorIds.has(sensorId)) {
      push('q', row, { reason: 'unknown_sensor' }); continue;
    }
    const cfg = ctx.metricCfgOf(sensorId);
    const t = parseTime(raw.time);
    if (!Number.isFinite(t)) {
      push('q', row, { reason: 'invalid_time' }); continue;
    }
    if (t > ctx.now) {
      push('q', row, { reason: 'future_time', t }); continue;
    }
    const maxAgeMs = (cfg?.maxReadingAgeDays ?? 90) * DAY_MS;
    if (ctx.now - t > maxAgeMs) {
      push('q', row, { reason: 'expired', t }); continue;
    }
    const v = typeof raw.value === 'number' ? raw.value : Number(String(raw.value ?? '').trim());
    if (raw.value === null || raw.value === undefined || String(raw.value).trim() === '' || !Number.isFinite(v)) {
      push('q', row, { reason: 'missing_value', t }); continue;
    }
    const key = `${sensorId}|${t}`;
    if (seen.has(key)) {
      push('q', row, { reason: 'duplicate_timestamp', t, v }); continue;
    }
    const corrected = correctReading(v, t, ctx.calibrationsOf(sensorId));
    if (!corrected.ok) {
      push('q', row, { reason: corrected.reason, t, v }); continue;
    }
    seen.add(key);
    push('ok', { sensorId, t, v: round3(corrected.value), raw: v, calibrated: corrected.calibrated });
  }
  return { accepted, quarantined };
}

// 汇总隔离原因计数，供导入报告展示。
export function summarizeQuarantine(quarantined) {
  const counts = {};
  for (const q of quarantined) counts[q.reason] = (counts[q.reason] || 0) + 1;
  return Object.entries(counts).map(([reason, count]) => ({
    reason, count, label: QUARANTINE_REASONS[reason] || reason,
  }));
}
