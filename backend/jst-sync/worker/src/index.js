// ============================================================
// jst-sync-worker —— 聚水潭 → 次品系统 自动同步（Cloudflare Worker 版）
// ------------------------------------------------------------
// 为什么需要 Worker：聚水潭开放平台对商品资料接口启用了 IP 白名单，
//   Cloudflare Worker 的出口 IP 已在白名单内（现有 return-worker 可直连聚水潭），
//   而 Supabase Edge Function 出口 IP 会轮换、无法加入白名单。
//
// 功能：把 3 个映射写入 Supabase mapping_data（与 sync-local.js 相同逻辑）：
//   sku_info      SKU → [款号, 颜色, 码数]
//   return_style  款号 → 供应商名称
//   return_addr   供应商 → 退货地址
//
// 触发：
//   POST /sync                手动增量同步（返回结果 JSON）
//   POST /sync?mode=full      全量分片刷新（配合 full_cursor，多次调用直至完成）
//   Scheduled（cron）         每天 03:00/11:00/19:00 自动增量同步
//
// 环境变量：
//   JST_APP_KEY / JST_APP_SECRET / JST_ACCESS_TOKEN   聚水潭开放平台
//   SUPABASE_URL / SUPABASE_SERVICE_KEY               Supabase 服务端密钥（写库）
//   INCR_DAYS                                        增量回看天数（默认 7）
//
// 部署：
//   cd backend/jst-sync/worker
//   wrangler secret put JST_APP_SECRET
//   wrangler secret put JST_ACCESS_TOKEN
//   wrangler secret put SUPABASE_SERVICE_KEY
//   wrangler deploy
// ============================================================

const ALLOWED_CATEGORIES = new Set(['背心','短裤','长裤','七分裤','短袖衬衫','套装','长袖衬衫','毛衣','外套','卫衣','羽绒外套','短袖T','长袖T','马甲','裙子']);
const PAGE_SIZE = 50;
const BATCH = 50;
const FULL_CHUNK = 2000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = dt => dt.toISOString().replace('T',' ').slice(0,19);

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env, 'incremental'));
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    try {
      const url = new URL(request.url);
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      const mode = url.searchParams.get('mode') || body.mode || 'incremental';
      const out = await runSync(env, mode);
      return json(out);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};

// ---------- 聚水潭请求 ----------
function jstSign(params, secret) {
  const sorted = Object.keys(params).sort();
  let str = secret;
  for (const k of sorted) if (k !== 'sign' && params[k]) str += k + params[k];
  return md5(str);
}
async function md5(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('MD5', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function jstPost(env, endpoint, bizData) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ts = Math.floor(Date.now()/1000).toString();
    const params = { app_key: env.JST_APP_KEY, access_token: env.JST_ACCESS_TOKEN, timestamp: ts, version: '2', charset: 'utf-8', biz: JSON.stringify(bizData) };
    params.sign = await jstSign(params, env.JST_APP_SECRET);
    const body = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const r = await fetch(env.JST_BASE_URL + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body });
    const d = await r.json().catch(() => ({}));
    if (d.code === 0) return d;
    if (d.code === 199 || d.code === 200) { await sleep(1500 * (attempt + 1)); continue; }
    if (d.code === 110) throw new Error('JST IP白名单拒绝: ' + d.msg);
    return d;
  }
  return { code: -1, msg: '频次超限重试次数用尽' };
}

