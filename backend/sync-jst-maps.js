// ============================================================
// 聚水潭 → 次品系统 商品资料同步脚本（Node.js 18+）
// ------------------------------------------------------------
// 用途：以聚水潭资料为准，生成次品系统前端依赖的 3 个映射文件：
//   sku_info_map.json      SKU → [款号, 颜色, 码数]（仅保留指定商品分类）
//   return_style_map.json  款号 → 供应商名称（仅保留指定商品分类）
//   return_addr_map.json   供应商 → 退货地址（完整保留）
// 数据源接口：
//   POST /open/sku/query       普通商品资料查询（按 SKU，sku_ids 逗号分隔批量查）
//   POST /open/supplier/query  供应商查询
// 运行（Windows PowerShell）：
//   $env:JST_APP_KEY="..."; $env:JST_APP_SECRET="..."; $env:JST_ACCESS_TOKEN="..."
//   node sync-jst-maps.js [输出目录，默认上一级目录] [full|incremental]
//     full        全量：以现有 sku_info_map.json 的 SKU 名单为基础，批量刷新（默认）
//     incremental 增量：只同步最近 N 天（默认7天）新改动的商品，合并进现有文件
//     supplier    只更新供应商：用聚水潭『商品多供应商』接口重建 款号→供应商
// 可选环境变量：
//   JST_DAYS           incremental 的天数，默认 7
//   JST_DELAY_MS       请求间隔毫秒，默认 700（限流保护）
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JST = {
  appKey: process.env.JST_APP_KEY || '',
  appSecret: process.env.JST_APP_SECRET || '',
  accessToken: process.env.JST_ACCESS_TOKEN || '',
  baseUrl: process.env.JST_BASE_URL || 'https://openapi.jushuitan.com',
  days: parseInt(process.env.JST_DAYS || '7', 10),
  delayMs: parseInt(process.env.JST_DELAY_MS || '700', 10),
};
const OUT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const MODE = (process.argv[3] || 'full').toLowerCase();
const PAGE_SIZE = 50;          // 每页条数（最大50）
const BATCH = 50;              // 每次查询的 sku_ids 数量

