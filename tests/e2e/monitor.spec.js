import { test, expect } from '@playwright/test';

const HEADER = 'sensor,time,value\n';

// 打开应用并清空本地数据（得到干净的演示种子数据）
async function freshApp(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.state.sensors.length > 0);
  expect(errors).toEqual([]);
  return errors;
}

const sensorId = (page, metric) =>
  page.evaluate(m => window.__app.state.sensors.find(s => s.metric === m)?.id, metric);

// 生成 CSV 行：values[0] 位于 startAgoMin 分钟前，按 stepMin 递增
function csvRows(sid, startAgoMin, values, stepMin = 30) {
  const base = Date.now() - startAgoMin * 60000;
  return values.map((v, i) =>
    `${sid},${new Date(base + i * stepMin * 60000).toISOString()},${v}`).join('\n');
}

async function importCsv(page, csv) {
  await page.click('nav.tabs button[data-tab="import"]');
  await page.fill('#importText', csv);
  await page.click('#importBtn');
}

async function republish(page) {
  await page.click('nav.tabs button[data-tab="reports"]');
  await page.click('#recomputePublishBtn2');
  await page.waitForSelector('[data-testid="reports-fresh"]');
}

const alertState = (page, sid) =>
  page.evaluate(id => {
    const pub = window.__app.status().published;
    return pub ? pub.results.alertsBySensor[id]?.state : null;
  }, sid);

test('导入隔离：重复时间戳、缺测、过期、校准重叠均不进入有效序列', async ({ page }) => {
  await freshApp(page);
  const sid = await sensorId(page, 'turbidity');

  // 构造两条重叠的校准记录（窗口：5.5h~4h 前 与 4.5h~3h 前，重叠 4.5h~4h 前）
  await page.evaluate(id => {
    const H = 3600000, now = Date.now();
    window.__app.state.calibrations.push(
      { id: 'calA', sensorId: id, start: now - 5.5 * H, end: now - 4 * H, gain: 1, offset: 0 },
      { id: 'calB', sensorId: id, start: now - 4.5 * H, end: now - 3 * H, gain: 1, offset: 0 },
    );
    window.__app.save();
  }, sid);

  const t = m => new Date(Date.now() - m * 60000).toISOString();
  const csv = HEADER + [
    `${sid},${t(600)},10`,                          // 有效
    `${sid},${t(570)},11`,                          // 有效
    `${sid},${t(540)},12`,                          // 有效
    `${sid},${t(540)},99`,                          // 重复时间戳 → 隔离
    `${sid},${t(510)},`,                            // 缺测 → 隔离
    `${sid},${t(255)},15`,                          // 校准重叠区(4.25h前) → 隔离
    `${sid},${new Date(Date.now() - 100 * 86400000).toISOString()},8`, // 过期 → 隔离
    `NO_SUCH,${t(480)},5`,                          // 未登记传感器 → 隔离
  ].join('\n');

  await importCsv(page, csv);
  await expect(page.locator('[data-testid="accepted-count"]')).toHaveText('有效 3 条');
  await expect(page.locator('[data-testid="quarantined-count"]')).toHaveText('隔离 5 条');
  for (const reason of ['duplicate_timestamp', 'missing_value', 'calibration_overlap', 'expired', 'unknown_sensor']) {
    await expect(page.locator(`#importSummary [data-reason="${reason}"]`)).toBeVisible();
  }

  // 有效序列只含 3 条
  const seriesLen = await page.evaluate(id => window.__app.state.series[id].length, sid);
  expect(seriesLen).toBe(3);

  // 隔离区页面逐条可见且带原因
  await page.click('nav.tabs button[data-tab="quarantine"]');
  for (const label of ['重复时间戳', '缺测', '过期数据', '校准区间重叠', '未登记传感器']) {
    await expect(page.locator('#qTable')).toContainText(label);
  }
});

