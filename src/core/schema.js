// 公共常量、默认配置与工具函数。浏览器与 Node 通用的纯 ESM 模块。

export const METRICS = {
  temperature:     { name: '水温',   unit: '°C'   },
  salinity:        { name: '盐度',   unit: 'PSU'  },
  ph:              { name: 'pH',     unit: ''     },
  dissolvedOxygen: { name: '溶解氧', unit: 'mg/L' },
  turbidity:       { name: '浊度',   unit: 'NTU'  },
  current:         { name: '流速',   unit: 'm/s'  },
};

// 指标默认阈值与告警迟滞参数。
// warn* 预警阈值；recover* 恢复阈值（位于预警内侧形成回差）；openAfter 连续超标次数才告警；
// closeAfter 连续回到恢复带内次数才关闭；intervalMinutes 标称采样间隔；gapFactor 超过
// interval*gapFactor 视为缺口；maxAgeHours 数据保鲜期（超时视为失联/过期）。
export const DEFAULT_METRIC_CONFIG = {
  temperature:     { warnLow: 2,   warnHigh: 28,  recoverLow: 4,   recoverHigh: 26,  openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: false, maxReadingAgeDays: 90 },
  salinity:        { warnLow: 28,  warnHigh: 36,  recoverLow: 29,  recoverHigh: 35,  openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: false, maxReadingAgeDays: 90 },
  ph:              { warnLow: 7.4, warnHigh: 8.6, recoverLow: 7.5, recoverHigh: 8.5, openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: false, maxReadingAgeDays: 90 },
  dissolvedOxygen: { warnLow: 5.5, warnHigh: 14,  recoverLow: 6.0, recoverHigh: 13,  openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: true,  maxReadingAgeDays: 90 },
  turbidity:       { warnLow: 0,   warnHigh: 25,  recoverLow: 0,   recoverHigh: 20,  openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: false, maxReadingAgeDays: 90 },
  current:         { warnLow: 0,   warnHigh: 0.8, recoverLow: 0,   recoverHigh: 0.6, openAfter: 3, closeAfter: 3, intervalMinutes: 30, gapFactor: 2.5, maxAgeHours: 6,  critical: true,  maxReadingAgeDays: 90 },
};

export const QUARANTINE_REASONS = {
  unknown_sensor:      '未登记传感器',
  invalid_time:        '非法时间戳',
  future_time:         '时间戳在未来',
  expired:             '过期数据',
  missing_value:       '缺测',
  duplicate_timestamp: '重复时间戳',
  calibration_overlap: '校准区间重叠',
};

export const RISK_LEVELS = ['OK', 'WATCH', 'ALERT', 'DEGRADED', 'NO_DATA'];

export const RISK_LABELS = {
  OK: '正常', WATCH: '关注', ALERT: '告警', DEGRADED: '已降级', NO_DATA: '无数据',
};

// 稳定序列化（键排序），用于配置哈希与结果摘要。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// FNV-1a 32 位哈希，足够做变更检测与一致性摘要。
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashObject(obj) {
  return hashString(stableStringify(obj));
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 0xffff;
  const rand = (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(16)}_${rand}`;
}

export function round3(x) {
  return Math.round(x * 1000) / 1000;
}
