#!/usr/bin/env python3
"""Pull custom (DZ/POD/DS26) inventory from JST covering 180 days (26×7d segments),
supplement with pics/created fromsku/query, salesperson from飞鸽, output custom_inventory.json."""

import json, hashlib, time, requests, os, sys, re
from datetime import datetime, timedelta
from collections import defaultdict

CFG = json.load(open(os.path.expanduser("~/.openclaw/workspace/scripts/jst_config.json")))
REPO = "/tmp/defect-collect"
PREFIXES = ("DZ", "POD", "DS26")
FEIGE_BASE = "https://feige.inflation.com.cn/admin_api/v1"
FEIGE_TOKEN = "Bearer bG9naW5fdG9rZW46aW5mbGF0aW9uX2JyYW5kX2NvOjE4NDkyMTg3MjA3NTI6Nzg4OQ"
API_DELAY = 1.5# seconds between API calls to avoid rate limit

def jst_sign(params, app_secret):
    sorted_keys = sorted(params.keys())
    sign_str = app_secret
    for k in sorted_keys:
        if k != 'sign' and params[k]:
            sign_str += k + str(params[k])
    return hashlib.md5(sign_str.encode('utf-8')).hexdigest()

def jst_call(api_path, biz_params, retries=5):
    last_err = None
    for attempt in range(retries):
        ts = str(int(time.time()))
        biz = json.dumps(biz_params)
        params = {'app_key': CFG['app_key'], 'access_token': CFG['access_token'],
                  'timestamp': ts, 'charset': 'utf-8', 'version': '2', 'biz': biz}
        params['sign'] = jst_sign(params, CFG['app_secret'])
        try:
            r = requests.post(f"{CFG['base_url']}{api_path}", data=params, timeout=60)
            j = r.json()
        except Exception as e:
            print(f"  Request error (attempt {attempt+1}): {e}", flush=True)
            time.sleep(5 * (attempt + 1))
            last_err = str(e)
            continue
        if j.get('code') == 200:  # rate limit
            wait = 10 * (attempt + 1)
            print(f"  Rate limited! Waiting {wait}s... (attempt {attempt+1}/{retries})", flush=True)
            time.sleep(wait)
            continue
        return j
    return {'code': -1, 'msg': f'Failed after {retries} retries: {last_err or "rate limited"}'}

# ═══════════════════════════════════════════
# Step 1: Pull inventory for 180 days (26 × 7d)
# ═══════════════════════════════════════════
print("=" * 60, flush=True)
print("Step 1: Pulling inventory (180 days, 26 segments)", flush=True)
print("=" * 60, flush=True)

now = datetime.now()
all_invs = {}# sku_id → inv record

for seg in range(26):
    seg_end = now - timedelta(days=7* seg)
    seg_start = seg_end - timedelta(days=7)
    page = 1
    seg_count = 0
    while page <= 200:
        r = jst_call('/open/inventory/query', {
            'modified_begin': seg_start.strftime('%Y-%m-%d %H:%M:%S'),
            'modified_end': seg_end.strftime('%Y-%m-%d %H:%M:%S'),
            'page_index': page, 'page_size': 50,
        })
        if r.get('code') != 0:
            print(f"  Seg{seg} p{page} err: code={r.get('code')} {r.get('msg','')[:80]}", flush=True)
            break
        invs = r['data'].get('inventorys', [])
        if not invs:
            break
        for inv in invs:
            i_id = inv.get('i_id') or ''
            if not any(i_id.startswith(p) for p in PREFIXES):
                continue
            sku_id = inv.get('sku_id', '')
            qty = inv.get('qty', 0)
            if qty <= 0 and sku_id not in all_invs:
                continue
            existing = all_invs.get(sku_id)
            if existing:
                if (inv.get('modified', '') or '') > (existing.get('_modified', '') or ''):
                    inv['_modified'] = inv.get('modified', '')
                    all_invs[sku_id] = inv
            else:
                inv['_modified'] = inv.get('modified', '')
                all_invs[sku_id] = inv
            seg_count += 1
        has_next = r['data'].get('has_next', False)
        if not has_next:
            break
        page += 1
        time.sleep(API_DELAY)
    print(f"  Seg {seg:2d}: {seg_start.strftime('%m/%d')}-{seg_end.strftime('%m/%d')} → +{seg_count} custom (cumulative unique: {len(all_invs)})", flush=True)
    time.sleep(API_DELAY)

print(f"\nTotal custom SKUs from inventory: {len(all_invs)}", flush=True)

