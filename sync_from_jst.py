#!/usr/bin/env python3
"""从聚水潭API拉取最新供应商、退货地址、SKU数据，更新GitHub Pages JSON文件"""
import json, hashlib, time, requests, sys, os

# ── 聚水潭配置 ──
CFG = json.load(open(os.path.expanduser("~/.openclaw/workspace/scripts/jst_config.json")))
BASE = CFG["base_url"]
APP_KEY = CFG["app_key"]
APP_SECRET = CFG["app_secret"]
TOKEN = CFG["access_token"]

def jst_sign(api, biz_params):
    ts = str(int(time.time()))
    params = {"app_key": APP_KEY, "access_token": TOKEN, "timestamp": ts, "charset": "utf-8", "version": "2"}
    params.update(biz_params)
    sign_str = APP_SECRET + "".join(f"{k}{params[k]}" for k in sorted(params)) + APP_SECRET
    params["sign"] = hashlib.md5(sign_str.encode()).hexdigest().upper()
    return params

def jst_post(api, biz=None):
    if biz is None: biz = {}
    url = BASE + api
    params = jst_sign(api, biz)
    r = requests.post(url, data=params, timeout=60)
    r.raise_for_status()
    return r.json()

# ── 1. 拉取供应商列表 (wms_partner) → return_style_map + po_supplier_map ──
# PLACEHOLDER_PART2
