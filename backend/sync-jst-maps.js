// ============================================================
// 聚水潭 → 次品系统 商品资料同步脚本（Node.js 18+）
// ------------------------------------------------------------
// 用途：以聚水潭资料为准，生成次品系统前端依赖的 3 个映射文件：
//   sku_info_map.json      SKU → [款号, 颜色, 码数]
//   return_style_map.json  款号 → 供应商名称
//   return_addr_map.json   供应商 → 退货地址
// 数据源接口：
//   POST /open/sku/query       普通商品资料查询（按 SKU）
//   POST /open/supplier/query  供应商查询
// 运行：
//   set JST_APP_KEY=xxx & set JST_APP_SECRET=xxx & set JST_ACCESS_TOKEN=xxx
//   node sync-jst-maps.js [输出目录，默认上一级目录]
// ============================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- 配置（优先读环境变量） ----------
const JST = {
  appKey: process.env.JST_APP_KEY || '',
  appSecret: process.env.JST_APP_SECRET || '',
  accessToken: process.env.JST_ACCESS_TOKEN || '',
  baseUrl: process.env.JST_BASE_URL || 'https://openapi.jushuitan.com',
  // 可选：增量同步时间范围（格式 YYYY-MM-DD HH:mm:ss），留空则全量
  modifiedBegin: process.env.JST_MODIFIED_BEGIN || '',
  modifiedEnd: process.env.JST_MODIFIED_END || '',
};
const OUT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));

if (!JST.appKey || !JST.appSecret || !JST.accessToken) {
  console.error('❌ 缺少配置：请设置 JST_APP_KEY / JST_APP_SECRET / JST_ACCESS_TOKEN');
  process.exit(1);
}

// ---------- 聚水潭请求工具（与 return-worker 同签名规则） ----------
function jstSign(params) {
  const sorted = Object.keys(params).sort();
  let str = JST.appSecret;
  for (const k of sorted) {
    if (k !== 'sign' && params[k]) str += k + params[k];
  }
  return crypto.createHash('md5').update(str).digest('hex');
}

async function jstPost(endpoint, bizData) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const biz = JSON.stringify(bizData);
  const params = {
    app_key: JST.appKey,
    access_token: JST.accessToken,
    timestamp: ts,
    version: '2',
    charset: 'utf-8',
    biz,
  };
  params.sign = jstSign(params);
  const body = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const r = await fetch(JST.baseUrl + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  return r.json();
}

// ---------- 分页拉取全部数据 ----------
async function fetchAll(endpoint, pageSize = 50, extra = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const params = { page_index: page, page_size: pageSize, ...extra };
    const d = await jstPost(endpoint, params);
    if (d.code !== 0) {
      throw new Error(`${endpoint} 第${page}页失败: ${d.msg || JSON.stringify(d)}`);
    }
    const rows = (d.data && d.data.datas) || [];
    all.push(...rows);
    if (rows.length < pageSize) break; // 拉完了
    page++;
    if (page > 5000) { console.warn('⚠️ 超过 5000 页，提前停止'); break; }
  }
  return all;
}

// ---------- 解析颜色/码数（properties_value 形如 "蓝色;XXL"） ----------
function parseColorSize(val) {
  if (!val) return ['', ''];
  const parts = String(val).split(/[;；,，]/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' ')];
  if (parts.length === 1) return [parts[0], ''];
  return ['', ''];
}

// ---------- 主流程 ----------
async function main() {
  console.log('① 拉取聚水潭商品资料 /open/sku/query ...');
  const skus = await fetchAll('/open/sku/query', 50, JST.modifiedBegin ? {
    modified_begin: JST.modifiedBegin,
    modified_end: JST.modifiedEnd,
  } : {});
  console.log(`   共 ${skus.length} 条 SKU`);

  console.log('② 拉取聚水潭供应商 /open/supplier/query ...');
  const suppliers = await fetchAll('/open/supplier/query', 50);
  console.log(`   共 ${suppliers.length} 个供应商`);

  // 供应商编号 → 供应商（用于 SKU 的 supplier_id 转名称）
  const supplierById = {};
  for (const s of suppliers) {
    if (s.supplier_id != null) supplierById[String(s.supplier_id)] = s;
  }

  // 1) sku_info_map.json：{ sku_id: [款号, 颜色, 码数] }
  const skuMap = {};
  for (const sku of skus) {
    const iId = (sku.i_id || '').trim();
    const [color, size] = parseColorSize(sku.properties_value);
    skuMap[sku.sku_id] = [iId, color, size];
  }

  // 2) return_style_map.json：{ 款号: 供应商名称 }
  const styleSupplier = {};
  for (const sku of skus) {
    const iId = (sku.i_id || '').trim();
    if (!iId) continue;
    const sup = sku.supplier_id != null ? supplierById[String(sku.supplier_id)] : null;
    const supName = sup && sup.name ? sup.name.trim() : '';
    // 同一款号可能多个 SKU，供应商一致则取；不一致取第一个非空
    if (supName && !styleSupplier[iId]) styleSupplier[iId] = supName;
  }

  // 3) return_addr_map.json：{ 供应商名称: {address, mobile, contacts} }
  const addrMap = {};
  for (const s of suppliers) {
    const name = (s.name || '').trim();
    if (!name) continue;
    const info = {};
    if (s.address) info.address = s.address;
    if (s.mobile) info.mobile = s.mobile;
    if (s.contacts) info.contacts = s.contacts;
    if (Object.keys(info).length) addrMap[name] = info;
  }

  // 写文件
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
  console.log('\n完成！请把生成的 3 个 json 上传到网页同层目录（覆盖同名文件）。');
}

main().catch(e => {
  console.error('❌ 同步失败:', e.message);
  process.exit(1);
});
