// 持久化层：localStorage（浏览器）或内存后备（Node 测试）。

const KEY = 'uwHeritageMonitor.v1';

const memoryStorage = (() => {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
  };
})();

function defaultStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* 隐私模式等场景 */ }
  return memoryStorage;
}

export function createEmptyState() {
  return {
    sites: [],
    stations: [],
    sensors: [],
    calibrations: [],
    series: {},        // sensorId -> [{t, v, raw, calibrated}] 有效序列（升序）
    quarantine: [],    // 隔离区记录
    versions: [],
    publishedVersionId: null,
  };
}

export function loadState(storage = defaultStorage()) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return createEmptyState();
    return { ...createEmptyState(), ...JSON.parse(raw) };
  } catch {
    return createEmptyState();
  }
}

export function saveState(state, storage = defaultStorage()) {
  storage.setItem(KEY, JSON.stringify(state));
}

export function resetState(storage = defaultStorage()) {
  storage.removeItem(KEY);
}

// 将导入接受的读数并入有效序列并保持升序。
export function mergeSeries(state, accepted) {
  for (const p of accepted) {
    const arr = (state.series[p.sensorId] ||= []);
    arr.push({ t: p.t, v: p.v, raw: p.raw, calibrated: p.calibrated });
  }
  for (const id of Object.keys(state.series)) {
    state.series[id].sort((a, b) => a.t - b.t);
  }
}

export function recordQuarantine(state, quarantined, batchId, now) {
  for (const q of quarantined) {
    state.quarantine.push({ ...q, batch: batchId, at: now });
  }
}
