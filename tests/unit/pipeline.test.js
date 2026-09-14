import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configHash, dataHash, recompute, publish, rollback, currentStatus, computeResults,
} from '../../src/core/pipeline.js';
import { createEmptyState } from '../../src/core/store.js';

const H = 3600000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

function makeState() {
  const s = createEmptyState();
  s.sites.push({ id: 'site1', name: '遗址一' });
  s.stations.push({ id: 'st1', siteId: 'site1', name: '站点一' });
  s.sensors.push({
    id: 'sen1', stationId: 'st1', name: '溶解氧', metric: 'dissolvedOxygen',
    cfg: {
      warnLow: 5.5, warnHigh: 14, recoverLow: 6, recoverHigh: 13,
      openAfter: 3, closeAfter: 2, intervalMinutes: 30, gapFactor: 2,
      maxAgeHours: 6, critical: true, maxReadingAgeDays: 90,
    },
  });
  // 连续 3 次低于下限 → 应产生活动告警
  s.series.sen1 = [0, 1, 2].map(i => ({ t: NOW - (3 - i) * 30 * 60000, v: 5.0, raw: 5.0, calibrated: false }));
  return s;
}

test('重算→发布→状态新鲜；报告内容正确', () => {
  const s = makeState();
  const v = recompute(s, NOW);
  assert.equal(v.consistent, true);
  publish(s, v.id);
  const st = currentStatus(s);
  assert.equal(st.stale, false);
  assert.equal(st.published.id, 'v1');
  assert.equal(st.published.results.risks.site1.level, 'ALERT');
  assert.equal(st.published.reports.site1.level, 'ALERT');
  assert.equal(st.published.reports.site1.validReadings, 3);
});

test('修改阈值后立即失效；重算发布恢复新鲜', () => {
  const s = makeState();
  publish(s, recompute(s, NOW).id);
  assert.equal(currentStatus(s).stale, false);
  s.sensors[0].cfg.warnLow = 1; // 改阈值
  assert.equal(currentStatus(s).stale, true); // 立即失效
  publish(s, recompute(s, NOW).id);
  assert.equal(currentStatus(s).stale, false);
  assert.equal(currentStatus(s).published.results.risks.site1.level, 'OK'); // 新阈值下不再超标
});

test('修改校准记录同样立即失效', () => {
  const s = makeState();
  publish(s, recompute(s, NOW).id);
  const before = configHash(s);
  s.calibrations.push({ id: 'c1', sensorId: 'sen1', start: 0, end: NOW, gain: 1, offset: 0 });
  assert.notEqual(configHash(s), before);
  assert.equal(currentStatus(s).stale, true);
});

test('新数据导入（数据哈希变化）也会失效', () => {
  const s = makeState();
  publish(s, recompute(s, NOW).id);
  const before = dataHash(s);
  s.series.sen1.push({ t: NOW, v: 7, raw: 7, calibrated: false });
  assert.notEqual(dataHash(s), before);
  assert.equal(currentStatus(s).stale, true);
});

test('重算失败（数据损坏）保留上版', () => {
  const s = makeState();
  publish(s, recompute(s, NOW).id);
  const publishedBefore = s.publishedVersionId;
  s.series.sen1.push({ t: NOW, v: NaN, raw: NaN, calibrated: false }); // 损坏数据
  assert.throws(() => recompute(s, NOW), /数据损坏/);
  assert.equal(s.publishedVersionId, publishedBefore); // 上版保留
  assert.equal(s.versions.length, 1); // 未产生新版本
});

test('过期版本禁止发布', () => {
  const s = makeState();
  const v1 = recompute(s, NOW);
  s.sensors[0].cfg.warnLow = 1; // 配置变更使 v1 过期
  assert.throws(() => publish(s, v1.id), /已过期/);
  assert.equal(s.publishedVersionId, null);
});

test('回滚：恢复旧版配置快照并指向旧版', () => {
  const s = makeState();
  const v1 = recompute(s, NOW);
  publish(s, v1.id);
  const originalWarnLow = s.sensors[0].cfg.warnLow;

  s.sensors[0].cfg.warnLow = 1;
  const v2 = recompute(s, NOW);
  publish(s, v2.id);
  assert.equal(currentStatus(s).published.results.risks.site1.level, 'OK');

  rollback(s, v1.id);
  assert.equal(s.publishedVersionId, v1.id);
  assert.equal(s.sensors[0].cfg.warnLow, originalWarnLow); // 配置随版本回滚
  assert.equal(currentStatus(s).stale, false); // 回滚后配置与版本一致
  assert.equal(currentStatus(s).published.results.risks.site1.level, 'ALERT');
});

test('同一输入两次计算摘要一致（确定性）', () => {
  const s = makeState();
  const a = computeResults(s, NOW);
  const b = computeResults(s, NOW);
  assert.deepEqual(a, b);
});

test('回滚恢复完整传感器集合：发布后新增的传感器/校准/数据不残留', () => {
  const s = makeState();
  const v1 = recompute(s, NOW);
  publish(s, v1.id);

  // 发布 v1 后：新增传感器（含读数）、新增校准记录，发布 v2
  s.sensors.push({
    id: 'sen2', stationId: 'st1', name: '浊度', metric: 'turbidity',
    cfg: {
      warnLow: 0, warnHigh: 25, recoverLow: 0, recoverHigh: 20,
      openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5,
      maxAgeHours: 6, critical: false, maxReadingAgeDays: 90,
    },
  });
  s.series.sen2 = [{ t: NOW - 30 * 60000, v: 3, raw: 3, calibrated: false }];
  s.calibrations.push({ id: 'cal-new', sensorId: 'sen1', start: 0, end: NOW, gain: 1, offset: 0 });
  const v2 = recompute(s, NOW);
  publish(s, v2.id);
  assert.equal(currentStatus(s).stale, false);
  assert.equal(s.sensors.length, 2);

  rollback(s, v1.id);

  // 新增项全部移除，完整恢复 v1 的传感器集合与配置
  assert.deepEqual(s.sensors.map(x => x.id), ['sen1']);
  assert.equal(s.series.sen2, undefined);
  assert.equal(s.calibrations.length, 0);
  // 哈希与 v1 一致 → 不再失效，旧版结果完整可用
  assert.equal(configHash(s), v1.configHash);
  assert.equal(dataHash(s), v1.dataHash);
  const st = currentStatus(s);
  assert.equal(st.stale, false);
  assert.equal(st.published.id, 'v1');
  assert.equal(st.published.results.risks.site1.level, 'ALERT');
  assert.equal(st.published.reports.site1.validReadings, 3);
});

test('回滚后再次重算发布：流程不受残留影响', () => {
  const s = makeState();
  const v1 = recompute(s, NOW);
  publish(s, v1.id);
  s.sensors.push({
    id: 'sen2', stationId: 'st1', name: '浊度', metric: 'turbidity',
    cfg: { ...s.sensors[0].cfg, critical: false },
  });
  publish(s, recompute(s, NOW).id); // v2
  rollback(s, v1.id);
  // 回滚后立即重算发布，应当成功且结果与 v1 一致
  const v3 = recompute(s, NOW);
  publish(s, v3.id);
  assert.equal(currentStatus(s).stale, false);
  assert.equal(v3.digest, v1.digest);
});
