# 服务状态（UptimeFlare v4）

跑在 Cloudflare 免费额度上的网站可用性监控 + 状态页。v4 在 v3（单 Worker
全面重写版）基础上进一步精简：**类型化 Durable Object RPC**、单一状态层模块、
页面状态判定与检查轮同源。无框架构建链、无 Pages 项目、无 Terraform/Python。

## 架构

```
┌─ Worker: uptimeflare_worker（唯一运行单元）───────────────────┐
│  Hono SSR 页面:  /            状态页                           │
│                  /m/:id       单监控视图（iframe 友好）         │
│                  /login /manage  管理入口（会话保护）           │
│  JSON API:       /api/data     轻量摘要（CORS *，前端轮询用）  │
│                  /api/status   全量状态（同源，外部消费）      │
│                  /api/badge    Shields.io 徽章                 │
│                  /api/monitors|admin   管理接口                │
│  运维:           /health      健康检查（兼上弦闹钟）          │
│                  /trigger     手动触发（需 secret）           │
│  静态资产:       /app.css /app.js /favicon.*（免费，不计数）   │
│                                                                │
│  MonitorScheduler DO（闹钟主调度，每 10 分钟自续）             │
│    ├─ 类型化 RPC: list/add/update/deleteMonitor + ensureAlarm  │
│    │   / healIfStale / runNow（Worker 经 stub 直调，无 fetch    │
│    │   路由、无 JSON 封装）                                    │
│    └─ runChecks: 按 due 过滤 → 并发检查(失败2次确认)           │
│         → 单批 CAS 原子写 D1 → 写成功后才发通知                 │
│  Cron 0 * * * *（每小时，仅监督：缺失/过期/停滞时重新上弦）    │
└────────────────────────────────────────────────────────────────┘
```

### 关键设计

- **每监控检查间隔**：`intervalMinutes`（10/20/30/60，10 的倍数）。调度器每
  10 分钟 tick 一次，未到期的监控**整轮跳过、零写入**——免费额度随间隔拉长
  线性节省。
- **先持久化后通知**：状态写入 D1（批量 CAS 原子生效）成功后才发通知，
  失败的轮次什么都不发，下一轮重新判定。
- **页面状态与检查轮同源**：首页/详情页状态取自延迟行的 `lastStatus`
  （与 meta 计数同一来源），进行中的故障行优先判定宕机；从未检查的监控
  显示"等待检查"。
- **时间渲染全在客户端**：SSR 只输出结构与时区无关的状态，"x 前"／柱状图／
  事件时间由 `app.js` 按访客时区填充，无 hydration、无框架运行时。
- **D1 行式存储**：`state:meta` / `state:inc:<id>`（事件，90 天）/
  `state:lat:<id>`（延迟+最近状态，12h）。事件行只在变化时写。行布局、
  hex/RLE 编解码与 CAS 读写统一在 `src/state.ts`。

## 管理入口

首次访问 `/login` 创建管理员；`/manage` 添加/编辑/删除站点（编辑保留全部
历史），支持每站点检查间隔（10/20/30/60 分钟）与超时设置。管理页导航的
「站点管理」按钮自动变为「← 返回」。

## 配置

`src/config.ts`：页面标题/链接/图标（`pageConfig`）、通知
（`workerConfig.notification`：timeZone、gracePeriod、skipNotificationIds、
skipErrorChangeNotification）、维护窗口（`maintenances`）。

### 通知渠道

「及时通知」(timelynotify) GET 推送。`src/notify.ts` 的
「通知区域修改开始/结束」标记内改常量即可换渠道：`PUSH_BASE_URL`
（key 拼在路径里）、`PUSH_ICON`、`PUSH_GROUP`、`PUSH_TTL_SEC`、
`PUSH_SOUND`；标题/正文经 URL 编码后作为路径段。

## 本地开发

```bash
npm install
npx wrangler d1 execute uptimeflare_d1 --local --file scripts/init.sql
npm run dev        # http://127.0.0.1:8787（--test-scheduled 已开）
npm test
```

手动触发一轮检查：`.dev.vars` 里放 `MONITOR_TRIGGER_SECRET=<值>` 后
`curl "http://127.0.0.1:8787/trigger?secret=<值>"`（`.dev.vars` 不入库）。

## 部署

推送到 main 即自动部署（Actions）：`npm ci` → 测试 → dry-run 构建 →
确保 D1/表 → 注入 D1 ID → `wrangler deploy`（资产随 Worker 一起上）→
`/health` 冒烟（兼上弦）。仓库 Secrets：`CLOUDFLARE_API_TOKEN`
（`CLOUDFLARE_ACCOUNT_ID` 可选，缺省自动获取）。

**地址**：自定义域名 `https://w.chaoyang.us.ci`（Dashboard 绑定），
备用 `https://uptimeflare_worker.<子域>.workers.dev`。

本机无 git CLI 时可用仓库自带的 API 推送脚本（走 gh 凭据）：

```bash
node scripts\push-root.mjs "提交说明"
```

**升级延续**：Worker 名、DO 类名与迁移台账（v1/v2/v3）不变——页面添加的
站点、历史数据、管理员凭证原样保留，无迁移步骤。

## 测试

```bash
npm test            # 30 个用例：状态转换/间隔调度/CAS 原子性/调度自愈/通知文案
npx tsc --noEmit
```

## License

Apache-2.0（沿用上游 [UptimeFlare](https://github.com/lyc8503/UptimeFlare)）。
