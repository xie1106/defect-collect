// 次品退货 Worker - 创建聚水潭退货订单
// POST /create-return { po_id }

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    try {
      const { po_id } = await request.json();
      if (!po_id) return json({ error: 'missing po_id' }, 400);

      // 1. Get defect records from Supabase
      const records = await getDefectRecords(env, po_id);
      if (!records.length) return json({ error: 'no_records', msg: '无待处理记录' });

      // 2. Get supplier from purchase order
      let supplier = await getSupplierFromPO(env, po_id);
      const INVALID = ['吕**-整烫', '吕老板整烫', '市场'];
      
      let i_id = '';
      if (!supplier || INVALID.some(inv => (supplier||'').includes(inv))) {
        // Try JST first, but fall back to extracting i_id from Supabase records
        try {
          const poData = await jstPost(env, '/open/purchase/query', { page_index:1, page_size:5, po_ids:[parseInt(po_id)] });
          if (poData?.code === 0) {
            const items = poData?.data?.datas?.[0]?.items || [];
            if (items.length) i_id = items[0].i_id || '';
          }
        } catch(e) { /* JST unavailable, continue */ }
        
        // If JST failed or returned no i_id, extract from Supabase record notes
        if (!i_id && records.length) {
          // note format: "602501L×1" or "Q605501M×2" — i_id is the prefix before size code
          for (const rec of records) {
            const m = (rec.note||'').match(/^([A-Za-z]?\d{4,6})/);
            if (m) { i_id = m[1]; break; }
          }
        }
        
        // Try style map
        const docSupplier = findSupplierFromStyle(env, i_id);
        if (docSupplier) {
          supplier = docSupplier;
        } else {
          return json({ error: 'no_supplier', msg: `无法匹配供应商 (i_id=${i_id})`, i_id });
        }
      }

      // 3. Find return address
      const addrInfo = await findReturnAddress(env, supplier);
      if (!addrInfo || !addrInfo.address) {
        return json({ error: 'no_address', msg: `供应商[${supplier}]无退货地址`, supplier });
      }

      // 4. Parse items from records
      const skuItems = parseSkuItems(records);
      const totalQty = skuItems.reduce((s, i) => s + i.qty, 0);
      const detail = skuItems.map(i => `${i.sku_id}×${i.qty}`).join(', ');
      const remark = `采购单${po_id} | ${detail} | 合计${totalQty}件`;

      // 5. Create order
      const orderId = `DEFECT-${po_id}-${Date.now()}`;
      const addr = parseAddress(addrInfo.address);
      const order = {
        shop_id: parseInt(env.RETURN_SHOP_ID),
        so_id: orderId,
        order_date: new Date().toISOString().replace('T',' ').slice(0,19),
        shop_buyer_id: `supplier_${po_id}`,
        pay_amount: 0, freight: 0,
        receiver_name: addrInfo.contacts || addrInfo.contact || '收件人',
        receiver_mobile: addrInfo.mobile || '00000000000',
        receiver_state: addr.state, receiver_city: addr.city,
        receiver_district: addr.district, receiver_address: addr.address,
        remark: remark, seller_memo: remark,
        items: [{ sku_id: `RETURN-${po_id}`, shop_sku_id: `RETURN-${po_id}`,
                  name: `次品退货-采购单${po_id}`, qty: 1, sale_price: 0, amount: 0, outer_oi_id: 'oi_1' }]
      };

      const result = await jstPost(env, '/open/jushuitan/orders/upload', [order]);
      if (result?.code === 0) {
        // 6. Update Supabase records with return tag
        await tagRecords(env, records, orderId);
        return json({ success: true, order_id: orderId, supplier, address: addrInfo.address, detail, total: totalQty });
      } else {
        return json({ error: 'create_failed', msg: result?.msg || 'unknown', supplier });
      }
    } catch (e) {
      return json({ error: 'exception', msg: e.message }, 500);
    }
  }
};

// --- Helpers ---
function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS',
           'Access-Control-Allow-Headers': 'Content-Type' };
}
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }});
}

function jstSign(params, secret) {
  const sorted = Object.keys(params).sort();
  let str = secret;
  for (const k of sorted) { if (k !== 'sign' && params[k]) str += k + params[k]; }
  return md5Hash(str);
}