// ---------- Supabase ----------
async function sb(env, path, opts = {}) {
  const r = await fetch(env.SUPABASE_URL.replace(/\/+$/,'') + path, {
    ...opts,
    headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY, ...(opts.headers || {}) },
  });
  if (!r.ok && r.status !== 204) throw new Error('Supabase HTTP ' + r.status + ' ' + path);
  return r.status === 204 ? null : r.json();
}
async function readMaps(env) {
  const rows = await sb(env, '/rest/v1/mapping_data?select=id,data');
  const byId = {};
  for (const row of rows) byId[row.id] = row.data || {};
  return { sku_info: byId['sku_info']||{}, return_style: byId['return_style']||{}, return_addr: byId['return_addr']||{} };
}
async function saveMaps(env, maps) {
  for (const [id, data] of Object.entries(maps)) {
    await sb(env, '/rest/v1/mapping_data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
    });
  }
}
async function readCursor(env) {
  const rows = await sb(env, '/rest/v1/mapping_data?select=data&id=eq.full_cursor');
  if (rows[0] && rows[0].data && typeof rows[0].data.cursor === 'number') return rows[0].data.cursor;
  return 0;
}
async function saveCursor(env, cursor) {
  await sb(env, '/rest/v1/mapping_data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'full_cursor', data: { cursor }, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

// ---------- 聚水潭查询 ----------
async function fetchAllCategories(env) {
  const cats = new Map(); let page = 1;
  for (;;) {
    const d = await jstPost(env, '/open/category/query', { page_index: page, page_size: 50 });
    if (d.code !== 0) break;
    for (const row of (d.data && d.data.datas) || []) cats.set(row.c_id, row);
    if (!d.data || !d.data.has_next || page > 20) break;
    page++; await sleep(200);
  }
  return cats;
}
function makeCategoryFilter(cats) {
  const cache = new Map();
  function pathOf(cid) {
    if (cache.has(cid)) return cache.get(cid);
    const names = []; let cur = cid, guard = 0;
    while (cur != null && guard++ < 20) { const c = cats.get(cur); if (!c) break; names.push(c.name); cur = c.parent_c_id; }
    cache.set(cid, names); return names;
  }
  return cid => (cid == null ? false : pathOf(cid).some(n => ALLOWED_CATEGORIES.has(n)));
}
async function fetchAllSuppliers(env) {
  const all = new Map(); let page = 1;
  for (;;) {
    const d = await jstPost(env, '/open/supplier/query', { page_index: page, page_size: PAGE_SIZE });
    if (d.code !== 0) break;
    for (const row of (d.data && d.data.datas) || []) all.set(row.supplier_id, row);
    if (!d.data || !d.data.has_next || page > 100) break;
    page++; await sleep(200);
  }
  return [...all.values()];
}
function parseColorSize(val) {
  if (!val) return ['',''];
  const parts = String(val).split(/[;；,，]/).map(s=>s.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' ')];
  if (parts.length === 1) return [parts[0], ''];
  return ['',''];
}
async function queryByTime(env, begin, end) {
  const out = []; let page = 1;
  for (;;) {
    const d = await jstPost(env, '/open/sku/query', { page_index: page, page_size: PAGE_SIZE, modified_begin: begin, modified_end: end });
    if (d.code !== 0) break;
    out.push(...((d.data && d.data.datas) || []));
    if (!d.data || !d.data.has_next || page > 300) break;
    page++; await sleep(250);
  }
  return out;
}
async function queryBySkuIds(env, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    let page = 1;
    for (;;) {
      const d = await jstPost(env, '/open/sku/query', { page_index: page, page_size: PAGE_SIZE, sku_ids: chunk.join(',') });
      if (d.code !== 0) break;
      out.push(...((d.data && d.data.datas) || []));
      if (!d.data || !d.data.has_next || page > 5) break;
      page++; await sleep(200);
    }
    await sleep(200);
  }
  return out;
}
async function extractMissingFromRecords(env, existing) {
  const used = new Set();
  for (let offset = 0; offset < 10000; offset += 1000) {
    const rows = await sb(env, `/rest/v1/defect_reports?select=note&limit=1000&offset=${offset}`);
    if (!rows.length) break;
    for (const rec of rows) {
      const note = (rec.note || '').replace(/\s*\[[^\]]*\]/g, '');
      for (const m of note.matchAll(/([A-Za-z0-9][A-Za-z0-9\-]*)[×x](\d+)/g)) if (m[1].length >= 3) used.add(m[1]);
    }
  }
  return [...used].filter(c => !existing.has(c));
}
async function extractStyleMissingFromRecords(env, skuInfo, styleSupplier) {
  const used = new Set();
  for (let offset = 0; offset < 10000; offset += 1000) {
    const rows = await sb(env, `/rest/v1/defect_reports?select=note&limit=1000&offset=${offset}`);
    if (!rows.length) break;
    for (const rec of rows) {
      const note = (rec.note || '').replace(/\s*\[[^\]]*\]/g, '');
      for (const m of note.matchAll(/([A-Za-z0-9][A-Za-z0-9\-]*)[×x](\d+)/g)) if (m[1].length >= 3) used.add(m[1]);
    }
  }
  const need = [];
  for (const c of used) {
    const info = skuInfo[c];
    if (!info || !info[0]) continue;
    const sup = String(styleSupplier[info[0]] || '').trim();
    if (!sup || sup.includes('*') || sup === '市场') need.push(c);
  }
  return need;
}

