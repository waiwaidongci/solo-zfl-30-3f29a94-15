import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestRows, parseCsv, parseJsonImport, summarizeQuarantine, parseTime } from '../../src/core/ingest.js';

const H = 3600000;
const NOW = Date.parse('2026-09-14T12:00:00Z');
const T = h => new Date(NOW - h * H).toISOString(); // h 小时前

function ctx(overrides = {}) {
  return {
    sensorIds: new Set(['S1']),
    metricCfgOf: () => ({ maxReadingAgeDays: 30 }),
    calibrationsOf: () => [],
    existingKeys: new Set(),
    now: NOW,
    ...overrides,
  };
}

test('正常行进入有效序列', () => {
  const { accepted, quarantined } = ingestRows([{ sensorId: 'S1', time: T(1), value: '5.5' }], ctx());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].v, 5.5);
  assert.equal(quarantined.length, 0);
});

test('未登记传感器被隔离', () => {
  const { quarantined } = ingestRows([{ sensorId: 'SX', time: T(1), value: 1 }], ctx());
  assert.equal(quarantined[0].reason, 'unknown_sensor');
});

test('非法与未来时间戳被隔离', () => {
  const bad = ingestRows([{ sensorId: 'S1', time: 'not-a-time', value: 1 }], ctx());
  assert.equal(bad.quarantined[0].reason, 'invalid_time');
  const future = ingestRows([{ sensorId: 'S1', time: new Date(NOW + H).toISOString(), value: 1 }], ctx());
  assert.equal(future.quarantined[0].reason, 'future_time');
});

test('过期数据被隔离', () => {
  const old = new Date(NOW - 31 * 24 * H).toISOString();
  const { quarantined } = ingestRows([{ sensorId: 'S1', time: old, value: 1 }], ctx());
  assert.equal(quarantined[0].reason, 'expired');
});

test('缺测（空值/非数值）被隔离', () => {
  const { quarantined } = ingestRows([
    { sensorId: 'S1', time: T(1), value: '' },
    { sensorId: 'S1', time: T(2), value: 'abc' },
    { sensorId: 'S1', time: T(3), value: null },
  ], ctx());
  assert.deepEqual(quarantined.map(q => q.reason), ['missing_value', 'missing_value', 'missing_value']);
});

test('批次内重复时间戳：首条有效，其余隔离', () => {
  const { accepted, quarantined } = ingestRows([
    { sensorId: 'S1', time: T(1), value: 1 },
    { sensorId: 'S1', time: T(1), value: 2 },
    { sensorId: 'S1', time: T(1), value: 3 },
  ], ctx());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].v, 1);
  assert.equal(quarantined.length, 2);
  assert.ok(quarantined.every(q => q.reason === 'duplicate_timestamp'));
});

test('与已入库读数重复的时间戳被隔离', () => {
  const t = parseTime(T(1));
  const { accepted, quarantined } = ingestRows(
    [{ sensorId: 'S1', time: T(1), value: 9 }],
    ctx({ existingKeys: new Set([`S1|${t}`]) }),
  );
  assert.equal(accepted.length, 0);
  assert.equal(quarantined[0].reason, 'duplicate_timestamp');
});

test('校准重叠区读数被隔离，单记录区读数被修正', () => {
  const tIn = parseTime(T(2));
  const calibs = [
    { id: 'c1', sensorId: 'S1', start: tIn - 3 * H, end: tIn + 3 * H, gain: 2, offset: 1 },
    { id: 'c2', sensorId: 'S1', start: tIn - 1 * H, end: tIn + 5 * H, gain: 1, offset: 0 },
  ];
  const c = ctx({ calibrationsOf: () => calibs });
  // tIn-2h 仅被 c1 覆盖 → 修正为 5*2+1=11；tIn+1h 被两条覆盖 → 隔离
  const { accepted, quarantined } = ingestRows([
    { sensorId: 'S1', time: new Date(tIn - 2 * H).toISOString(), value: 5 },
    { sensorId: 'S1', time: new Date(tIn + 1 * H).toISOString(), value: 5 },
  ], c);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].v, 11);
  assert.equal(accepted[0].calibrated, true);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].reason, 'calibration_overlap');
});

test('CSV 解析与缺测行', () => {
  const rows = parseCsv('sensor,time,value\nS1,2026-09-14T10:00:00Z,3.2\nS1,2026-09-14T11:00:00Z,\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].value, '');
  const { accepted, quarantined } = ingestRows(rows, ctx());
  assert.equal(accepted.length, 1);
  assert.equal(quarantined[0].reason, 'missing_value');
});

test('JSON 解析', () => {
  const rows = parseJsonImport('[{"sensor":"S1","timestamp":"2026-09-14T10:00:00Z","value":2.5}]');
  assert.equal(rows[0].sensorId, 'S1');
  const { accepted } = ingestRows(rows, ctx());
  assert.equal(accepted.length, 1);
});

test('隔离原因汇总', () => {
  const sum = summarizeQuarantine([
    { reason: 'expired' }, { reason: 'expired' }, { reason: 'missing_value' },
  ]);
  const expired = sum.find(s => s.reason === 'expired');
  assert.equal(expired.count, 2);
  assert.equal(expired.label, '过期数据');
});

test('parseTime 支持 ISO / 秒 / 毫秒', () => {
  assert.equal(parseTime('2026-09-14T00:00:00Z'), Date.parse('2026-09-14T00:00:00Z'));
  assert.equal(parseTime('1789948800'), 1789948800000);
  assert.equal(parseTime('1789948800000'), 1789948800000);
  assert.ok(Number.isNaN(parseTime('')));
});
