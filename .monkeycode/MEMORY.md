# 用户指令记忆

本文件记录了用户的指令、偏好和教导，用于在未来的交互中提供参考。

## 格式

### 用户指令条目
用户指令条目应遵循以下格式：

[用户指令摘要]
- Date: [YYYY-MM-DD]
- Context: [提及的场景或时间]
- Instructions:
  - [用户教导或指示的内容，逐行描述]

### 项目知识条目
Agent 在任务执行过程中发现的条目应遵循以下格式：

[项目知识摘要]
- Date: [YYYY-MM-DD]
- Context: Agent 在执行 [具体任务描述] 时发现
- Category: [运维部署|构建方法|测试方法|排错调试|工作流协作|环境配置]
- Instructions:
  - [具体的知识点，逐行描述]

## 去重策略
- 添加新条目前，检查是否存在相似或相同的指令
- 若发现重复，跳过新条目或与已有条目合并
- 合并时，更新上下文或日期信息
- 这有助于避免冗余条目，保持记忆文件整洁

## 条目

[Cloudflare 免费额度与绑定策略]
- Date: 2026-06-30
- Context: 用户在状态页改造过程中说明可增加环境变量和 KV 数据绑定，并提醒 D1 使用免费版
- Instructions:
  - 设计 Cloudflare 存储方案时需要注意 D1 免费版写入额度，优先减少非必要 D1 写入。
  - 如果方案更稳妥，可以增加环境变量或 KV 数据绑定，不需要刻意避免新增绑定。

[GitHub Actions 错误处理方式]
- Date: 2026-06-30
- Context: 用户说明 Actions 报错会主动发送日志
- Instructions:
  - 推送后不要持续轮询 GitHub Actions 状态，等待用户发送报错日志后再继续修复。

[UptimeFlare Worker 停转排查]
- Date: 2026-09-11
- Context: Agent 在排查监测 Worker 莫名停止时发现
- Category: 排错调试
- Instructions:
  - 账号 ID 为 `dfb8bcfd4a4956ced5e2260565ca1bca`，监测脚本名为 `uptimeflare_worker`，子域为 `1620035468`。
  - 先查 `GET /accounts/{id}/workers/scripts/uptimeflare_worker/schedules` 确认 cron 还在；再用 GraphQL `workersInvocationsScheduled` 看最近一次 scheduled 时间。
  - 日志走 `POST /accounts/{id}/workers/observability/telemetry/query`，`view=invocations`，filter `$metadata.service=uptimeflare_worker`。
  - 健康接口 `/health` 看的是 D1 里的 `lastUpdate`。Worker 每轮检查都会写 D1，`lastUpdate` 应随 10 分钟周期前进。
  - `/trigger` 需要 `MONITOR_TRIGGER_SECRET`（`Authorization: Bearer` 或 `?secret=`）。未配置时返回 401。`/health` 仍可上弦闹钟。
  - 本环境访问 `*.workers.dev` 和 `uptimeflare-8t2.pages.dev` 经常 SSL/超时失败，不能用这个作为 Worker 已停的证据。
  - 若 GraphQL 显示 scheduled 在某时刻后整账号都没再触发，属于 Cloudflare cron 调度静默停发，Worker 代码和 cron 配置通常仍在。可 `PUT` schedules 重新写入 `*/10 * * * *` 尝试唤醒。
  - 监测主调度改成 Durable Object Alarm（`MonitorScheduler`，binding `MONITOR_SCHEDULER_DO`）。免费账号可用。Cron 只负责 `ensureAlarm()`；闹钟每 10 分钟自己续期。部署后访问一次 `/health` 或 `/trigger` 上弦。