// 只保留这些商品分类（其余分类的商品一律不要；名称以聚水潭类目为准）
const ALLOWED_CATEGORIES = new Set([
  '背心', '短裤', '长裤', '七分裤', '短袖衬衫', '套装', '长袖衬衫',
  '毛衣', '外套', '卫衣', '羽绒外套', '短袖T', '长袖T', '马甲', '裙子',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toISOString().replace('T', ' ').slice(0, 19);

if (!JST.appKey || !JST.appSecret || !JST.accessToken) {
  console.error('❌ 缺少配置：请设置 JST_APP_KEY / JST_APP_SECRET / JST_ACCESS_TOKEN');
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// ---------- 聚水潭请求（带限流退避） ----------
function jstSign(params) {
  const sorted = Object.keys(params).sort();
  let str = JST.appSecret;
  for (const k of sorted) if (k !== 'sign' && params[k]) str += k + params[k];
  return crypto.createHash('md5').update(str).digest('hex');
}

async function jstPost(endpoint, bizData) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const biz = JSON.stringify(bizData);
    const params = { app_key: JST.appKey, access_token: JST.accessToken, timestamp: ts, version: '2', charset: 'utf-8', biz };
    params.sign = jstSign(params);
    const body = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const r = await fetch(JST.baseUrl + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    const d = await r.json();
    if (d.code === 0) return d;
    if (d.code === 200) {                 // 调用频次超限：等待 60 秒后重试
      console.warn(`  ⚠️ 频次超限，等待 60 秒重试（第${attempt + 1}次）...`);
      await sleep(60000);
      continue;
    }
    return d;                             // 其他错误直接返回
  }
  return { code: -1, msg: '频次超限重试次数用尽' };
}

// ---------- 按 sku_ids 批量查询商品 ----------
async function querySkuBatch(skuIds) {
  const out = [];
  let page = 1;
  while (true) {
    const d = await jstPost('/open/sku/query', {
      page_index: page, page_size: PAGE_SIZE, sku_ids: skuIds.join(','),
    });
    if (d.code !== 0) { console.error(`  批量查询失败(code=${d.code}): ${d.msg}`); return out; }
    const rows = (d.data && d.data.datas) || [];
    out.push(...rows);
    if (!d.data || !d.data.has_next) break;
    page++;
    if (page > 20) break;
    await sleep(JST.delayMs);
  }
  return out;
}

// ---------- 拉取全部商品类目（c_id → 名称/父级） ----------
async function fetchAllCategories() {
  const cats = new Map();
  let page = 1;
  while (true) {
    const d = await jstPost('/open/category/query', { page_index: page, page_size: 50 });
    if (d.code !== 0) { console.error(`  类目查询失败: code=${d.code} msg=${d.msg}`); break; }
    const rows = (d.data && d.data.datas) || [];
    for (const row of rows) cats.set(row.c_id, row);
    if (!d.data || !d.data.has_next) break;
    page++;
    if (page > 100) break;
    await sleep(JST.delayMs);
  }
  return cats;
}

// ---------- 判断 SKU 是否属于允许分类（含父级分类链） ----------
function makeCategoryFilter(cats) {
  const pathCache = new Map();          // c_id -> 名称数组（含父级）
  function pathOf(cid) {
    if (pathCache.has(cid)) return pathCache.get(cid);
    const names = [];
    let cur = cid;
    let guard = 0;
    while (cur != null && guard++ < 20) {
      const c = cats.get(cur);
      if (!c) break;
      names.push(c.name);
      cur = c.parent_c_id;
    }
    pathCache.set(cid, names);
    return names;
  }
  return function isAllowed(cid) {
    if (cid == null) return false;
    return pathOf(cid).some(n => ALLOWED_CATEGORIES.has(n));
  };
}

// ---------- 拉取全部供应商 ----------
async function fetchAllSuppliers() {
  const all = new Map();
  let page = 1;
  while (true) {
    const d = await jstPost('/open/supplier/query', { page_index: page, page_size: PAGE_SIZE });
    if (d.code !== 0) { console.error(`  供应商查询失败: code=${d.code} msg=${d.msg}`); break; }
    const rows = (d.data && d.data.datas) || [];
    for (const row of rows) all.set(row.supplier_id, row);
    if (!d.data || !d.data.has_next) break;
    page++;
    if (page > 100) break;
    await sleep(JST.delayMs);
  }
  return [...all.values()];
}

// ---------- 解析颜色/码数（properties_value 形如 "白色;L"） ----------
function parseColorSize(val) {
  if (!val) return ['', ''];
  const parts = String(val).split(/[;；,，]/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' ')];
  if (parts.length === 1) return [parts[0], ''];
  return ['', ''];
}

// ---------- 主流程 ----------
async function main() {
  const skuFile = path.join(OUT_DIR, 'sku_info_map.json');
  if (MODE === 'supplier') {
    const skuMap = readJson(skuFile, {});
    const styleMap = readJson(path.join(OUT_DIR, 'return_style_map.json'), {});
    await runSupplierUpdate(skuMap, styleMap);
    return;
  }
  const styleFile = path.join(OUT_DIR, 'return_style_map.json');
  const addrFile = path.join(OUT_DIR, 'return_addr_map.json');
  const oldSkuMap = readJson(skuFile, {});
  const oldStyleMap = readJson(styleFile, {});
  const oldAddrMap = readJson(addrFile, {});

  // 1) 确定要查询的 SKU 名单
  let base = new Set(Object.keys(oldSkuMap));
  if (MODE === 'incremental') {
    // 增量：先按最近 N 天改动时间找出新 SKU，再合并查询
    const end = new Date(), begin = new Date(Date.now() - JST.days * 86400000);
    console.log(`① 增量模式：查询最近 ${JST.days} 天改动的商品...`);
    const fresh = await querySkuBatchByTime(begin, end);
    for (const s of fresh) if (!base.has(s.sku_id)) base.add(s.sku_id);
    console.log(`   名单共 ${base.size} 个 SKU`);
  } else {
    console.log(`① 全量模式：基于现有名单 ${base.size} 个 SKU 批量刷新`);
  }

  // 2) 批量查询（每次 50 个）
  const ids = [...base];
  const freshMap = new Map();
  console.log(`② 开始批量查询（共 ${ids.length} 个 SKU，每次 ${BATCH} 个）...`);
  let done = 0, notFound = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const rows = await querySkuBatch(chunk);
    for (const row of rows) freshMap.set(row.sku_id, row);
    notFound += chunk.length - rows.length;
    done += chunk.length;
    if (done % 500 === 0 || done === ids.length) {
      console.log(`   ...${done}/${ids.length} 个SKU已处理（未返回 ${notFound}）`);
    }
    await sleep(JST.delayMs);
  }
  console.log(`   查询完成：聚水潭返回 ${freshMap.size} 个，未返回 ${notFound} 个`);

  // 3) 拉取供应商
  console.log('⑤ 拉取聚水潭供应商...');
  const suppliers = await fetchAllSuppliers();
  const supplierById = {};
  for (const s of suppliers) if (s.supplier_id != null) supplierById[String(s.supplier_id)] = s;

  // 3.5) 拉取类目，构建分类过滤器
  console.log('④ 拉取商品类目并过滤...');
  const cats = await fetchAllCategories();
  const isAllowed = makeCategoryFilter(cats);

  // 4) 生成 sku_info_map.json：只保留允许分类的 SKU（以聚水潭为准）
  const skuMap = {};
  let kept = 0, dropped = 0;
  for (const [sid, sku] of freshMap) {
    if (!isAllowed(sku.c_id)) { dropped++; continue; }
    const iId = (sku.i_id || '').trim();
    const [color, size] = parseColorSize(sku.properties_value);
    skuMap[sid] = [iId, color, size];
    kept++;
  }
  console.log(`   分类过滤：保留 ${kept} 个 SKU，排除 ${dropped} 个（非指定分类或未分类）`);

  // 5) return_style_map.json：款号 → 供应商名称（仅允许分类）
  const styleSupplier = {};
  for (const [sid, sku] of freshMap) {
    if (!isAllowed(sku.c_id)) continue;
    const iId = (sku.i_id || '').trim();
    if (!iId) continue;
    const sup = sku.supplier_id != null ? supplierById[String(sku.supplier_id)] : null;
    const supName = sup && sup.name ? sup.name.trim() : '';
    if (supName && !styleSupplier[iId]) styleSupplier[iId] = supName;
  }

  // 6) return_addr_map.json：供应商 → 退货地址（完整保留，供退货使用）
  const addrMap = { ...oldAddrMap };
  for (const s of suppliers) {
    const name = (s.name || '').trim();
    if (!name) continue;
    const info = {};
    if (s.address) info.address = s.address;
    if (s.mobile) info.mobile = s.mobile;
    if (s.contacts) info.contacts = s.contacts;
    if (Object.keys(info).length) addrMap[name] = info;
  }

  const files = {
    'sku_info_map.json': skuMap,
    'return_style_map.json': styleSupplier,
    'return_addr_map.json': addrMap,
  };
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(OUT_DIR, name);
    fs.writeFileSync(target, JSON.stringify(data));
    console.log(`✅ 已生成 ${target}（${Object.keys(data).length} 条）`);
  }
  console.log('\n完成！请把生成的 3 个 json 提交到网页同层目录。');
}

