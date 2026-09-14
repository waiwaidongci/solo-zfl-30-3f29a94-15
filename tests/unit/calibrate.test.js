import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOverlapWindows, recordAt, correctReading, applyRecord, validateCalibration } from '../../src/core/calibrate.js';

const H = 3600000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

test('无重叠校准记录：无重叠窗口', () => {
  const recs = [
    { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1, offset: 0 },
    { id: 'c2', sensorId: 's', start: T0 + 11 * H, end: T0 + 20 * H, gain: 1, offset: 0 },
  ];
  assert.deepEqual(findOverlapWindows(recs), []);
});

test('重叠校准记录：检出重叠窗口', () => {
  const recs = [
    { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1, offset: 0 },
    { id: 'c2', sensorId: 's', start: T0 + 5 * H, end: T0 + 20 * H, gain: 1, offset: 0 },
  ];
  const wins = findOverlapWindows(recs);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].start, T0 + 5 * H);
  assert.equal(wins[0].end, T0 + 10 * H);
});

test('三条记录重叠窗口合并', () => {
  const recs = [
    { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1, offset: 0 },
    { id: 'c2', sensorId: 's', start: T0 + 5 * H, end: T0 + 15 * H, gain: 1, offset: 0 },
    { id: 'c3', sensorId: 's', start: T0 + 8 * H, end: T0 + 20 * H, gain: 1, offset: 0 },
  ];
  const wins = findOverlapWindows(recs);
  assert.equal(wins.length, 1);
  assert.deepEqual(wins[0], { start: T0 + 5 * H, end: T0 + 15 * H });
});

test('recordAt：0 条 / 1 条 / 重叠', () => {
  const recs = [
    { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1, offset: 0 },
    { id: 'c2', sensorId: 's', start: T0 + 5 * H, end: T0 + 20 * H, gain: 1, offset: 0 },
  ];
  assert.equal(recordAt(recs, T0 - 1), null);
  assert.equal(recordAt(recs, T0 + 2 * H).id, 'c1');
  assert.equal(recordAt(recs, T0 + 7 * H), 'overlap');
});

test('线性修正 corrected = raw*gain+offset', () => {
  const rec = { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1.02, offset: -0.3 };
  assert.equal(applyRecord(10, rec), 9.9); // 修正结果保留 3 位小数
  const r = correctReading(10, T0 + H, [rec]);
  assert.equal(r.ok, true);
  assert.equal(r.calibrated, true);
  assert.equal(r.value, 9.9);
});

test('无校准覆盖：原样通过且标记未校准；重叠：拒绝', () => {
  const rec = { id: 'c1', sensorId: 's', start: T0, end: T0 + 10 * H, gain: 1, offset: 0 };
  const outside = correctReading(7, T0 + 11 * H, [rec]);
  assert.deepEqual(outside, { ok: true, value: 7, calibrated: false });
  const recs = [rec, { id: 'c2', sensorId: 's', start: T0 + 5 * H, end: T0 + 20 * H, gain: 1, offset: 0 }];
  const dup = correctReading(7, T0 + 7 * H, recs);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'calibration_overlap');
});

test('validateCalibration 校验非法记录', () => {
  assert.deepEqual(validateCalibration({ sensorId: 's', start: 1, end: 2, gain: 1, offset: 0 }), []);
  assert.ok(validateCalibration({ sensorId: '', start: 1, end: 2, gain: 1, offset: 0 }).length > 0);
  assert.ok(validateCalibration({ sensorId: 's', start: 5, end: 2, gain: 1, offset: 0 }).length > 0);
  assert.ok(validateCalibration({ sensorId: 's', start: 1, end: 2, gain: NaN, offset: 0 }).length > 0);
});
