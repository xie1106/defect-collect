-- ============================================================
-- 次品系统：聚水潭自动同步（方案A）建表 + 权限
-- ------------------------------------------------------------
-- 说明：聚水潭普通商品资料接口启用 IP 白名单，Supabase Edge Function
--   出口 IP 轮换无法入白名单，因此同步改由「本机计划任务 JST-AutoSync」
--   每 2 小时运行 backend/jst-sync/sync-local.js 完成；
--   更稳的云端方案：backend/jst-sync/worker（Cloudflare Worker，IP 已入白名单）。
--   前端 次品收集.html 每次加载从本表读取最新 3 个映射。
-- 在 Supabase SQL Editor 执行一次即可
-- ============================================================

-- 1) 映射数据表
create table if not exists public.mapping_data (
  id text primary key,          -- 'sku_info' | 'return_style' | 'return_addr' | 'full_cursor'
  data jsonb not null,
  updated_at timestamptz default now()
);

-- 2) 行级安全：允许匿名读（前端网页需要读），只允许服务端密钥写（同步脚本/Worker）
alter table public.mapping_data enable row level security;
drop policy if exists "mapping_data_anon_read" on public.mapping_data;
create policy "mapping_data_anon_read" on public.mapping_data
  for select using (true);
drop policy if exists "mapping_data_service_write" on public.mapping_data;
create policy "mapping_data_service_write" on public.mapping_data
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- 查看数据：select id, jsonb_array_length(data) from mapping_data;  -- 或：
-- select id, (select count(*) from jsonb_object_keys(data)) as keys from mapping_data;
