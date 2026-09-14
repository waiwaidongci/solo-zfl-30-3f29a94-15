// 首次启动的演示数据：一处遗址、两个站点、六个传感器（含两个关键指标）。

import { DEFAULT_METRIC_CONFIG, uid } from './schema.js';

export function seedDemo(state) {
  const siteId = uid('site');
  const stA = uid('st');
  const stB = uid('st');
  state.sites.push({ id: siteId, name: '南海一号沉船遗址' });
  state.stations.push(
    { id: stA, siteId, name: '船艏监测站' },
    { id: stB, siteId, name: '船艉监测站' },
  );
  const defs = [
    [stA, 'S1-水温', 'temperature'], [stA, 'S2-溶解氧', 'dissolvedOxygen'],
    [stA, 'S3-浊度', 'turbidity'], [stB, 'S4-盐度', 'salinity'],
    [stB, 'S5-pH', 'ph'], [stB, 'S6-流速', 'current'],
  ];
  for (const [stationId, name, metric] of defs) {
    state.sensors.push({
      id: uid('sen'), stationId, name, metric,
      cfg: { ...DEFAULT_METRIC_CONFIG[metric] },
    });
  }
  return state;
}
