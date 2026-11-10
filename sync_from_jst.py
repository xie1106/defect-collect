#!/usr/bin/env python3
"""从聚水潭API同步最新数据到次品收集系统的JSON文件
1. po_supplier_map.json — 采购单号→供应商名映射
2. return_addr_map_v2.json — 供应商→退货地址映射
3.sku_info_map.json — SKU→[款号, 颜色, 尺码]映射
"""
import json, hashlib, time, requests, os, sys
from datetime import datetime, timedelta
from collections import defaultdict

CFG = json.load(open(os.path.expanduser("~/.openclaw/workspace/scripts/jst_config.json")))
REPO = "/tmp/defect-collect"

def jst_sign(params, app_secret):
    sorted_keys = sorted(params.keys())
    sign_str = app_secret
    for k in sorted_keys:
        if k !='sign' and params[k]:
            sign_str += k + str(params[k])
    return hashlib.md5(sign_str.encode('utf-8')).hexdigest()

def jst_call(api_path, biz_params):
    for attempt in range(3):
        ts = str(int(time.time()))
        biz = json.dumps(biz_params)
        params = {'app_key': CFG['app_key'], 'access_token': CFG['access_token'],
                  'timestamp': ts, 'charset': 'utf-8', 'version': '2', 'biz': biz}
        params['sign'] = jst_sign(params, CFG['app_secret'])
        r = requests.post(f"{CFG['base_url']}{api_path}", data=params, timeout=60)
        j = r.json()
        if j.get('code') == 200:
            time.sleep(3*(attempt+1)); continue
        return j
    return j

#═══════════════════════════════════════
# 1. 供应商信息 → return_addr_map_v2.json
# ═══════════════════════════════════════
print("=== 1. 拉取供应商列表 ===")
supplier_map = {}  # supplier_id → {name, contacts, mobile, address, ...}
page = 1
while page <= 100:
    r = jst_call('/open/supplier/query', {'page_index': page, 'page_size': 50})
    if r.get('code') != 0:
        print(f"  Err: {r.get('msg','')[:60]}")
        break
    items = r['data'].get('datas', [])
    if not items: break
    for s in items:
        sid = str(s.get('supplier_id', ''))
        if not sid: continue
        supplier_map[sid] = {
            'name': s.get('name', ''),
            'contacts': s.get('contacts', ''),
            'mobile': s.get('mobile', ''),
            'phone': s.get('phone', ''),
            'address': s.get('address', ''),
            'enabled': s.get('enabled', False),
        }
    if not r['data'].get('has_next', False): break
    page += 1
    time.sleep(0.2)
print(f"  供应商: {len(supplier_map)} 个")

# 加载现有退货地址（保留手动维护的）
addr_path = os.path.join(REPO, 'return_addr_map_v2.json')
existing_addr = {}
if os.path.exists(addr_path):
    existing_addr = json.load(open(addr_path))

# 用供应商名做key更新地址
for sid, info in supplier_map.items():
    name = info['name']
    if not name: continue
    if name not in existing_addr:
        # 新供应商，从API数据构建
        addr_parts = []
        if info.get('contacts'): addr_parts.append(info['contacts'])
        if info.get('mobile'): addr_parts.append(info['mobile'])
        elif info.get('phone'): addr_parts.append(info['phone'])
        if info.get('address'): addr_parts.append(info['address'])
        if addr_parts:
            existing_addr[name] = '，'.join(addr_parts)

with open(addr_path, 'w') as f:
    json.dump(existing_addr, f, ensure_ascii=False, indent=2)
print(f"  退货地址: {len(existing_addr)} 条")

# ═══════════════════════════════════════
# 2. 采购单→供应商 → po_supplier_map.json
# ═══════════════════════════════════════
print("\n=== 2. 拉取采购单→供应商映射 ===")
# 加载现有映射
po_path = os.path.join(REPO, 'po_supplier_map.json')
po_supplier = {}
if os.path.exists(po_path):
    po_supplier = json.load(open(po_path))
print(f"  已有: {len(po_supplier)} 条")

# 拉最近90天的采购单（增量更新）
now = datetime.now()
new_count = 0
for seg in range(13):  # 13*7=91天
    seg_end = now - timedelta(days=7*seg)
    seg_start = seg_end - timedelta(days=7)
    page = 1
    while page <= 100:
        r = jst_call('/open/purchase/query', {
            'modified_begin': seg_start.strftime('%Y-%m-%d %H:%M:%S'),
            'modified_end': seg_end.strftime('%Y-%m-%d %H:%M:%S'),
            'page_index': page, 'page_size': 50,
        })
        if r.get('code') != 0:
            print(f"  Err p{page}: {r.get('msg','')[:60]}")
            break
        items = r['data'].get('datas', [])
        if not items: break
        for po in items:
            po_id = str(po.get('po_id', ''))
            if not po_id: continue
            supplier_id = str(po.get('supplier_id', ''))
            seller = po.get('seller', '')
            # 用supplier_id找供应商名
            supplier_name = seller
            if supplier_id in supplier_map:
                supplier_name = supplier_map[supplier_id].get('name', seller)
            if po_id not in po_supplier:
                new_count += 1
            po_supplier[po_id] = supplier_name
        if not r['data'].get('has_next', False): break
        page += 1
        time.sleep(0.2)

