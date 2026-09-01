# 聚水潭自动同步（方案A）

次品图片收集系统**自动**获取聚水潭的「商品（SKU 颜色/码数/款号）、供应商、退货地址」。

## ⚠️ 关键限制：聚水潭 IP 白名单

聚水潭开放平台对普通商品资料接口启用了 **IP 白名单**，且：
- **Supabase Edge Function** 出口 IP 轮换（实测 13.229.156.50 / 13.214.147.75 / 18.138.224.65）→ 无法入白名单
- **Cloudflare Worker** 出口 IP 也轮换（实测 108.162.237.216 / 162.158.172.227 / 172.71.238.132 / 172.64.200.119）→ 同样无法入白名单
- **本机（办公室电脑）** IP 已入白名单 → 可直连聚水潭 ✅

因此：**当前唯一可靠、且已在自动运行的是本机计划任务**。

## ✅ 当前运行方案：本机计划任务（已生效）

- 任务名：`JST-AutoSync`（每 2 小时，系统权限）
- 脚本：`sync-local.js`（本目录，含密钥，已 gitignore 不入库）
- 日志：`sync-log.txt`
- 手动：`node sync-local.js incremental`（或 `full` 全量分片刷新）
- 效果：商品 53933 / 款号→供应商 1970 / 退货地址 116，前端每次加载从 Supabase 读取

## 🚀 云端 Worker（已部署，等 JST 白名单放行后自动生效）

`worker/` 已部署到 Cloudflare：`https://jst-sync-worker.458914253.workers.dev`
- 定时：每天 03:00 / 11:00 / 19:00 自动增量同步（Cloudflare Cron）
- 手动触发 / 状态查询（国内可直接访问，经 Supabase 中转）：
  - `POST https://elyfxyrdbuykyklfjfdr.supabase.co/functions/v1/jst-sync` body `{"mode":"fire-worker"}` → 触发后台同步
  - 同地址 body `{"mode":"sync-status"}` → 查看最近运行日志（mapping_data.sync_runs）
- 运行日志：写入 Supabase `mapping_data.id='sync_runs'`（保留最近 20 条）

**待办**：在聚水潭开放平台后台把 Cloudflare 出口网段加入 IP 白名单后，worker 即可独立运行、不依赖本机。可加网段（与实测 IP 对应）：
- `108.162.192.0/18`、`162.158.0.0/15`、`172.64.0.0/13`

## Supabase Edge Function `jst-sync`

已部署，提供：GET 状态（各映射条数）、POST fire-worker（触发 worker）、POST sync-status（运行日志）。
部署：`supabase functions deploy jst-sync --project-ref elyfxyrdbuykyklfjfdr`

## 数据表

`public.mapping_data`（schema.sql）：
- `sku_info`：SKU → [款号, 颜色, 码数]（5.4 万条，仅 15 个服装分类）
- `return_style`：款号 → 供应商名称（1970 条）
- `return_addr`：供应商 → {address, mobile, contacts}（116 条）
- `sync_runs`：worker 最近运行日志（20 条）
- `full_cursor`：全量分片刷新进度（仅 full 模式）

RLS：匿名可读（前端），仅 service_role 可写（同步脚本/Worker）。
