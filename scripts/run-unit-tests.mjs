// 单元测试入口（兼容各 Node 版本）。
// 部分 Node 版本执行 `node --test <目录>` 会把目录当作模块加载并立即失败，
// 因此这里显式枚举 tests/unit 下的测试文件再交给 node --test。
// 每个测试文件本身也是独立可运行的：`node tests/unit/xxx.test.js`。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const unitDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'unit');
const files = readdirSync(unitDir)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => join(unitDir, f));

if (!files.length) {
  console.error('未找到任何测试文件');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