// ---------- 主流程 ----------
async function runSync(env, mode) {
  const maps = await readMaps(env);
  const skuInfo = maps.sku_info || {};
  const styleSupplier = maps.return_style || {};
  const addrMap = maps.return_addr || {};
  const base = new Set(Object.keys(skuInfo));

  const freshMap = new Map();
  let cursor = null, backfill = 0;
  if (mode === 'full') {
    cursor = await readCursor(env);
    if (cursor < 0) cursor = 0;
    const ids = [...base];
    const chunk = ids.slice(cursor, cursor + FULL_CHUNK);
    if (chunk.length) { const rows = await queryBySkuIds(env, chunk); for (const r of rows) freshMap.set(r.sku_id, r); }
    cursor += chunk.length;
    if (cursor >= ids.length) cursor = -1;
  } else {
    const days = parseInt(env.INCR_DAYS || '7', 10);
    const end = new Date(), begin = new Date(Date.now() - days*86400000);
    const rows = await queryByTime(env, fmt(begin), fmt(end));
    for (const r of rows) freshMap.set(r.sku_id, r);
    const missing = await extractMissingFromRecords(env, base);
    backfill = missing.length;
    if (missing.length) { const rows2 = await queryBySkuIds(env, missing); for (const r of rows2) freshMap.set(r.sku_id, r); }
  }

  const cats = await fetchAllCategories(env);
  const isAllowed = makeCategoryFilter(cats);
  const suppliers = await fetchAllSuppliers(env);
  const supplierById = {};
  for (const s of suppliers) if (s.supplier_id != null) supplierById[String(s.supplier_id)] = s;
  const supplierNameCache = new Map();

  let addedSku = 0, updatedSku = 0, addedStyle = 0, updatedStyle = 0;
  for (const [sid, row] of freshMap) {
    if (!isAllowed(row.c_id)) continue;
    const iId = (row.i_id || '').trim();
    if (!iId) continue;
    const [color, size] = parseColorSize(row.properties_value);
    if (!skuInfo[sid]) addedSku++; else updatedSku++;
    skuInfo[sid] = [iId, color, size];
    let sname = String(row.supplier_name || '').trim();
    if (!sname && row.supplier_id != null) {
      const key = String(row.supplier_id);
      if (!supplierNameCache.has(key)) { const s = supplierById[key]; supplierNameCache.set(key, s && s.name ? String(s.name).trim() : ''); }
      sname = supplierNameCache.get(key);
    }
    if (sname) { if (!styleSupplier[iId]) addedStyle++; else if (styleSupplier[iId] !== sname) updatedStyle++; styleSupplier[iId] = sname; }
  }
  // 记录款号补齐
  const styleNeed = await extractStyleMissingFromRecords(env, skuInfo, styleSupplier);
  if (styleNeed.length) {
    const rows3 = await queryBySkuIds(env, styleNeed);
    for (const row of rows3) {
      if (!isAllowed(row.c_id)) continue;
      const iId = (row.i_id || '').trim();
      if (!iId) continue;
      let sname = String(row.supplier_name || '').trim();
      if (!sname && row.supplier_id != null) {
        const key = String(row.supplier_id);
        if (!supplierNameCache.has(key)) { const s = supplierById[key]; supplierNameCache.set(key, s && s.name ? String(s.name).trim() : ''); }
        sname = supplierNameCache.get(key);
      }
      if (sname) { if (!styleSupplier[iId]) addedStyle++; else if (styleSupplier[iId] !== sname) updatedStyle++; styleSupplier[iId] = sname; }
    }
  }

  let addrAdded = 0, addrUpdated = 0;
  for (const s of suppliers) {
    const name = String(s.name || '').trim();
    if (!name) continue;
    const info = {};
    if (s.address) info.address = s.address;
    if (s.mobile) info.mobile = s.mobile;
    if (s.contacts) info.contacts = s.contacts;
    if (!Object.keys(info).length) continue;
    if (!addrMap[name]) addrAdded++; else addrUpdated++;
    addrMap[name] = info;
  }

  await saveMaps(env, { sku_info: skuInfo, return_style: styleSupplier, return_addr: addrMap });
  if (mode === 'full') await saveCursor(env, cursor);

  return {
    ok: true, mode, time: new Date().toISOString(),
    counts: { sku_info: Object.keys(skuInfo).length, return_style: Object.keys(styleSupplier).length, return_addr: Object.keys(addrMap).length, fresh_fetched: freshMap.size },
    delta: { addedSku, updatedSku, addedStyle, updatedStyle, addrAdded, addrUpdated, backfill },
    cursor,
  };
}
