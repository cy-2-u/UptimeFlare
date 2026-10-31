# 服务状态（UptimeFlare 重写版）

跑在 Cloudflare 免费额度上的网站可用性监控 + 状态页。本目录是原项目的完全重写：
更精简的代码、按监控分行的 D1 存储、通知后置到持久化成功之后、页面边缘缓存、
无 Terraform / Python 的纯 Node 部署链路。

## 架构

```
┌─ Worker: uptimeflare_worker ─────────────────────────────────┐
│  Durable Object Alarm（主调度，每 10 分钟自续）               │
│    └─ runChecks: 读快照 → 并发检查(失败2次确认) → 行级转换    │
│         → 单批 CAS 原子写 D1 → 写成功后才发通知               │
│  Cron 0 * * * *（每小时，仅监督：缺失/过期/数据停滞时重新上弦）│
│  GET /health   健康检查（也会上弦闹钟）                       │
│  GET /trigger  手动触发一轮检查（需 MONITOR_TRIGGER_SECRET）  │
└──────────────────────────────────────────────────────────────┘
┌─ Pages: uptimeflare（Next.js, next-on-pages）────────────────┐
│  /            SSR 状态页，边缘缓存 60s（管理员导航客户端判定）│
│  /manage      站点管理：添加 / 编辑 / 删除                    │
│  /api/status  全量状态（轮询用，边缘缓存 60s）                │
│  /api/data    轻量摘要                                        │
│  /api/badge   Shields.io 徽章                                 │
│  /api/monitors|admin  管理接口                                │
└──────────────────────────────────────────────────────────────┘
```

### D1 行式存储（表 `uptimeflare`）

| key | 内容 | 写入频率 |
|---|---|---|
| `state:meta` | lastUpdate、在线/宕机计数 | 每轮 |
| `state:lat:<id>` | 延迟（hex 压缩，保留 12h）、最近状态、`startedAt`、通知标记 | 每轮 |
| `state:inc:<id>` | 事件（柱状压缩，保留 90 天） | 仅事件变化时 |
| `admin_credentials` | 管理员凭证 | 变更时 |
| `runtime_monitors` | 旧版监控列表（迁移源），调度器首次读取后自动删除 | 迁移读一次 |

每轮检查 = 一次 `db.batch()`，其中每条写入都带 CAS（`WHERE value = 旧值`），
批量原子生效；写失败或竞争则整轮不落盘、也不发通知（下一轮重新判定）。

相比旧版单行全量 JSON：单次写更小、CPU 随监控数量平滑增长、
事件行只在变化时写（稳定运行时几乎零写入）。

## 配置

`uptime.config.ts`：页面标题、分组、静态 monitors、通知设置（timeZone、
gracePeriod、skipNotificationIds、skipErrorChangeNotification）、维护窗口。

### 通知

推送渠道集中在 `worker/src/notify.ts`（带 `通知区域修改开始/结束` 标记）：

- `shouldSendNotification()` 返回 `false` 关闭全部通知
- `WEBHOOK_URL` / `WEBHOOK_HEADERS` / `buildWebhookBody()` 自定义推送接口
- `buildNotificationMessage()` 自定义文案（恢复 / 刚发现 / 持续中三种）

通知在**状态成功写入之后**才发出，不会出现"通知说挂了页面却正常"。
`gracePeriod` 语义为"宕机持续 N 分钟后发送第一条通知"，采用持久标记，
即使某轮检查被跳过也不会漏发或重发。

### 站点管理

`/manage` 支持添加、**编辑**、删除（两击确认）。编辑沿用同一个 id，
不会丢历史数据；删除会连同事件与延迟数据一起清理（两阶段，失败自动重试）。

## 运维

### 健康检查

```
https://uptimeflare_worker.<你的子域>.workers.dev/health
```

- `lastRunAgoSec < 600`：最近一轮检查正常
- `nextAlarmInSec` 有值：DO 闹钟在跳
- `monitorCount`：当前监控数量

### 手动触发

`/trigger`（需要 `Authorization: Bearer <MONITOR_TRIGGER_SECRET>` 或 `?secret=`）
立即跑一轮，改完配置想立刻验证时用。

### 调度模型

闹钟（DO Alarm）是唯一计时器，每 10 分钟自续；每小时一次的 cron 只做监督：
闹钟丢失、过期，或 `lastUpdate` 停滞超过 25 分钟时重新上弦。
部署完成后访问一次 `/health`（CI 末步会自动做）即可上弦。

## 本地开发

```bash
npm install            # 前端
cd worker && npm install
npm run dev            # worker（wrangler dev --test-scheduled）
npm run preview        # 前端 next-on-pages 构建 + wrangler pages dev
```

Worker 定时任务手动触发：`http://127.0.0.1:8787/cdn-cgi/handler/scheduled`

## 测试

```bash
cd worker
npm test        # 47 个用例：状态转换、存储 CAS、调度、迁移、通知、检查
npx tsc --noEmit
```

## 部署

推送到 `main` 或手动触发 GitHub Actions。仓库 Secrets：

- `CLOUDFLARE_API_TOKEN`（需要 D1、Workers、KV、Pages 权限）
- `CLOUDFLARE_ACCOUNT_ID`（可选，缺省时自动通过 API 获取）

流程：`npm ci` → worker 测试 → worker dry-run 构建 → next-on-pages 构建 →
确保 D1/表存在 → 生成 `wrangler.deploy.toml`（注入真实 D1 ID，KV 仅在旧命名空间
还存在时保留供迁移用）→ 部署 Worker → 配置 Pages 绑定（替代 Terraform）→
部署 Pages → `/health` 冒烟检查（同时上弦）。

### 从旧版迁移

首次部署新版 Worker 后，第一次 `/health` 或 cron 触发会自动执行
`worker/src/migrate.ts`：把旧的单行 `state` 拆成行式存储（进行中的事件标记为
"已通知"，避免迁移后重复告警），并把仍只存在于 KV 的管理员凭证复制进 D1。

整个迁移在**同一个原子批次**内完成，且随批删除旧 `state` 行——迁移要么完整
成功（新数据可用、旧行消失），要么完全不动（旧数据原样保留，下轮重试），
不存在中间态。旧监控列表行 `runtime_monitors` 在调度器首次读取监控列表
（确认 DO storage 已成为权威数据源）后自动删除，删除失败会自动重试。CI 末尾
的清理步骤会在健康检查确认迁移完成后，自动删除不再需要的旧 KV 命名空间
`uptimeflare_config`（守卫条件不满足时跳过，下次部署重试）。

## 与旧版的主要差异

- 删除：检查代理体系（worker://、globalping://、HTTP 代理、RemoteChecker DO、
  proxy/ 目录）、i18n、Mantine、chart.js/moment、Terraform、Python 脚本、
  Docker 文件、密码保护中间件
- 存储：单行全量 JSON → 按监控分行 + 批量 CAS；删除 pendingDeletes 全量重写，
  改为轻量行删除
- 调度：cron */10 → cron 每小时监督 + DO Alarm 主调度 + 停滞自愈
- 前端：Mantine/图表库 → 纯 Tailwind + 内联 SVG 折线图；匿名页面边缘缓存 60s；
  轮询 10 分钟 → 2 分钟；卡片"距上次检查"实时跳动
- 会话：长期 cookie → HMAC 签名 + 30 天有效期（改密码即全端下线）
- 通知：先写后发；gracePeriod 用持久标记替代 ±30s 窗口