test('告警迟滞：连续超标才告警，抖动与回差不触发，回落保持才关闭', async ({ page }) => {
  await freshApp(page);
  const sid = await sensorId(page, 'turbidity'); // warnHigh 25 / recoverHigh 20 / 开3 关3

  // 批次1：抖动序列 超-超-正常-超-超 → 不得告警
  await importCsv(page, HEADER + csvRows(sid, 600, [30, 30, 10, 30, 30]));
  await republish(page);
  expect(await alertState(page, sid)).toBe('NORMAL');

  // 批次2：连续 3 次超标 → 告警
  await importCsv(page, HEADER + csvRows(sid, 450, [30, 30, 30]));
  await republish(page);
  expect(await alertState(page, sid)).toBe('ALERT');
  await page.click('nav.tabs button[data-tab="alerts"]');
  await expect(page.locator(`[data-alert-sensor="${sid}"]`)).toContainText('告警中');

  // 批次3：回落1次→回差区(22)→回落1次 → 回差清零恢复计数，仍告警
  await importCsv(page, HEADER + csvRows(sid, 360, [10, 22, 10]));
  await republish(page);
  expect(await alertState(page, sid)).toBe('ALERT');

  // 批次4：再连续回落2次（累计连续3次）→ 关闭
  await importCsv(page, HEADER + csvRows(sid, 270, [10, 10]));
  await republish(page);
  expect(await alertState(page, sid)).toBe('NORMAL');
  await page.click('nav.tabs button[data-tab="alerts"]');
  await expect(page.locator('#activeAlerts')).toContainText('无活动告警');
});

test('失联降级：关键指标失联时遗址降级并说明原因，恢复后解除', async ({ page }) => {
  await freshApp(page);
  // 除关键指标「流速」外全部导入 1 小时前的正常数据
  const normal = { temperature: 20, salinity: 33, ph: 8.1, dissolvedOxygen: 7, turbidity: 5 };
  for (const [metric, v] of Object.entries(normal)) {
    const sid = await sensorId(page, metric);
    await importCsv(page, HEADER + csvRows(sid, 60, [v]));
  }
  await republish(page);

  await page.click('nav.tabs button[data-tab="overview"]');
  const card = page.locator('.site-card').first();
  await expect(card.locator('[data-testid="risk-level"]')).toHaveText('已降级');
  await expect(card.locator('[data-testid="degraded-reasons"]')).toContainText('流速');
  await expect(card.locator('[data-testid="degraded-reasons"]')).toContainText('无任何有效数据');
  await expect(card.locator('[data-testid="coverage"]')).toContainText('83%'); // 5/6

  // 补登流速数据后重算发布 → 解除降级
  const curSid = await sensorId(page, 'current');
  await importCsv(page, HEADER + csvRows(curSid, 30, [0.2]));
  await republish(page);
  await page.click('nav.tabs button[data-tab="overview"]');
  await expect(page.locator('.site-card [data-testid="risk-level"]').first()).toHaveText('正常');
});

test('失效复算：改阈值立即失效，重算一致后发布恢复有效', async ({ page }) => {
  await freshApp(page);
  const sid = await sensorId(page, 'turbidity');
  await importCsv(page, HEADER + csvRows(sid, 90, [30, 30, 30]));
  await republish(page);
  expect(await alertState(page, sid)).toBe('ALERT');
  await expect(page.locator('[data-testid="stale-badge"]')).not.toBeVisible();

  // 通过 UI 修改阈值 warnHigh 25 → 100
  await page.click('nav.tabs button[data-tab="registry"]');
  await page.click(`.sensor-editor[data-sensor-id="${sid}"] summary`);
  await page.fill(`.sensor-editor[data-sensor-id="${sid}"] [data-cfg-key="warnHigh"]`, '100');
  await page.click(`.sensor-editor[data-sensor-id="${sid}"] [data-action="save-cfg"]`);

  // 立即失效
  await expect(page.locator('[data-testid="stale-badge"]')).toBeVisible();
  await page.click('nav.tabs button[data-tab="reports"]');
  await expect(page.locator('[data-testid="reports-stale"]')).toBeVisible();

  // 重算并发布 → 恢复有效，告警按新阈值关闭
  await page.click('#recomputePublishBtn2');
  await expect(page.locator('[data-testid="reports-fresh"]')).toBeVisible();
  await expect(page.locator('[data-testid="stale-badge"]')).not.toBeVisible();
  expect(await alertState(page, sid)).toBe('NORMAL');
});