# ═══════════════════════════════════════════
# Step 2: Group by i_id (style)
# ═══════════════════════════════════════════
print("\nStep 2: Grouping by style (i_id)", flush=True)
styles_map = defaultdict(list)
for sku_id, inv in all_invs.items():
    i_id = inv.get('i_id') or ''
    styles_map[i_id].append(inv)
print(f"Unique styles: {len(styles_map)}", flush=True)

# ═══════════════════════════════════════════
# Step 3: Get pic + created from sku/query
# ═══════════════════════════════════════════
print("\nStep 3: Fetching item pics and created dates from sku/query", flush=True)

cache_path = os.path.join(REPO, 'custom_sku_cache.json')
sku_cache = {}
if os.path.exists(cache_path):
    sku_cache = json.load(open(cache_path))

i_ids_need = [iid for iid in styles_map if iid not in sku_cache]
print(f"  Need to query: {len(i_ids_need)} styles (cached: {len(sku_cache)})", flush=True)

for idx, iid in enumerate(i_ids_need):
    page = 1
    while page <= 5:
        r = jst_call('/open/sku/query', {'i_id': iid, 'page_index': page, 'page_size': 50})
        if r.get('code') != 0:
            print(f"  sku/query err for {iid}: {r.get('msg','')[:60]}", flush=True)
            break
        datas = r['data'].get('datas', [])
        if not datas:
            break
        for d in datas:
            item_iid = d.get('i_id', '')
            if item_iid == iid and item_iid not in sku_cache:
                sku_cache[item_iid] = {
                    'pic': d.get('pic', ''),
                    'name': d.get('name', ''),
                    'created': d.get('created', ''),
                    'labels': d.get('labels', ''),
                }
            for sk in d.get('skus', []):
                sid = sk.get('sku_id', '')
                if sid in all_invs:
                    pv = sk.get('properties_value', '')
                    if pv:
                        parts = pv.split(';')
                        all_invs[sid]['_color'] = parts[0] if parts else ''
                        all_invs[sid]['_size'] = parts[1] if len(parts) > 1 else ''
        if not r['data'].get('has_next', False):
            break
        page += 1
        time.sleep(API_DELAY)
    time.sleep(API_DELAY)
    if (idx + 1) % 20 == 0:
        print(f"  Queried {idx+1}/{len(i_ids_need)} styles", flush=True)
        # Save intermediate cache
        with open(cache_path, 'w') as f:
            json.dump(sku_cache, f, ensure_ascii=False, indent=2)

with open(cache_path, 'w') as f:
    json.dump(sku_cache, f, ensure_ascii=False, indent=2)
print(f"  Cache now has {len(sku_cache)} styles", flush=True)

# ═══════════════════════════════════════════
# Step 4: Fetch salesperson from 飞鸽 orders
# ═══════════════════════════════════════════
print("\nStep 4: Fetching salesperson from 飞鸽", flush=True)

feige_path = os.path.join(REPO, 'feige_sales_map.json')
feige_map = {}
if os.path.exists(feige_path):
    feige_map = json.load(open(feige_path))
print(f"  Existing feige map: {len(feige_map)} entries", flush=True)

headers = {"Authorization": FEIGE_TOKEN, "Content-Type": "application/json"}
feige_new = 0
page = 1
max_pages = 100

while page <= max_pages:
    try:
        resp = requests.get(
            f"{FEIGE_BASE}/orders",
            headers=headers,
            params={"page": page, "per_page": 50, "order_type": "custom"},
            timeout=30
        )
        if resp.status_code == 401:
            print("  飞鸽 auth expired, skipping", flush=True)
            break
        if resp.status_code != 200:
            print(f"  飞鸽 HTTP {resp.status_code}, stop at page {page}", flush=True)
            break
        data = resp.json()
        orders = data.get('data', data.get('orders', []))
        if isinstance(data.get('data'), dict):
            orders = data['data'].get('list', data['data'].get('orders', []))
        if not orders:
            break
        for order in orders:
            order_no = order.get('order_no', order.get('number', order.get('id', '')))
            creator = order.get('creator', {})
            if isinstance(creator, dict):
                salesperson = creator.get('profile', {}).get('name', '') or creator.get('name', '') or creator.get('nickname', '')
            else:
                salesperson = order.get('salesperson', order.get('creator_name', ''))
            team = order.get('team', {})
            team_name = team.get('name', '') if isinstance(team, dict) else ''
            if order_no and salesperson:
                if str(order_no) not in feige_map:
                    feige_new += 1
                feige_map[str(order_no)] = {'name': salesperson, 'team': team_name}
        total = data.get('total', data.get('meta', {}).get('total', 0))
        if isinstance(data.get('data'), dict):
            total = data['data'].get('total', 0)
        if total > 0 and page * 50 >= total:
            break
        page += 1
        time.sleep(0.5)
    except Exception as e:
        print(f"  飞鸽 error page {page}: {e}", flush=True)
        break

