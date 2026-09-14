import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// 容器内无 root，Chromium 系统库解压在本目录；注入 LD_LIBRARY_PATH 供浏览器进程使用
const LOCAL_LIBS = ['/tmp/debs/root/usr/lib/aarch64-linux-gnu', '/tmp/debs/root/lib/aarch64-linux-gnu']
  .filter(p => existsSync(p));
if (LOCAL_LIBS.length) {
  process.env.LD_LIBRARY_PATH = [...LOCAL_LIBS, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8734',
    headless: true,
  },
  webServer: {
    command: 'node scripts/serve.js',
    url: 'http://127.0.0.1:8734',
    reuseExistingServer: false,
  },
});
