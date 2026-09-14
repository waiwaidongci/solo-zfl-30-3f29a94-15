// 截图脚本：生成演示数据后抓取各页面在桌面与手机视口下的样子。
import { chromium } from '@playwright/test';

const libs = ['/tmp/debs/root/usr/lib/aarch64-linux-gnu', '/tmp/debs/root/lib/aarch64-linux-gnu'].join(':');
process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');

const BASE = 'http://127.0.0.1:8734';
const browser = await chromium.launch();

async function shoot(name, viewport, tab, prep) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__app);
  if (prep) await prep(page);
  if (tab) await page.click(`nav.tabs button[data-tab="${tab}"]`);
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: false });
  await page.close();
  console.log('shot:', name);
}

// 造一批演示数据：浊度传感器连续超标触发告警，流速缺失触发降级
const prepAlert = async page => {
  await page.evaluate(() => {
    const s = window.__app.state;
    const turb = s.sensors.find(x => x.metric === 'turbidity');
    const rows = [0, 1, 2, 3, 4].map(i =>
      `${turb.id},${new Date(Date.now() - (150 - i * 30) * 60000).toISOString()},${28 + i}`);
    const others = s.sensors.filter(x => !['turbidity', 'current'].includes(x.metric));
    for (const o of others) {
      rows.push(`${o.id},${new Date(Date.now() - 3600000).toISOString()},${{ temperature: 20, salinity: 33, ph: 8.1, dissolvedOxygen: 7 }[o.metric] ?? 5}`);
    }
    window.__app.importText('sensor,time,value\n' + rows.join('\n'));
    window.__app.recomputeAndPublish();
  });
};

await shoot('desktop-overview', { width: 1280, height: 800 }, 'overview', prepAlert);
await shoot('desktop-alerts', { width: 1280, height: 800 }, 'alerts', prepAlert);
await shoot('desktop-reports', { width: 1280, height: 800 }, 'reports', prepAlert);
await shoot('desktop-registry', { width: 1280, height: 800 }, 'registry', null);
await shoot('mobile-overview', { width: 375, height: 812 }, 'overview', prepAlert);
await shoot('mobile-import', { width: 375, height: 812 }, 'import', null);
await browser.close();
