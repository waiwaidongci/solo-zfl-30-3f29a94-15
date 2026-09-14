// 版本化重算管线：失效 → 重算 → 一致性校验 → 发布 → 回滚。
//
// 配置（阈值、校准记录、传感器登记）或有效序列变化后，已发布版本立即失效；
// 重算对同一输入连续执行两次，摘要一致才允许发布；
// 重算/发布失败时不影响已发布版本（失败保留上版）；
// 回滚 = 恢复历史版本的配置快照并重新指向该版本。

import { hashObject } from './schema.js';
import { evaluateAll } from './alerts.js';
import { computeSiteRisk } from './risk.js';
import { METRICS } from './schema.js';

// ---- 配置与数据快照 ----

const byId = (a, b) => (a.id < b.id ? -1 : 1);
const clone = x => JSON.parse(JSON.stringify(x));

export function configSnapshot(state) {
  return {
    sites: state.sites.map(s => ({ ...s })).sort(byId),
    stations: state.stations.map(s => ({ ...s })).sort(byId),
    sensors: state.sensors.map(s => ({ id: s.id, stationId: s.stationId, name: s.name, metric: s.metric, cfg: { ...s.cfg } }))
      .sort(byId),
    calibrations: state.calibrations.map(c => ({ ...c })).sort(byId),
  };
}

export function configHash(state) {
  return hashObject(configSnapshot(state));
}

export function dataHash(state) {
  return hashObject(state.series);
}

// ---- 结果计算（纯函数，同一输入必须得到同一输出）----

function validateSeries(series) {
  for (const [sensorId, points] of Object.entries(series)) {
    let prev = -Infinity;
    for (const p of points) {
      if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) {
        throw new Error(`数据损坏：传感器 ${sensorId} 存在非法读数，已中止重算`);
      }
      if (p.t < prev) throw new Error(`数据损坏：传感器 ${sensorId} 序列未按时间排序`);
      prev = p.t;
    }
  }
}

export function computeResults(state, now) {
  validateSeries(state.series);
  const cfgOf = id => (state.sensors.find(s => s.id === id) || {}).cfg;
  const { bySensor: alertsBySensor, active } = evaluateAll(state.series, cfgOf);

  const sensorsBySite = new Map(state.sites.map(site => [site.id, []]));
  for (const sensor of state.sensors) {
    const station = state.stations.find(st => st.id === sensor.stationId);
    if (!station || !sensorsBySite.has(station.siteId)) continue;
    sensorsBySite.get(station.siteId).push({
      id: sensor.id,
      name: sensor.name,
      metric: sensor.metric,
      metricName: METRICS[sensor.metric]?.name || sensor.metric,
      stationName: station.name,
    });
  }

  const risks = {};
  for (const site of state.sites) {
    risks[site.id] = computeSiteRisk({
      sensors: sensorsBySite.get(site.id) || [],
      seriesBySensor: state.series,
      activeAlerts: active,
      cfgOf,
      now,
    });
  }
  return { alertsBySensor, activeAlerts: active, risks };
}

export function resultDigest(results) {
  return hashObject(results);
}

function buildReports(state, results, now) {
  const reports = {};
  const quarantineBySensor = {};
  for (const q of state.quarantine) {
    quarantineBySensor[q.sensorId] = (quarantineBySensor[q.sensorId] || 0) + 1;
  }
  for (const site of state.sites) {
    const risk = results.risks[site.id];
    const siteSensorIds = new Set(
      state.sensors
        .filter(s => state.stations.some(st => st.id === s.stationId && st.siteId === site.id))
        .map(s => s.id),
    );
    let quarantined = 0, valid = 0;
    for (const id of siteSensorIds) {
      quarantined += quarantineBySensor[id] || 0;
      valid += (state.series[id] || []).length;
    }
    reports[site.id] = {
      siteId: site.id,
      siteName: site.name,
      generatedAt: now,
      level: risk.level,
      score: risk.score,
      coverage: risk.coverage,
      fresh: risk.fresh,
      total: risk.total,
      activeAlerts: risk.activeAlerts,
      reasons: risk.reasons,
      validReadings: valid,
      quarantinedReadings: quarantined,
    };
  }
  return reports;
}

// ---- 重算与发布 ----

// 重算：同一 now 下连续计算两次，摘要一致才生成候选版本。
// 任何异常（数据损坏、计算不一致）都向上抛出，调用方保持已发布版本不变。
export function recompute(state, now) {
  const snap = configSnapshot(state);
  const runA = computeResults(state, now);
  const runB = computeResults(state, now);
  const digestA = resultDigest(runA);
  const digestB = resultDigest(runB);
  if (digestA !== digestB) {
    throw new Error('两次重算结果不一致，已中止发布');
  }
  const version = {
    id: `v${state.versions.length + 1}`,
    seq: state.versions.length + 1,
    createdAt: now,
    configHash: hashObject(snap),
    dataHash: dataHash(state),
    configSnapshot: snap,
    seriesSnapshot: clone(state.series), // 回滚时完整恢复有效序列
    digest: digestA,
    consistent: true,
    results: runA,
    reports: buildReports(state, runA, now),
  };
  state.versions.push(version);
  return version;
}

export function currentStatus(state) {
  const published = state.versions.find(v => v.id === state.publishedVersionId) || null;
  const cfgHash = configHash(state);
  const dHash = dataHash(state);
  const stale = !published || published.configHash !== cfgHash || published.dataHash !== dHash;
  return { published, stale, configHash: cfgHash, dataHash: dHash };
}

// 发布：只允许发布与当前配置、当前数据一致且通过一致性校验的候选版本。
export function publish(state, versionId) {
  const version = state.versions.find(v => v.id === versionId);
  if (!version) throw new Error(`版本 ${versionId} 不存在`);
  if (!version.consistent) throw new Error(`版本 ${versionId} 未通过一致性校验，禁止发布`);
  const { configHash: cfgHash, dataHash: dHash } = currentStatus(state);
  if (version.configHash !== cfgHash) throw new Error(`版本 ${versionId} 的配置已过期，需重新重算`);
  if (version.dataHash !== dHash) throw new Error(`版本 ${versionId} 的数据已过期，需重新重算`);
  state.publishedVersionId = version.id;
  return version;
}

// 回滚：完整恢复目标版本的配置（遗址/站点/传感器集合与阈值、校准记录）与有效序列，
// 并将发布指针指向它。回滚后配置哈希、数据哈希均与该版本一致，结果立即恢复有效；
// 此后新增的传感器、校准或读数不会残留，也就不会破坏旧版结果。
export function rollback(state, versionId) {
  const version = state.versions.find(v => v.id === versionId);
  if (!version) throw new Error(`版本 ${versionId} 不存在`);
  const snap = version.configSnapshot;
  // 兼容早期版本快照（缺少 sites/stations/seriesSnapshot 时保留现状）
  if (snap.sites) state.sites = snap.sites.map(s => ({ ...s }));
  if (snap.stations) state.stations = snap.stations.map(s => ({ ...s }));
  state.sensors = snap.sensors.map(s => ({ ...s, cfg: { ...s.cfg } }));
  state.calibrations = snap.calibrations.map(c => ({ ...c }));
  if (version.seriesSnapshot) state.series = clone(version.seriesSnapshot);
  state.publishedVersionId = version.id;
  return version;
}
