# 服务状态页通知配置

这个项目的通知代码集中在 `worker/src/notification.ts`。想换成自己的推送渠道，主要改这个文件。

## 开启或关闭通知

打开 `worker/src/notification.ts`，看最前面的函数：

```ts
export function shouldSendNotification() {
  return true
}
```

`return true` 是开启通知。

`return false` 是关闭通知。

## 修改推送接口

在 `worker/src/notification.ts` 里找到这段：

```ts
// 通知区域修改开始
const WEBHOOK_URL = 'https://api.chuckfang.com/%E7%AC%AC%E4%BA%94%E4%B8%AA%E5%AD%A3%E8%8A%82'
const WEBHOOK_TIMEOUT_MS = 10000
const WEBHOOK_HEADERS: Record<string, string> = {}

function buildWebhookBody(message: string) {
  return {
    msg: message,
  }
}
// 通知区域修改结束
```

把 `WEBHOOK_URL` 改成你的推送 API 地址。

如果你的接口需要请求头，就改 `WEBHOOK_HEADERS`。

如果你的接口需要不同的请求字段，就改 `buildWebhookBody()` 返回的对象。

## 修改通知文案

通知文案也在 `worker/src/notification.ts`，函数名是 `buildNotificationMessage()`。

它会处理三种情况：恢复、刚发现故障、故障持续中。只改里面返回的文字就行。

## GitHub Actions 需要配置的变量

仓库的 Actions Secrets 里需要配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

这两个变量用于部署到 Cloudflare。通知接口自己的凭证按你的 webhook 要求写在 `worker/src/notification.ts` 的通知区域里。

## Worker 状态检查与手动触发

监测主调度改成 Durable Object Alarm，每 10 分钟自己续期。Cloudflare Cron 只负责把闹钟重新上弦；Cron 静默停发时，Alarm 仍会继续跑。

首次部署后访问一次 `/health` 或 `/trigger`，闹钟就会开始自己续期。

Worker 还提供两个接口方便排查问题。

### 健康检查

浏览器打开 Worker 的访问地址，后面加 `/health`。地址在 Cloudflare Dashboard 的 Workers 页面能看到，形如 `https://uptimeflare_worker.<你的子域>.workers.dev`：

```text
https://uptimeflare_worker.<你的子域>.workers.dev/health
```

返回内容：

```json
{"healthy":true,"workerLocation":"HKG","lastUpdate":1787677858,"lastRunAgoSec":78,"nextAlarm":1787678458000,"nextAlarmInSec":522,"monitorCount":4,"stateBytes":2812,"serverTime":1787677936}
```

只需要看 `lastRunAgoSec` 和 `nextAlarmInSec`：

`lastRunAgoSec` 小于 600，说明最近 10 分钟写过监测数据。`nextAlarmInSec` 有值，说明 Durable Object 闹钟还在。`lastRunAgoSec` 接近或超过 600，去 Dashboard 看实时日志。

`monitorCount` 是当前监控的站点数量，`stateBytes` 是状态数据的大小，偶尔看一眼确认数据量没有异常增长即可。

### 手动触发一次检查

把 `/health` 换成 `/trigger` 访问，会立刻跑一轮检查，不用等 cron。改完监控想马上验证效果时用它：

```text
https://uptimeflare_worker.<你的子域>.workers.dev/trigger
```

返回 `{"triggered":true,"startedAt":...}`。检查结果写入数据后，状态页下一次刷新就能看到。

### 本地手动触发定时任务

本地用 `wrangler dev --test-scheduled` 起 Worker 时，手动触发定时任务走：

```text
http://127.0.0.1:8787/cdn-cgi/handler/scheduled
```