test('发布回滚：回滚恢复旧版配置与结果；重算失败保留上版', async ({ page }) => {
  await freshApp(page);
  const sid = await sensorId(page, 'turbidity');
  await importCsv(page, HEADER + csvRows(sid, 90, [30, 30, 30]));
  await republish(page); // v1：ALERT，warnHigh=25

  // 改阈值 → 发布 v2（NORMAL）
  await page.evaluate(id => {
    window.__app.state.sensors.find(s => s.id === id).cfg.warnHigh = 100;
    window.__app.save();
  }, sid);
  await republish(page); // v2
  expect(await alertState(page, sid)).toBe('NORMAL');

  // 回滚到 v1：配置随版本恢复，结果回到 ALERT，状态不失效
  await page.click('nav.tabs button[data-tab="reports"]');
  await page.click('[data-version="v1"] [data-action="rollback"]');
  await expect(page.locator('[data-testid="reports-fresh"]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.state.publishedVersionId)).toBe('v1');
  expect(await page.evaluate(id => window.__app.state.sensors.find(s => s.id === id).cfg.warnHigh, sid)).toBe(25);
  expect(await alertState(page, sid)).toBe('ALERT');

  // 损坏数据后重算失败 → 保留上版（仍 v1，版本数不变）
  await page.evaluate(id => {
    window.__app.state.series[id].push({ t: Date.now(), v: NaN, raw: NaN, calibrated: false });
    window.__app.save();
  }, sid);
  await page.click('nav.tabs button[data-tab="reports"]');
  await page.click('#recomputeBtn');
  await expect(page.locator('#toast')).toContainText('重算失败');
  await expect(page.locator('#toast')).toContainText('保留上一发布版');
  expect(await page.evaluate(() => window.__app.state.publishedVersionId)).toBe('v1');
  expect(await page.evaluate(() => window.__app.state.versions.length)).toBe(2);
});

test('回滚恢复完整传感器集合：旧版发布后新增的传感器不残留', async ({ page }) => {
  await freshApp(page);
  const sid = await sensorId(page, 'turbidity');
  await importCsv(page, HEADER + csvRows(sid, 90, [30, 30, 30]));
  await republish(page); // v1
  const sensorCount = await page.evaluate(() => window.__app.state.sensors.length);

  // 通过 UI 新增传感器并发布 v2
  await page.click('nav.tabs button[data-tab="registry"]');
  await page.fill('#sensorName', '新增备用传感器');
  await page.selectOption('#sensorMetric', 'ph');
  await page.click('#addSensorBtn');
  expect(await page.evaluate(() => window.__app.state.sensors.length)).toBe(sensorCount + 1);
  await republish(page); // v2
  await expect(page.locator('[data-testid="reports-fresh"]')).toBeVisible();

  // 回滚 v1：新增传感器应从当前配置中消失，旧版立即恢复有效
  await page.click('nav.tabs button[data-tab="reports"]');
  await page.click('[data-version="v1"] [data-action="rollback"]');
  await expect(page.locator('[data-testid="reports-fresh"]')).toBeVisible();
  await expect(page.locator('[data-testid="stale-badge"]')).not.toBeVisible();
  expect(await page.evaluate(() => window.__app.state.publishedVersionId)).toBe('v1');
  expect(await page.evaluate(() => window.__app.state.sensors.length)).toBe(sensorCount);
  expect(await page.evaluate(() => window.__app.status().stale)).toBe(false);

  // 登记页与隔离/告警流程不受影响
  await page.click('nav.tabs button[data-tab="registry"]');
  await expect(page.locator('#sensorList')).not.toContainText('新增备用传感器');
  await expect(page.locator('#sensorList')).toContainText('浊度');
});

test('响应式：手机与桌面均可操作', async ({ page }) => {
  // 桌面
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshApp(page);
  await expect(page.locator('nav.tabs')).toBeVisible();
  await page.click('nav.tabs button[data-tab="import"]');
  await expect(page.locator('#importText')).toBeVisible();

  // 手机
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await page.waitForFunction(() => window.__app);
  await expect(page.locator('nav.tabs')).toBeVisible();
  await page.click('nav.tabs button[data-tab="quarantine"]');
  await expect(page.locator('#page-quarantine .panel')).toBeVisible();
  await page.click('nav.tabs button[data-tab="overview"]');
  await expect(page.locator('#page-overview')).toBeVisible();
});