with open(po_path, 'w') as f:
    json.dump(po_supplier, f, ensure_ascii=False, indent=2)
print(f"  采购单→供应商: {len(po_supplier)} 条 (+{new_count} 新增)")

# ═══════════════════════════════════════
# 3. SKU→款号/颜色/尺码 → sku_info_map.json
# ═══════════════════════════════════════
print("\n=== 3. 更新SKU信息 ===")
sku_path = os.path.join(REPO, 'sku_info_map.json')
sku_info = {}
if os.path.exists(sku_path):
    sku_info = json.load(open(sku_path))
print(f"  已有: {len(sku_info)} SKU")

# 从采购单items和inventory拉取新SKU
# 采购单items有properties_value(颜色;尺码)和i_id(款号)
new_skus = 0
for seg in range(13):
    seg_end = now - timedelta(days=7*seg)
    seg_start = seg_end - timedelta(days=7)
    page = 1
    while page <= 100:
        r = jst_call('/open/purchase/query', {
            'modified_begin': seg_start.strftime('%Y-%m-%d %H:%M:%S'),
            'modified_end': seg_end.strftime('%Y-%m-%d %H:%M:%S'),
            'page_index': page, 'page_size': 50,
        })
        if r.get('code') != 0: break
        items = r['data'].get('datas', [])
        if not items: break
        for po in items:
            for it in (po.get('items') or []):
                sid = it.get('sku_id', '')
                if not sid or sid in sku_info: continue
                i_id = it.get('i_id', '')
                pv = it.get('properties_value', '')
                parts = pv.split(';') if pv else ['', '']
                color = parts[0] if parts else ''
                size = parts[1] if len(parts) > 1 else ''
                if i_id:
                    sku_info[sid] = [i_id, color, size]
                    new_skus += 1
        if not r['data'].get('has_next', False): break
        page += 1
        time.sleep(0.2)

# 也从inventory拉（有i_id和sku_id的映射）
for seg in range(5):
    seg_end = now - timedelta(days=7*seg)
    seg_start = seg_end - timedelta(days=7)
    page = 1
    while page <= 200:
        r = jst_call('/open/inventory/query', {
            'modified_begin': seg_start.strftime('%Y-%m-%d %H:%M:%S'),
            'modified_end': seg_end.strftime('%Y-%m-%d %H:%M:%S'),
            'page_index': page, 'page_size': 50,
        })
        if r.get('code') != 0: break
        invs = r['data'].get('inventorys', [])
        if not invs: break
        for inv in invs:
            sid = inv.get('sku_id', '')
            if not sid or sid in sku_info: continue
            i_id = inv.get('i_id', '')
            if i_id:
                # inventory没有properties_value，从SKU编码推断颜色尺码
                # 通常SKU = 款号 + 颜色代码 + 尺码代码
                rest = sid[len(i_id):] if sid.startswith(i_id) else ''
                # 先留空，后续从出库流水补充
                sku_info[sid] = [i_id, '', '']
                new_skus += 1
        if not r['data'].get('has_next', False): break
        page += 1
        time.sleep(0.2)

# 从出库流水补充颜色尺码（有properties_value）
print(f"  从出库流水补充颜色尺码...")
missing_pv = [sid for sid, v in sku_info.items() if not v[1] and not v[2]]
print(f"  缺颜色尺码: {len(missing_pv)} SKU")

for seg in range(3):  # 21天
    seg_end = now - timedelta(days=7*seg)
    seg_start = seg_end - timedelta(days=7)
    page = 1
    while page <= 200:
        r = jst_call('/open/jushuitan/inout/water/query', {
            'start_time': seg_start.strftime('%Y-%m-%d %H:%M:%S'),
            'end_time': seg_end.strftime('%Y-%m-%d %H:%M:%S'),
            'page_index': page, 'page_size': 50,
        })
        if r.get('code') != 0: break
        datas = r['data'].get('datas', [])
        if not datas: break
        for d in datas:
            for it in d.get('items', []):
                sid = it.get('sku_id', '')
                pv = it.get('properties_value', '')
                if sid in sku_info and pv and not sku_info[sid][1]:
                    parts = pv.split(';')
                    sku_info[sid][1] = parts[0] if parts else ''
                    sku_info[sid][2] = parts[1] if len(parts) > 1 else ''
        if not r['data'].get('has_next', False): break
        page += 1
        time.sleep(0.2)

still_missing = sum(1 for v in sku_info.values() if not v[1])
with open(sku_path, 'w') as f:
    json.dump(sku_info, f, ensure_ascii=False, indent=2)
print(f"  SKU信息: {len(sku_info)} 条 (+{new_skus} 新增, {still_missing} 缺颜色)")

print(f"\n✅ 完成！")
print(f"  po_supplier_map: {len(po_supplier)} 条")
print(f"  return_addr_map: {len(existing_addr)} 条")
print(f"  sku_info_map: {len(sku_info)} 条")
