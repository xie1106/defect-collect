// Supabase Edge Function: jst-sync（状态检查 + 触发云端同步）
// ------------------------------------------------------------
// 说明：聚水潭开放平台对商品资料接口启用 IP 白名单，Supabase 出口 IP 轮换
//   无法入白名单，同步改由 Cloudflare Worker（jst-sync-worker）执行：
//   - 定时：每天 03:00 / 11:00 / 19:00（Cloudflare Cron）
//   - 手动：本函数 POST {"mode":"fire-worker"} 触发
//   运行结果写入 mapping_data.id='sync_runs'，本函数可读取查看。
//
// GET                              → 状态 + 各映射条数
// POST {"mode":"fire-worker"}      → 触发 Cloudflare Worker 后台同步（立即返回）
// POST {"mode":"sync-status"}      → 返回最近同步运行日志
// 部署: supabase functions deploy jst-sync --project-ref elyfxyrdbuykyklfjfdr
// ------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const SUPABASE_URL = (Deno.env.get("JST_SUPABASE_URL") || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = Deno.env.get("JST_SUPABASE_SERVICE_KEY") || "";
const WORKER_URL = "https://jst-sync-worker.458914253.workers.dev/sync";

async function getMap(id) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/mapping_data?select=data&id=eq.${id}`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows[0] && rows[0].data) || null;
  } catch { return null; }
}

async function readCounts() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/mapping_data?select=id,data`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { error: "HTTP " + r.status };
    const rows = await r.json();
    const out = {};
    for (const row of rows) out[row.id] = Array.isArray(row.data) ? row.data.length : Object.keys(row.data || {}).length;
    return out;
  } catch (e) { return { error: e.message }; }
}

async function fireWorker() {
  try {
    const r = await fetch(WORKER_URL + "?fire=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
    const txt = await r.text();
    return { worker_http: r.status, worker_response: txt.slice(0, 300) };
  } catch (e) {
    return { worker_error: e.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const isPost = req.method === "POST";
  if (req.method !== "GET" && !isPost) return new Response(JSON.stringify({ error: "GET/POST only" }), { status: 405, headers: CORS });

  try {
    let body = {};
    if (isPost) { try { body = await req.json(); } catch { body = {}; } }
    const mode = body.mode || "status";

    if (mode === "fire-worker") {
      const fire = await fireWorker();
      return new Response(JSON.stringify({ ok: true, mode, ...fire, time: new Date().toISOString() }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (mode === "sync-status") {
      const runs = await getMap("sync_runs");
      const counts = await readCounts();
      return new Response(JSON.stringify({ ok: true, mode, runs: Array.isArray(runs) ? runs : [], counts, time: new Date().toISOString() }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // 默认：状态
    const counts = await readCounts();
    return new Response(JSON.stringify({
      status: "ok", service: "jst-sync",
      note: "同步由 Cloudflare Worker jst-sync-worker 执行（每天 03/11/19 点自动 + 本函数 fire-worker 手动触发）",
      mapping_counts: counts,
      time: new Date().toISOString(),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
});
