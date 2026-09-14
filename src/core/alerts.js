// 告警迟滞状态机。
// 规则：
//  - 连续 openAfter 个有效读数超标（>warnHigh 或 <warnLow）才打开告警；
//  - 告警中连续 closeAfter 个有效读数回落到恢复带 [recoverLow, recoverHigh] 内才关闭；
//  - 回差区（recover 与 warn 之间）的读数既不计入超标也不计入恢复；
//  - 抖动（非超标读数）会清零超标计数；非恢复带读数会清零恢复计数；
//  - 缺口（相邻有效读数间隔 > intervalMinutes*gapFactor）清零两侧计数，
//    缺口本身既不触发告警也不关闭告警 —— 抖动或缺口不会造成假告警。
// 输入 points 为已按时间升序的有效序列（隔离区数据不得传入）。

export function isGap(prevT, t, cfg) {
  return (t - prevT) > cfg.intervalMinutes * cfg.gapFactor * 60000;
}

export function classify(v, cfg) {
  if (v > cfg.warnHigh || v < cfg.warnLow) return 'exceed';
  if (v >= cfg.recoverLow && v <= cfg.recoverHigh) return 'recover';
  return 'deadband';
}

// 返回 { state, events, exceedCount, recoverCount, lastClass }
// events: [{ type:'opened'|'closed', t, value }]
export function evaluateSeries(points, cfg) {
  let state = 'NORMAL';
  let exceedCount = 0, recoverCount = 0;
  let prevT = null;
  const events = [];

  for (const p of points) {
    if (prevT !== null && isGap(prevT, p.t, cfg)) {
      exceedCount = 0; recoverCount = 0; // 缺口打断连续性
    }
    prevT = p.t;
    const cls = classify(p.v, cfg);

    if (state === 'NORMAL') {
      if (cls === 'exceed') {
        exceedCount += 1;
        if (exceedCount >= cfg.openAfter) {
          state = 'ALERT';
          events.push({ type: 'opened', t: p.t, value: p.v });
          exceedCount = 0; recoverCount = 0;
        }
      } else {
        exceedCount = 0; // 抖动清零
      }
    } else { // ALERT
      if (cls === 'recover') {
        recoverCount += 1;
        if (recoverCount >= cfg.closeAfter) {
          state = 'NORMAL';
          events.push({ type: 'closed', t: p.t, value: p.v });
          recoverCount = 0; exceedCount = 0;
        }
      } else {
        recoverCount = 0; // 回差区或继续超标都清零恢复计数
      }
    }
  }
  return { state, events, exceedCount, recoverCount };
}

// 对所有传感器序列求值，返回 { sensorId: 结果 }，并附活动告警清单。
export function evaluateAll(seriesBySensor, cfgOf) {
  const bySensor = {};
  const active = [];
  for (const [sensorId, points] of Object.entries(seriesBySensor)) {
    const cfg = cfgOf(sensorId);
    if (!cfg) continue;
    const res = evaluateSeries(points, cfg);
    bySensor[sensorId] = res;
    if (res.state === 'ALERT') {
      const opened = [...res.events].reverse().find(e => e.type === 'opened');
      active.push({ sensorId, since: opened ? opened.t : null });
    }
  }
  return { bySensor, active };
}
