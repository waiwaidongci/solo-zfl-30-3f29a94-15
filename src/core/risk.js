// 遗址风险计算。
// 输入：遗址下全部传感器、各传感器有效序列、活动告警、指标配置与当前时间。
// 风险由三部分构成：最新有效数据是否超标（经由活动告警体现）、数据覆盖度、活动告警数。
// 关键指标（critical）失联（无有效数据或最新有效数据超过保鲜期）时，
// 评估结果不可信，遗址状态降级为 DEGRADED 并逐条说明原因。

const HOUR_MS = 3600000;

export function sensorFreshness(points, cfg, now) {
  const last = points && points.length ? points[points.length - 1] : null;
  if (!last) return { fresh: false, lastT: null, ageHours: null };
  const ageMs = now - last.t;
  return {
    fresh: ageMs <= cfg.maxAgeHours * HOUR_MS,
    lastT: last.t,
    ageHours: Math.round(ageMs / HOUR_MS * 10) / 10,
  };
}

function lostReason(sensor, cfg, fr) {
  const what = `${sensor.metricName}(${sensor.name})`;
  if (fr.lastT === null) return `关键指标 ${what} 失联：无任何有效数据`;
  return `关键指标 ${what} 失联：最近有效数据在 ${fr.ageHours} 小时前，超过保鲜期 ${cfg.maxAgeHours} 小时`;
}

// sensors: [{ id, name, metric, metricName, stationName }]
// cfgOf: (sensorId) => 指标配置
// activeAlerts: [{ sensorId, since }]
export function computeSiteRisk({ sensors, seriesBySensor, activeAlerts, cfgOf, now }) {
  if (!sensors.length) {
    return { level: 'NO_DATA', score: 0, coverage: 0, fresh: 0, total: 0, activeAlerts: [], reasons: ['遗址下未登记任何传感器'] };
  }
  const alertSet = new Map(activeAlerts.map(a => [a.sensorId, a]));
  const reasons = [];
  let fresh = 0, score = 0;
  const lostCriticals = [];
  const siteAlerts = [];

  for (const s of sensors) {
    const cfg = cfgOf(s.id);
    const fr = sensorFreshness(seriesBySensor[s.id] || [], cfg, now);
    if (fr.fresh) fresh += 1;
    else if (cfg.critical) lostCriticals.push(lostReason(s, cfg, fr));

    if (alertSet.has(s.id)) {
      const a = alertSet.get(s.id);
      siteAlerts.push({ sensorId: s.id, name: s.name, metricName: s.metricName, since: a.since, critical: !!cfg.critical });
      score += cfg.critical ? 50 : 25;
    }
  }

  const total = sensors.length;
  const coverage = fresh / total;
  score += Math.round((1 - coverage) * 40);

  if (lostCriticals.length) {
    return {
      level: 'DEGRADED', score, coverage, fresh, total,
      activeAlerts: siteAlerts,
      reasons: [...lostCriticals, '关键指标失联，风险评估已降级，结果仅供参考'],
    };
  }
  if (coverage < 1) reasons.push(`覆盖度 ${Math.round(coverage * 100)}%（${fresh}/${total} 个传感器有新鲜数据）`);

  let level = 'OK';
  if (score >= 50) level = 'ALERT';
  else if (score >= 20) level = 'WATCH';
  if (level === 'ALERT') reasons.unshift('存在活动告警');
  else if (level === 'WATCH' && siteAlerts.length) reasons.unshift('存在非关键指标告警');

  return { level, score, coverage, fresh, total, activeAlerts: siteAlerts, reasons };
}