async function jstPost(env, endpoint, bizData) {
  const ts = Math.floor(Date.now()/1000).toString();
  const biz = JSON.stringify(bizData);
  const params = { app_key: env.JST_APP_KEY, access_token: env.JST_ACCESS_TOKEN, timestamp: ts, version: '2', charset: 'utf-8', biz };
  params.sign = jstSign(params, env.JST_APP_SECRET);
  const body = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(env.JST_BASE_URL + endpoint, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body });
  return r.json();
}

async function getDefectRecords(env, po_id) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/defect_reports?po_id=eq.${po_id}&status=eq.pending&order=created_at.desc`, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
  });
  const all = await r.json();
  return all.filter(rec => !(rec.note||'').includes('[1688:'));
}

async function getSupplierFromPO(env, po_id) {
  try {
    const d = await jstPost(env, '/open/purchase/query', { page_index:1, page_size:5, po_ids:[parseInt(po_id)] });
    if (d?.code === 0) {
      const po = d?.data?.datas?.[0];
      return po?.supplier_name || po?.seller || null;
    }
  } catch(e) { /* JST unavailable */ }
  return null;
}

function findSupplierFromStyle(env, i_id) {
  if (!i_id) return null;
  const STYLE_MAP = JSON.parse(env.STYLE_MAP || '{}');
  const key = i_id.trim().toUpperCase();
  if (STYLE_MAP[key]) return STYLE_MAP[key];
  for (const [k,v] of Object.entries(STYLE_MAP)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

async function findReturnAddress(env, supplier) {
  if (!supplier) return null;
  // 1. JST supplier API
  const d = await jstPost(env, '/open/supplier/query', { page_index:1, page_size:50 });
  const suppliers = d?.data?.datas || [];
  for (const s of suppliers) {
    if (s.address && (s.name === supplier || supplier.includes(s.name) || s.name.includes(supplier))) {
      return { address: s.address, mobile: s.mobile, contacts: s.contacts };
    }
  }
  // 2. Return address map
  const ADDR_MAP = JSON.parse(env.RETURN_ADDR_MAP || '{}');
  const norm = supplier.replace(/档口/g,'').trim().toLowerCase();
  for (const [name, info] of Object.entries(ADDR_MAP)) {
    const nameNorm = name.replace(/档口/g,'').trim().toLowerCase();
    if (norm === nameNorm || norm.includes(nameNorm) || nameNorm.includes(norm)) return info;
  }
  return null;
}

function parseSkuItems(records) {
  const items = [];
  for (const rec of records) {
    const note = (rec.note||'').replace(/\s*\[[^\]]*\]/g,'').trim();
    const m = note.match(/^([A-Za-z0-9\-]+)[×x](\d+)/);
    if (m) items.push({ sku_id: m[1], qty: parseInt(m[2]) });
  }
  return items;
}

function parseAddress(addr) {
  if (!addr) return { state:'广东省', city:'广州市', district:'', address:'' };
  const parts = addr.trim().split(/\s+/);
  if (parts.length >= 4) return { state:parts[0], city:parts[1], district:parts[2], address:parts.slice(3).join(' ') };
  if (parts.length >= 3) return { state:parts[0], city:parts[1], district:'', address:parts.slice(2).join(' ') };
  const m = addr.match(/(.*?省)(.*?市)(.*?区|.*?县)?(.*)/);
  if (m) return { state:m[1], city:m[2], district:m[3]||'', address:m[4] };
  return { state:'广东省', city:'广州市', district:'', address: addr };
}

async function tagRecords(env, records, orderId) {
  for (const rec of records) {
    const note = (rec.note||'') + ` [退货:已下单:${orderId}]`;
    await fetch(`${env.SUPABASE_URL}/rest/v1/defect_reports?id=eq.${rec.id}`, {
      method: 'PATCH', headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ note })
    });
  }
}

// MD5 implementation
function md5Hash(string){function md5cycle(x,k){var a=x[0],b=x[1],c=x[2],d=x[3];a=ff(a,b,c,d,k[0],7,-680876936);d=ff(d,a,b,c,k[1],12,-389564586);c=ff(c,d,a,b,k[2],17,606105819);b=ff(b,c,d,a,k[3],22,-1044525330);a=ff(a,b,c,d,k[4],7,-176418897);d=ff(d,a,b,c,k[5],12,1200080426);c=ff(c,d,a,b,k[6],17,-1473231341);b=ff(b,c,d,a,k[7],22,-45705983);a=ff(a,b,c,d,k[8],7,1770035416);d=ff(d,a,b,c,k[9],12,-1958414417);c=ff(c,d,a,b,k[10],17,-42063);b=ff(b,c,d,a,k[11],22,-1990404162);a=ff(a,b,c,d,k[12],7,1804603682);d=ff(d,a,b,c,k[13],12,-40341101);c=ff(c,d,a,b,k[14],17,-1502002290);b=ff(b,c,d,a,k[15],22,1236535329);a=gg(a,b,c,d,k[1],5,-165796510);d=gg(d,a,b,c,k[6],9,-1069501632);c=gg(c,d,a,b,k[11],14,643717713);b=gg(b,c,d,a,k[0],20,-373897302);a=gg(a,b,c,d,k[5],5,-701558691);d=gg(d,a,b,c,k[10],9,38016083);c=gg(c,d,a,b,k[15],14,-660478335);b=gg(b,c,d,a,k[4],20,-405537848);a=gg(a,b,c,d,k[9],5,568446438);d=gg(d,a,b,c,k[14],9,-1019803690);c=gg(c,d,a,b,k[3],14,-187363961);b=gg(b,c,d,a,k[8],20,1163531501);a=gg(a,b,c,d,k[13],5,-1444681467);d=gg(d,a,b,c,k[2],9,-51403784);c=gg(c,d,a,b,k[7],14,1735328473);b=gg(b,c,d,a,k[12],20,-1926607734);a=hh(a,b,c,d,k[5],4,-378558);d=hh(d,a,b,c,k[8],11,-2022574463);c=hh(c,d,a,b,k[11],16,1839030562);b=hh(b,c,d,a,k[14],23,-35309556);a=hh(a,b,c,d,k[1],4,-1530992060);d=hh(d,a,b,c,k[4],11,1272893353);c=hh(c,d,a,b,k[7],16,-155497632);b=hh(b,c,d,a,k[10],23,-1094730640);a=hh(a,b,c,d,k[13],4,681279174);d=hh(d,a,b,c,k[0],11,-358537222);c=hh(c,d,a,b,k[3],16,-722521979);b=hh(b,c,d,a,k[6],23,76029189);a=hh(a,b,c,d,k[9],4,-640364487);d=hh(d,a,b,c,k[12],11,-421815835);c=hh(c,d,a,b,k[15],16,530742520);b=hh(b,c,d,a,k[2],23,-995338651);a=ii(a,b,c,d,k[0],6,-198630844);d=ii(d,a,b,c,k[7],10,1126891415);c=ii(c,d,a,b,k[14],15,-1416354905);b=ii(b,c,d,a,k[5],21,-57434055);a=ii(a,b,c,d,k[12],6,1700485571);d=ii(d,a,b,c,k[3],10,-1894986606);c=ii(c,d,a,b,k[10],15,-1051523);b=ii(b,c,d,a,k[1],21,-2054922799);a=ii(a,b,c,d,k[8],6,1873313359);d=ii(d,a,b,c,k[15],10,-30611744);c=ii(c,d,a,b,k[6],15,-1560198380);b=ii(b,c,d,a,k[13],21,1309151649);a=ii(a,b,c,d,k[4],6,-145523070);d=ii(d,a,b,c,k[11],10,-1120210379);c=ii(c,d,a,b,k[2],15,718787259);b=ii(b,c,d,a,k[9],21,-343485551);x[0]=add32(a,x[0]);x[1]=add32(b,x[1]);x[2]=add32(c,x[2]);x[3]=add32(d,x[3]);}function cmn(q,a,b,x,s,t){a=add32(add32(a,q),add32(x,t));return add32((a<<s)|(a>>>(32-s)),b);}function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}function add32(a,b){return(a+b)&0xFFFFFFFF;}function md5blk(s){var md5blks=[],i;for(i=0;i<64;i+=4){md5blks[i>>2]=s.charCodeAt(i)+(s.charCodeAt(i+1)<<8)+(s.charCodeAt(i+2)<<16)+(s.charCodeAt(i+3)<<24);}return md5blks;}var n=string.length,state=[1732584193,-271733879,-1732584194,271733878],i;for(i=64;i<=n;i+=64){md5cycle(state,md5blk(string.substring(i-64,i)));}string=string.substring(i-64);var tail=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(i=0;i<string.length;i++)tail[i>>2]|=string.charCodeAt(i)<<((i%4)<<3);tail[i>>2]|=0x80<<((i%4)<<3);if(i>55){md5cycle(state,tail);tail=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];}tail[14]=n*8;md5cycle(state,tail);var hex='';for(i=0;i<4;i++)for(var j=0;j<4;j++)hex+=('0'+((state[i]>>(j*8))&255).toString(16)).slice(-2);return hex;}
