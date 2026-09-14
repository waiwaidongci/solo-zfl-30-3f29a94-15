import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSiteRisk, sensorFreshness } from '../../src/core/risk.js';

const H = 3600000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

const CFG_CRIT = { maxAgeHours: 6, critical: true };
const CFG_NORM = { maxAgeHours: 6, critical: false };

const SENSORS = [
  { id: 's1', name: 'A', metric: 'current', metricName: '流速' },
  { id: 's2', name: 'B', metric: 'turbidity', metricName: '浊度' },
];
const cfgOf = id => (id === 's1' ? CFG_CRIT : CFG_NORM);
const freshSeries = { s1: [{ t: NOW - H, v: 1 }], s2: [{ t: NOW - H, v: 1 }] };

test('全部新鲜且无告警 → OK，覆盖度 100%', () => {
  const r = computeSiteRisk({ sensors: SENSORS, seriesBySensor: freshSeries, activeAlerts: [], cfgOf, now: NOW });
  assert.equal(r.level, 'OK');
  assert.equal(r.coverage, 1);
});

test('关键指标活动告警 → ALERT', () => {
  const r = computeSiteRisk({
    sensors: SENSORS, seriesBySensor: freshSeries,
    activeAlerts: [{ sensorId: 's1', since: NOW - H }], cfgOf, now: NOW,
  });
  assert.equal(r.level, 'ALERT');
});

test('非关键指标活动告警 → WATCH', () => {
  const r = computeSiteRisk({
    sensors: SENSORS, seriesBySensor: freshSeries,
    activeAlerts: [{ sensorId: 's2', since: NOW - H }], cfgOf, now: NOW,
  });
  assert.equal(r.level, 'WATCH');
});

test('关键指标失联 → DEGRADED 并说明原因（无有效数据）', () => {
  const r = computeSiteRisk({
    sensors: SENSORS, seriesBySensor: { s1: [], s2: freshSeries.s2 },
    activeAlerts: [], cfgOf, now: NOW,
  });
  assert.equal(r.level, 'DEGRADED');
  assert.ok(r.reasons.some(x => x.includes('流速') && x.includes('无任何有效数据')));
  assert.ok(r.reasons.some(x => x.includes('降级')));
});

test('关键指标数据过期 → DEGRADED 并注明距今时长', () => {
  const r = computeSiteRisk({
    sensors: SENSORS,
    seriesBySensor: { s1: [{ t: NOW - 10 * H, v: 1 }], s2: freshSeries.s2 },
    activeAlerts: [], cfgOf, now: NOW,
  });
  assert.equal(r.level, 'DEGRADED');
  assert.ok(r.reasons.some(x => x.includes('10 小时前') || x.includes('10.0 小时前')));
});

test('非关键传感器过期 → 覆盖度下降，WATCH，不降级', () => {
  const r = computeSiteRisk({
    sensors: SENSORS,
    seriesBySensor: { s1: freshSeries.s1, s2: [{ t: NOW - 20 * H, v: 1 }] },
    activeAlerts: [], cfgOf, now: NOW,
  });
  assert.equal(r.level, 'WATCH');
  assert.equal(r.coverage, 0.5);
  assert.ok(r.reasons.some(x => x.includes('覆盖度')));
});

test('无传感器 → NO_DATA', () => {
  const r = computeSiteRisk({ sensors: [], seriesBySensor: {}, activeAlerts: [], cfgOf, now: NOW });
  assert.equal(r.level, 'NO_DATA');
});

test('sensorFreshness 边界', () => {
  assert.equal(sensorFreshness([], CFG_CRIT, NOW).fresh, false);
  assert.equal(sensorFreshness([{ t: NOW - 6 * H, v: 1 }], CFG_CRIT, NOW).fresh, true);
  assert.equal(sensorFreshness([{ t: NOW - 6 * H - 1, v: 1 }], CFG_CRIT, NOW).fresh, false);
});
