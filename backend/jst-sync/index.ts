// Supabase Edge Function: jst-sync（状态检查）
// ------------------------------------------------------------
// ⚠️ 注意：聚水潭开放平台对普通商品资料接口启用了 IP 白名单，
//   而 Supabase Edge Function 的出口 IP 是动态轮换的（无法加入白名单），
//   因此「从 Supabase 直接调聚水潭 API」不可行（实测 code=110 拒绝）。
//
// ✅ 实际同步方案（方案A，已上线）：
//   1) 本机计划任务 JST-AutoSync（每2小时）运行 backend/jst-sync/sync-local.js
//      —— 本机 IP 在白名单内，直连聚水潭 → 写 Supabase mapping_data
//   2) 前端 次品收集.html 每次加载从 mapping_data 读取最新映射
//
// 本函数仅保留状态检查（GET）供监控/排障使用。
// 部署: supabase functions deploy jst-sync --project-ref elyfxyrdbuykyklfjfdr
// ------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const SUPABASE_URL = (Deno.env.get("JST_SUPABASE_URL") || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = Deno.env.get("JST_SUPABASE_SERVICE_KEY") || "";

async function readCounts() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/mapping_data?select=id,data`, {
      headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { error: "HTTP " + r.status };
    const rows = await r.json();
    const out = {};
    for (const row of rows) out[row.id] = Object.keys(row.data || {}).length;
    return out;
  } catch (e) {
    return { error: e.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") {
    const counts = await readCounts();
    return new Response(JSON.stringify({
      status: "ok",
      service: "jst-sync",
      note: "同步由本机计划任务 JST-AutoSync（sync-local.js）执行；本函数仅状态检查",
      mapping_counts: counts,
      time: new Date().toISOString(),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "GET only" }), { status: 405, headers: CORS });
});
