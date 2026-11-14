# UptimeFlare

个人服务状态页，运行在 Cloudflare Workers 免费套餐上。每十分钟检查一次 HTTP/HTTPS 服务，首次失败后三秒复查；记录故障与恢复，并发送通知。

一个 SQLite Durable Object 承载全部运行时状态（监测列表、每站点历史、管理员凭证、通知队列），服务端直出全部页面；运行期不使用 KV 或 D1，无生产依赖。旧版（D1/KV 存储）部署时自动迁移。

## 部署

需要 Node.js 24 和 Cloudflare 账号。首次部署前修改 `src/config.ts` 中的标题、链接、维护计划和通知区域。

```sh
npm ci
npm run check
npm test
npm run deploy
```

部署使用环境变量 `CLOUDFLARE_API_TOKEN`，可选 `CLOUDFLARE_ACCOUNT_ID`。检测到旧版 `uptimeflare_d1` 时自动绑定并只读导入一次历史数据；导入失败会推迟到下次唤醒重试，不影响现有监测。全新安装无需创建 D1。

本机没有 Git 时用 `node scripts/push-root.mjs "说明"` 经 GitHub API 推送仓库根目录并触发部署。

## 使用

- 页面全部由 Worker 服务端渲染：首屏即真实状态，导航按登录态渲染，无加载闪烁；匿名页面边缘缓存 30 秒，管理员页面不缓存。
- 管理页支持添加、编辑、删除站点；检查间隔 10/20/30/60 分钟，超时 3–60 秒。编辑保留同 ID 站点的全部历史，删除为两击确认。
- 历史故障弹窗按站点与月份筛选；每日数据条可点开当日故障详情；详情页提供 90 天历史和 12 小时响应曲线。
- 封面图可自定义，留空使用 image.thum.io 生成，浏览器会请求该第三方服务。
- 标题、导航链接、维护计划（进行中显示横幅、未开始显示预告）和通知策略在 `src/config.ts` 修改；维护期间继续记录状态并抑制通知。
- 故障记录保留 90 天，响应样本保留 12 小时，检查时顺带清理过期数据。

## 接口

| 地址 | 用途 |
| --- | --- |
| `/health` | 调度时间、最近运行时间、健康状态；过期返回 503 |
| `/api/view?id=ID` | 页面数据，省略 ID 返回所有站点 |
| `/api/data` | 兼容状态摘要 |
| `/api/status?id=ID` | 故障与响应历史 |
| `/api/badge?id=ID&label=名称` | Shields JSON 徽章 |
| `/api/admin`、`/api/monitors` | 登录和站点管理 |

可选设置 Worker Secret `MONITOR_TRIGGER_SECRET`，通过 `/trigger` 和 `Authorization: Bearer <secret>` 手动触发到期检查。不要把密钥写入仓库。

## 开发与验证

```sh
npm run dev
npm test
npm run check
npx wrangler deploy --dry-run
```

测试内核使用 Node 自带 SQLite 和可控时钟、网络，验证状态转换、事务回滚、迁移、并发去重、请求预算及整日运行；`test/http.test.ts` 在 `TEST_URL` 指向隔离实例时验证真实运行时的页面、鉴权与增删改。它不向通知服务发送请求，也不代表 Cloudflare 实测 CPU。

免费额度以 Cloudflare 最新文档为准：Workers 每天 10 万动态请求，SQLite DO 每天 500 万行读取、10 万行写入；静态资源请求免费。单批最多 40 次探测、10 次通知，超额任务一秒后继续，单实例最多 100 个站点。100 个健康站点按十分钟间隔约需每天 14,400 次探测；访客动态请求与历史大小另计。

`notify.ts` 的通知区域集中了推送渠道；通知在状态提交后发送，失败写入 Worker 日志，不自动重试。它适合个人站点提醒，不承诺可靠消息投递。单点检查也不能代表全球各地访问情况。

Apache-2.0，见 LICENSE。
