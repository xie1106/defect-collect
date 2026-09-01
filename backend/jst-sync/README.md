# 聚水潭自动同步（方案A）

次品图片收集系统**自动**获取聚水潭的「商品（SKU 颜色/码数/款号）、供应商、退货地址」，无需人工处理。

## 为什么不能直接在 Supabase 里同步？

聚水潭开放平台对普通商品资料接口 `/open/sku/query` 启用了 **IP 白名单**。
Supabase Edge Function 的出口 IP 是动态轮换的（实测多次调用返回不同 IP：
13.229.156.50 / 13.214.147.75 / 18.138.224.65），无法加入白名单，会被聚水潭拒绝（code=110）。

能直连聚水潭的环境：**本机（白名单 IP）** 和 **Cloudflare Worker（出口 IP 已在白名单）**。

## 当前运行的方案：本机计划任务

- **任务名**：`JST-AutoSync`（Windows 计划任务，每 2 小时运行一次）
- **脚本**：`sync-local.js`（本目录，Node 18+）
- **做什么**：
  1. 读取 Supabase `mapping_data` 现有 3 个映射
  2. 增量查询聚水潭最近 7 天改动的商品
  3. 补齐登记记录里缺失的 SKU / 款号供应商
  4. 全量刷新供应商 + 类目
  5. 合并写回 Supabase `mapping_data`
- **日志**：`sync-log.txt`（本目录）
- 手动执行：`node sync-local.js incremental`（或 `full` 全量分片刷新）

前端 `次品收集.html` 每次加载从 Supabase `mapping_data` 读取最新映射
（失败时用本地 JSON 兜底），因此商品/供应商/地址更新后刷新网页即可看到。

## 云端方案（推荐，待部署）：Cloudflare Worker

见 `worker/` 目录（`jst-sync-worker`），逻辑与 `sync-local.js` 相同，
支持 Cloudflare Cron Triggers 定时自动同步，不依赖本机开机。

部署（需 Cloudflare 账号授权）：
```
cd backend/jst-sync/worker
wrangler secret put JST_APP_SECRET
wrangler secret put JST_ACCESS_TOKEN
wrangler secret put SUPABASE_SERVICE_KEY
wrangler deploy
```
触发：`POST https://jst-sync-worker.<你的子域>.workers.dev/sync`（手动）；
cron 每天 03:00/11:00/19:00 自动增量同步。

## Supabase Edge Function `jst-sync`

仅保留**状态检查**（GET 返回 mapping_data 各表条数），不再承担同步任务。
部署：`supabase functions deploy jst-sync --project-ref elyfxyrdbuykyklfjfdr`

## 数据表

`public.mapping_data`（见 `schema.sql`）：
- `sku_info`：SKU → `[款号, 颜色, 码数]`（当前 5.4 万条，仅 15 个服装分类）
- `return_style`：款号 → 供应商名称（当前 1970 条）
- `return_addr`：供应商 → `{address, mobile, contacts}`（当前 116 条）
- `full_cursor`：全量分片刷新进度（仅 full 模式使用）

RLS：匿名可读（前端）、仅 service_role 可写（同步脚本/Worker）。
