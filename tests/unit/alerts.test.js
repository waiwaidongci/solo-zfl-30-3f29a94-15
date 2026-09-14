import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSeries, isGap, classify } from '../../src/core/alerts.js';

const H = 3600000;
const T0 = Date.parse('2026-09-14T00:00:00Z');
const CFG = {
  warnLow: 0, warnHigh: 10, recoverLow: 2, recoverHigh: 8,
  openAfter: 3, closeAfter: 2, intervalMinutes: 30, gapFactor: 2,
};
// 每 30 分钟一个点
const pts = vals => vals.map((v, i) => ({ t: T0 + i * 30 * 60000, v }));

test('连续 3 次超标才告警，2 次不够', () => {
  assert.equal(evaluateSeries(pts([11, 11]), CFG).state, 'NORMAL');
  const r = evaluateSeries(pts([11, 11, 11]), CFG);
  assert.equal(r.state, 'ALERT');
  assert.equal(r.events.filter(e => e.type === 'opened').length, 1);
});

test('抖动打断连续性：超-超-正常-超 不告警', () => {
  assert.equal(evaluateSeries(pts([11, 11, 5, 11, 11]), CFG).state, 'NORMAL');
});

test('回差区读数不计入超标也不计入恢复', () => {
  assert.equal(classify(9, CFG), 'deadband');
  assert.equal(classify(11, CFG), 'exceed');
  assert.equal(classify(5, CFG), 'recover');
  // 超标序列中插入回差区读数 → 不计数
  assert.equal(evaluateSeries(pts([11, 11, 9, 11]), CFG).state, 'NORMAL');
});

test('告警后需连续 2 次回到恢复带才关闭', () => {
  const r = evaluateSeries(pts([11, 11, 11, 5, 5]), CFG);
  assert.equal(r.state, 'NORMAL');
  assert.deepEqual(r.events.map(e => e.type), ['opened', 'closed']);
  // 只回落 1 次不够
  assert.equal(evaluateSeries(pts([11, 11, 11, 5]), CFG).state, 'ALERT');
  // 回落 1 次后又超标 → 恢复计数清零
  assert.equal(evaluateSeries(pts([11, 11, 11, 5, 12, 5, 5]), CFG).state, 'NORMAL');
  assert.equal(evaluateSeries(pts([11, 11, 11, 5, 12, 5]), CFG).state, 'ALERT');
});

test('回差区读数清零恢复计数（必须真正回落并保持）', () => {
  // 告警后：5(恢复1) → 9(回差,清零) → 5(恢复1) → 仍未达 2 次
  assert.equal(evaluateSeries(pts([11, 11, 11, 5, 9, 5]), CFG).state, 'ALERT');
  assert.equal(evaluateSeries(pts([11, 11, 11, 5, 9, 5, 5]), CFG).state, 'NORMAL');
});

test('缺口打断超标连续性，不产生假告警', () => {
  const gapPts = [
    { t: T0, v: 11 }, { t: T0 + 30 * 60000, v: 11 },
    { t: T0 + 5 * H, v: 11 }, // 与前一点间隔 4+ 小时 → 缺口
  ];
  assert.equal(evaluateSeries(gapPts, CFG).state, 'NORMAL');
});

test('缺口不关闭告警，也不计入恢复', () => {
  const gapPts = [
    { t: T0, v: 11 }, { t: T0 + 30 * 60000, v: 11 }, { t: T0 + 60 * 60000, v: 11 }, // 告警
    { t: T0 + 6 * H, v: 5 },   // 缺口 + 恢复(1)
    { t: T0 + 6.5 * H, v: 5 }, // 恢复(2) → 关闭
  ];
  const r = evaluateSeries(gapPts, CFG);
  assert.equal(r.state, 'NORMAL');
  assert.deepEqual(r.events.map(e => e.type), ['opened', 'closed']);
  // 缺口后仅 1 个恢复读数 → 仍告警
  const still = evaluateSeries(gapPts.slice(0, 4), CFG);
  assert.equal(still.state, 'ALERT');
});

test('isGap 判定', () => {
  assert.equal(isGap(T0, T0 + 30 * 60000, CFG), false);
  assert.equal(isGap(T0, T0 + 61 * 60000, CFG), true);
});

test('低于下限同样触发，下限恢复同理', () => {
  const r = evaluateSeries(pts([-1, -2, -3]), CFG);
  assert.equal(r.state, 'ALERT');
  assert.equal(evaluateSeries(pts([-1, -2, -3, 4, 4]), CFG).state, 'NORMAL');
});