// 增量：按时间窗口查询最近改动的 SKU（返回去重行）
async function querySkuBatchByTime(begin, end) {
  const seen = new Map();
  let page = 1;
  while (true) {
    const d = await jstPost('/open/sku/query', {
      page_index: page, page_size: PAGE_SIZE,
      modified_begin: fmt(begin), modified_end: fmt(end),
    });
    if (d.code !== 0) { console.error(`  时间查询失败: code=${d.code} msg=${d.msg}`); break; }
    const rows = (d.data && d.data.datas) || [];
    for (const row of rows) seen.set(row.sku_id, row);
    if (!d.data || !d.data.has_next) break;
    page++;
    if (page > 500) break;
    await sleep(JST.delayMs);
  }
  return [...seen.values()];
}

// ---------- 供应商模式：用『商品多供应商』接口重建 款号→供应商 ----------
const INVALID_SUPPLIERS = ['吕**-整烫', '吕老板整烫', '市场'];

async function fetchSupplierRelations(skuIds) {
  const out = [];
  let page = 1;
  while (true) {
    const d = await jstPost('/open/webapi/itemapi/suppliersku/getsupplierskulist', {
      page_index: page, page_size: PAGE_SIZE, skuIds,
    });
    if (d.code !== 0) { console.error(`  多供应商查询失败(code=${d.code}): ${d.msg}`); return out; }
    const rows = (d.data && d.data.list) || [];
    out.push(...rows);
    const pg = d.data && d.data.page;
    if (!pg || rows.length < PAGE_SIZE || out.length >= pg.count || page >= pg.pages) break;
    page++;
    await sleep(JST.delayMs);
  }
  return out;
}

