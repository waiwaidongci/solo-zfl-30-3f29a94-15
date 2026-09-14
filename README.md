# 水下考古遗址环境监测与暴露风险台

离线运行的遗址环境监测平台：按 **遗址 → 站点 → 传感器** 登记指标，导入读数后依校准记录修正，
问题数据自动隔离，按告警迟滞规则产生告警，计算遗址暴露风险，并以版本化方式重算、发布与回滚。
全部数据保存在浏览器 localStorage，无需网络与服务器数据库。

## 运行

```bash
npm run serve          # 启动静态服务器 http://127.0.0.1:8734
# 或直接用任意静态服务器托管本目录（ES 模块需经 http 访问，不能 file:// 双击打开）
```

首次打开自动生成演示遗址（南海一号沉船遗址，2 站点 6 传感器，溶解氧与流速为关键指标）。

## 测试

```bash
npm test               # 单元测试（node:test，47 项；入口 scripts/run-unit-tests.mjs 显式枚举
                       # 测试文件，兼容把目录当模块加载的旧版 Node）
npm run test:e2e       # 真实浏览器验证（Playwright + Chromium，7 项）
node tests/unit/alerts.test.js  # 每个测试文件也可被 node 直接执行
node scripts/screenshot.mjs     # 生成桌面/手机截图到 /tmp/shots
```

> 本容器无 root，Chromium 系统库已解压至 /tmp/debs/root，playwright.config.js 会自动注入
> LD_LIBRARY_PATH；换环境时执行 `npx playwright install-deps chromium` 即可。

## 核心规则

**导入隔离**（`src/core/ingest.js`）：逐行判定，问题行进入隔离区且不得进入有效序列——
未登记传感器、非法/未来时间戳、过期数据（默认超 90 天）、缺测（空值/非数值）、
重复时间戳（批次内与已入库均查重，保留首条）、校准区间重叠。

**校准修正**（`src/core/calibrate.js`）：修正值 = 原始值 × 增益 + 偏移；同一传感器多条校准
记录的适用窗口重叠时，重叠区读数无法确定适用记录，一律隔离。

**告警迟滞**（`src/core/alerts.js`）：连续 `openAfter` 个有效读数超标才告警；告警后连续
`closeAfter` 个读数回落到恢复带内才关闭。回差区读数两侧都不计数；抖动会清零计数；
时间缺口（间隔 > interval×gapFactor）打断连续性——缺口与抖动都不会造成假告警。

**遗址风险**（`src/core/risk.js`）：由活动告警（关键指标权重更高）与数据覆盖度计算评分，
分级 OK / WATCH / ALERT；关键指标失联（无有效数据或超过保鲜期）时遗址降级 DEGRADED
并逐条说明失联原因。

**版本化发布**（`src/core/pipeline.js`）：阈值、校准或有效序列一变，已发布结果与报告立即
失效；重算对同一输入连续执行两遍，摘要一致才允许发布；重算失败（如数据损坏）保留上一
发布版；回滚完整恢复目标版本的配置（遗址/站点/传感器集合与阈值、校准记录）与有效序列，
此后新增的传感器、校准或读数不会残留，旧版结果与哈希即刻恢复一致。

## 结构

```
index.html            入口（响应式：桌面侧边导航 / 手机底部标签栏）
src/app.js            UI 与交互
src/core/             纯 ESM 域逻辑（浏览器与 Node 通用）
  schema.js           指标定义、默认阈值、哈希工具
  calibrate.js        校准修正与重叠检测
  ingest.js           CSV/JSON 导入与隔离
  alerts.js           告警迟滞状态机
  risk.js             遗址风险与失联降级
  pipeline.js         重算、一致性校验、发布、回滚
  store.js            localStorage 持久化
  seed.js             演示数据
tests/unit/           单元测试（node --test）
tests/e2e/            Playwright 浏览器验证
```

E2E 覆盖需求指定的五条链路：导入隔离、告警迟滞、失联降级、失效复算、发布回滚，
另加手机/桌面响应式冒烟测试。
