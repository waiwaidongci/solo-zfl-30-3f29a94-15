// 校准修正与校准重叠检测。
// 校准记录: { id, sensorId, start, end, gain, offset }，start/end 为 epoch 毫秒，闭区间。
// 修正公式: corrected = raw * gain + offset。
// 同一传感器多条校准记录的适用窗口若重叠，重叠区内的读数无法确定该用哪条记录，
// 必须隔离（不得进入有效序列）。

import { round3 } from './schema.js';

// 计算一组校准记录中所有被 >=2 条记录覆盖的重叠时间窗（合并后返回）。
export function findOverlapWindows(records) {
  const events = [];
  for (const r of records) {
    events.push({ t: r.start, d: 1 }, { t: r.end, d: -1 });
  }
  // 同一时刻先结算结束再开始？闭区间下同一时刻既是某条 end 又是另一条 start，
  // 该瞬间仍被两条覆盖，因此先加后减：按 t 排序，end 事件排在 start 之后处理。
  events.sort((a, b) => (a.t - b.t) || (b.d - a.d)); // start(+1) 先于 end(-1)
  const windows = [];
  let depth = 0, openAt = null;
  for (const e of events) {
    const prev = depth;
    depth += e.d;
    if (prev < 2 && depth >= 2) openAt = e.t;
    if (prev >= 2 && depth < 2 && openAt !== null) {
      windows.push({ start: openAt, end: e.t });
      openAt = null;
    }
  }
  return windows;
}

export function inWindows(t, windows) {
  return windows.some(w => t >= w.start && t <= w.end);
}

// 找出恰好覆盖某时刻的单条校准记录；0 条返回 null，>=2 条返回 'overlap'。
export function recordAt(records, t) {
  const hits = records.filter(r => t >= r.start && t <= r.end);
  if (hits.length === 0) return null;
  if (hits.length > 1) return 'overlap';
  return hits[0];
}

export function applyRecord(rawValue, record) {
  return round3(rawValue * record.gain + record.offset);
}

// 对单条读数做校准修正。
// 返回 { ok:true, value, calibrated } 或 { ok:false, reason:'calibration_overlap' }。
export function correctReading(rawValue, t, records) {
  const rec = recordAt(records, t);
  if (rec === 'overlap') return { ok: false, reason: 'calibration_overlap' };
  if (rec === null) return { ok: true, value: rawValue, calibrated: false };
  return { ok: true, value: applyRecord(rawValue, rec), calibrated: true };
}

// 校验一条校准记录本身是否合法（供 UI 表单与导入使用）。
export function validateCalibration(rec) {
  const errs = [];
  if (!rec.sensorId) errs.push('缺少传感器');
  if (!(Number.isFinite(rec.start) && Number.isFinite(rec.end))) errs.push('起止时间非法');
  else if (rec.start > rec.end) errs.push('开始时间晚于结束时间');
  if (!Number.isFinite(rec.gain)) errs.push('增益非法');
  if (!Number.isFinite(rec.offset)) errs.push('偏移非法');
  return errs;
}