async function runSupplierUpdate(skuMap, oldStyleMap) {
  const ids = Object.keys(skuMap);
  console.log(`① 多供应商模式：处理 ${ids.length} 个 SKU（每次 ${BATCH} 个）...`);
  const rels = [];
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const rows = await fetchSupplierRelations(chunk);
    rels.push(...rows);
    done += chunk.length;
    if (done % 5000 === 0 || done === ids.length) console.log(`   ...${done}/${ids.length}`);
    await sleep(JST.delayMs);
  }
  console.log(`   共获取 ${rels.length} 条供应商关联`);

  // 款号 -> 各供应商出现次数（过滤无效供应商）
  const styleCount = {};
  for (const r of rels) {
    const iId = (r.i_id || '').trim();
    const name = (r.supplier_name || '').trim();
    if (!iId || !name || INVALID_SUPPLIERS.includes(name)) continue;
    if (!styleCount[iId]) styleCount[iId] = {};
    styleCount[iId][name] = (styleCount[iId][name] || 0) + 1;
  }

  // 每个款号取出现次数最多的供应商；无有效供应商则保留旧值
  const styleSupplier = { ...oldStyleMap };
  let added = 0, keptOld = 0;
  for (const [iId, counts] of Object.entries(styleCount)) {
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (!styleSupplier[iId]) added++;
    styleSupplier[iId] = best;
  }
  for (const iId of Object.keys(styleSupplier)) if (!styleCount[iId]) keptOld++;

  // 供应商退货地址照旧刷新
  console.log('② 拉取聚水潭供应商...');
  const suppliers = await fetchAllSuppliers();
  const addrMap = { ...readJson(path.join(OUT_DIR, 'return_addr_map.json'), {}) };
  for (const s of suppliers) {
    const name = (s.name || '').trim();
    if (!name) continue;
    const info = {};
    if (s.address) info.address = s.address;
    if (s.mobile) info.mobile = s.mobile;
    if (s.contacts) info.contacts = s.contacts;
    if (Object.keys(info).length) addrMap[name] = info;
  }

  const styleFile = path.join(OUT_DIR, 'return_style_map.json');
  const addrFile = path.join(OUT_DIR, 'return_addr_map.json');
  fs.writeFileSync(styleFile, JSON.stringify(styleSupplier));
  fs.writeFileSync(addrFile, JSON.stringify(addrMap));
  console.log(`✅ 已生成 ${styleFile}（${Object.keys(styleSupplier)} 条；新增 ${added}，沿用旧值 ${keptOld}）`);
  console.log(`✅ 已生成 ${addrFile}（${Object.keys(addrMap)} 条）`);
  console.log('\n完成！请提交到网页同层目录。');
}

main().catch(e => { console.error('❌ 同步失败:', e.message); process.exit(1); });
