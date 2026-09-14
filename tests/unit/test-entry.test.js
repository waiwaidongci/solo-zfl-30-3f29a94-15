// 测试入口回归：部分 Node 版本把 `node --test <目录>` 的目录当模块加载而失败，
// 因此每个测试文件必须能被 node 直接执行（不依赖目录扫描）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SELF = 'test-entry.test.js';

test('每个测试文件都可被 node 直接执行', () => {
  const files = readdirSync(here)
    .filter(f => f.endsWith('.test.js') && f !== SELF)
    .sort();
  assert.ok(files.length >= 5, `测试文件数量异常：${files.join(',')}`);
  // 剥离父测试运行器注入的环境变量，模拟用户在 shell 中直接执行
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')));
  for (const f of files) {
    const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8', timeout: 60000, env });
    assert.equal(r.status, 0, `${f} 直接运行失败（退出码 ${r.status}）：\n${(r.stderr || r.stdout).slice(-600)}`);
    assert.match(r.stdout, /# pass [1-9]\d*/, `${f} 直接运行未报告任何通过的测试`);
  }
});
