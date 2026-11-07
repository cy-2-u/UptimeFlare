# UptimeFlare

跑在 Cloudflare Workers 免费额度上的网站可用性监控 + 状态页。单个 Worker
承载一切：Hono JSX SSR 页面、JSON API、静态资产、Durable Object 监测调度——
无独立构建链、无 Pages 项目、无 Terraform/Python。

**在线示例**：<https://w.chaoyang.us.ci>

## 功能

- HTTP 可用性监测：每站点独立检查间隔（10/20/30/60 分钟）与超时；单次失败二次确认，网络抖动不误报
- 状态页：分组卡片、30 天可用率条、90 天历史、12 小时响应时间曲线、历史故障弹窗（按站点/月份筛选）
- 管理：首次访问 `/login` 创建管理员，`/manage` 增删改站点；编辑不改 ID，历史全保留
- 通知：宕机/恢复/错误变化即时推送（timelynotify GET 渠道，改常量即可换同类服务）
- 对外接口：Shields.io 徽章 `/api/badge`、轻量摘要 `/api/data`（CORS *）、全量状态 `/api/status`
- 免费额度友好：未到期监测整轮跳过、零写入；Cron 仅作监督兜底，主调度靠 DO alarm

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
│    ├─ 类型化 RPC: list/add/update/deleteMonitor 等直调方法     │
│    └─ runChecks: 按 due 过滤 → 并发检查（失败 2 次确认）       │
│         → 单批 CAS 原子写 D1 → 写成功后才发通知                 │
│  Cron 0 * * * *（每小时，仅监督：闹钟缺失/过期/停滞时重新上弦）│
└────────────────────────────────────────────────────────────────┘
```

### 关键设计

- **先持久化后通知**：状态写入 D1（批量 CAS 原子生效）成功后才发通知，失败的轮次什么都不发，下一轮重新判定。
- **页面状态与检查轮同源**：页面状态取自延迟行的 `lastStatus`（与汇总计数同一来源），进行中的故障优先判定宕机，从未检查的显示"等待检查"。
- **时间渲染全在客户端**：SSR 只输出与时区无关的结构，"x 前"、柱状图、事件时间由 `app.js` 按访客时区填充，无 hydration、无框架运行时。
- **D1 行式存储**：`state:meta` / `state:inc:<id>`（事件，保留 90 天）/ `state:lat:<id>`（延迟 + 最近状态，保留 12 小时）；事件行只在变化时写。行布局、hex/RLE 编解码与 CAS 读写统一在 `src/state.ts`。

## 部署（部署到你自己的 Cloudflare 账户）

1. Fork 或导入本仓库。
2. 仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN`（`CLOUDFLARE_ACCOUNT_ID` 可选，缺省自动获取）。
3. 推送到 `main` 即自动部署（Actions）：`npm ci` → 测试 → dry-run 构建 → 确保 D1/表 → 注入 D1 ID → `wrangler deploy` → `/health` 冒烟。
4. 部署完成后访问 `https://uptimeflare_worker.<你的 workers.dev 子域>.workers.dev`，首次进入 `/login` 创建管理员。
5. 自定义域名在 Cloudflare Dashboard → Worker → Settings → Domains & Routes 绑定。

**从旧版 UptimeFlare 升级**：Worker 名、DO 类名与迁移台账不变，已有站点、历史数据、管理员凭证原样保留，无迁移步骤。

## 配置

- `src/config.ts`：页面标题/链接/图标（`pageConfig`）、通知（`workerConfig.notification`：timeZone、gracePeriod、skipNotificationIds、skipErrorChangeNotification）、维护窗口（`maintenances`）。
- 通知渠道：`src/notify.ts`「通知区域修改开始/结束」标记内改常量即可换渠道（`PUSH_BASE_URL`、`PUSH_ICON`、`PUSH_GROUP`、`PUSH_TTL_SEC`、`PUSH_SOUND`）；标题/正文经 URL 编码后作为 GET 路径段。

## 本地开发

```bash
npm install
npx wrangler d1 execute uptimeflare_d1 --local --file scripts/init.sql
npm run dev        # http://127.0.0.1:8787（--test-scheduled 已开）
npm test
```

手动触发一轮检查：`.dev.vars`（不入库）里放 `MONITOR_TRIGGER_SECRET=<值>`，
然后 `curl "http://127.0.0.1:8787/trigger?secret=<值>"`。

无 git 环境的机器也可以用仓库自带的 API 推送脚本（走 `gh` 凭据）：
`node scripts/push-root.mjs "提交说明"`。

## 测试

```bash
npm test            # 30 个用例：状态转换/间隔调度/CAS 原子性/调度自愈/通知文案
npx tsc --noEmit
```

## License

Apache-2.0（沿用上游 [UptimeFlare](https://github.com/lyc8503/UptimeFlare)）。