print(f"  飞鸽 orders: +{feige_new} new, total {len(feige_map)} entries", flush=True)
with open(feige_path, 'w') as f:
    json.dump(feige_map, f, ensure_ascii=False, indent=2)

# ═══════════════════════════════════════════
# Step 5: Assemble custom_inventory.json
# ═══════════════════════════════════════════
print("\nStep 5: Assembling custom_inventory.json", flush=True)

wh_names = {}
try:
    r = jst_call('/open/warehouse/query', {'page_index': 1, 'page_size': 50})
    if r.get('code') == 0:
        for wh in r['data'].get('datas', []):
            wh_names[str(wh.get('wms_co_id', ''))] = wh.get('warehouse_name', '')
except:
    pass

warehouses = []
for wid, wname in wh_names.items():
    warehouses.append({
        'wms_co_id': int(wid) if wid.isdigit() else wid,
        'name': wname,
        'is_main': '捷展' in wname
    })

styles = []
total_qty = 0
total_lock = 0
total_skus = 0

for i_id in sorted(styles_map.keys()):
    inv_list = styles_map[i_id]
    cache_info = sku_cache.get(i_id, {})

    # Find salesperson from feige map
    salesperson = ''
    for key, val in feige_map.items():
        # Match: key starts with i_id, or i_id is contained in key
        if key.startswith(i_id) or i_id in key:
            salesperson = val.get('name', '')
            if salesperson:
                break
    if not salesperson and i_id in feige_map:
        salesperson = feige_map[i_id].get('name', '')

    skus = []
    style_qty = 0
    style_lock = 0
    wh_set = set()

    for inv in inv_list:
        sku_id = inv.get('sku_id', '')
        qty = inv.get('qty', 0)
        lock = inv.get('order_lock', 0)
        avail = qty - lock
        color = inv.get('_color', '')
        size = inv.get('_size', '')
        wh_id = str(inv.get('wms_co_id', ''))
        wh_name = wh_names.get(wh_id, wh_id)
        wh_detail = {}
        if qty > 0:
            wh_detail[wh_name] = qty
            wh_set.add(wh_name)
        bins = []
        if inv.get('bin', ''):
            bins.append(inv['bin'])
        io_date = inv.get('io_date', '') or ''

        skus.append({
            'sku_id': sku_id,
            'color': color,
            'size': size,
            'qty': qty,
            'avail_qty': avail,
            'order_lock': lock,
            'io_date': io_date,
            'wh_detail': wh_detail,
            'bins': bins,
        })
        style_qty += qty
        style_lock += lock
        total_skus += 1

    total_qty += style_qty
    total_lock += style_lock

    created = cache_info.get('created', '')
    age_days = 0
    if created:
        try:
            cd = datetime.strptime(created[:19], '%Y-%m-%d %H:%M:%S')
            age_days = (now - cd).days
        except:
            pass

    styles.append({
        'i_id': i_id,
        'name': cache_info.get('name', ''),
        'labels': cache_info.get('labels', ''),
        'pic': cache_info.get('pic') or None,
        'salesperson': salesperson,
        'io_date': '',
        'created': created,
        'warehouse': list(wh_set) if wh_set else [''],
        'age_days': age_days,
        'total_qty': style_qty,
        'total_lock': style_lock,
        'skus': skus,
    })

styles.sort(key=lambda x: x['i_id'])

result = {
    'updated_at': now.strftime('%Y-%m-%d %H:%M:%S'),
    'total_styles': len(styles),
    'total_skus': total_skus,
    'total_qty': total_qty,
    'total_lock': total_lock,
    'warehouses': warehouses,
    'styles': styles,
}

out_path = os.path.join(REPO, 'custom_inventory.json')
with open(out_path, 'w') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"\n{'='*60}", flush=True)
print(f"✅ custom_inventory.json updated!", flush=True)
print(f"  Styles: {len(styles)}", flush=True)
print(f"  SKUs: {total_skus}", flush=True)
print(f"  Total qty: {total_qty}", flush=True)
print(f"  Total lock: {total_lock}", flush=True)
print(f"  With salesperson: {sum(1 for s in styles if s['salesperson'])}", flush=True)
print(f"  With pic: {sum(1 for s in styles if s.get('pic'))}", flush=True)
print(f"{'='*60}", flush=True)
