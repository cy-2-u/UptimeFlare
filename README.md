# 服务状态（UptimeFlare v3）

跑在 Cloudflare 免费额度上的网站可用性监控 + 状态页。v3 是全面重写版：
**单个 Worker 承载一切**（SSR 页面 + JSON API + 静态资产 + 监测核心），
无框架构建链、无 Pages 项目、无 Terraform/Python。

## 架构

```
┌─ Worker: uptimeflare_worker（唯一运行单元）───────────────────┐
│  Hono SSR 页面:  /            状态页（边缘缓存 60s）           │
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
- **时间渲染全在客户端**：SSR 只输出结构与时区无关的状态，"x 前"／柱状图／
  事件时间由 `app.js` 按访客时区填充，无 hydration、无框架运行时。
- **D1 行式存储**：`state:meta` / `state:inc:<id>`（事件，90 天）/
  `state:lat:<id>`（延迟+最近状态，12h）。事件行只在变化时写。

## 管理入口

首次访问 `/login` 创建管理员；`/manage` 添加/编辑/删除站点（编辑保留全部
历史），支持每站点检查间隔（10/20/30/60 分钟）与超时设置。

## 配置

`src/config.ts`：页面标题/分组/静态监控/通知（timeZone、gracePeriod、
skipNotificationIds、skipErrorChangeNotification）/维护窗口。

### 通知渠道

`src/notify.ts` 的「通知区域修改开始/结束」标记内：`WEBHOOK_URL`、
`WEBHOOK_HEADERS`、`buildWebhookBody()`、`buildNotificationMessage()`。
`shouldSendNotification()` 返回 false 可整体关闭。

## 本地开发

```bash
npm install
npx wrangler d1 execute uptimeflare_d1 --local --file scripts/init.sql
npm run dev        # http://127.0.0.1:8787（--test-scheduled 已开）
npm test
```

手动触发定时：`curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"`

## 部署

推送到 main 即自动部署（Actions）：`npm ci` → 测试 → dry-run 构建 →
确保 D1/表 → 注入 D1 ID → `wrangler deploy`（资产随 Worker 一起上）→
`/health` 冒烟（兼上弦）。仓库 Secrets：`CLOUDFLARE_API_TOKEN`
（`CLOUDFLARE_ACCOUNT_ID` 可选，缺省自动获取）。

**地址**：`https://uptimeflare_worker.<你的子域>.workers.dev`
（v2 的 pages.dev 域名随 Pages 路线退役；如需自有域名，在 Cloudflare
Dashboard 的 Worker → Settings → Domains & Routes 绑定。）

**从 v2 升级**：Worker 名、DO 类名、D1 库完全一致——页面添加的站点、历史
数据、管理员凭证**原样延续**，无迁移步骤。首次部署后访问一次 `/health`
（CI 末步自动做）即完成上弦。

## 测试

```bash
npm test            # 28 个用例：状态转换/间隔调度/CAS 原子性/调度自愈/通知时序
npx tsc --noEmit
```
