# backend —— 后台 Worker 部署说明

系统后端由两个 Cloudflare Worker 组成：

| Worker | 作用 | 入口 |
|---|---|---|
| `return-worker` | 实时调用聚水潭 API 创建采购退货单 | `POST /create-return { po_id }` |
| `yto-proxy` | 圆通快递面单 API 代理（散件下单/取号） | `POST { action: "createOrder" | "getWaybillNo", data }` |

## 部署步骤（以 return-worker 为例）

```bash
cd backend/return-worker
npm i -g wrangler        # 安装 wrangler（如已装可跳过）
wrangler login           # 登录 Cloudflare 账号
wrangler secret put JST_APP_SECRET      # 输入聚水潭应用密钥
wrangler secret put JST_ACCESS_TOKEN    # 输入聚水潭授权 access_token
wrangler deploy          # 部署
```

`yto-proxy` 同理：

```bash
cd backend/yto-proxy
wrangler login
wrangler secret put YTO_PARTNER_ID     # 圆通客户ID（如 K200416574）
wrangler secret put YTO_SECRET         # 圆通密钥
wrangler deploy
```

> 已内置 `wrangler.toml` 中的变量：`JST_APP_KEY`、`JST_BASE_URL`、`RETURN_SHOP_ID`、
> `SUPABASE_URL`、`SUPABASE_KEY`、`STYLE_MAP`、`RETURN_ADDR_MAP`（return-worker）；
> `YTO_PARTNER_ID`、`YTO_SECRET`（yto-proxy）。
> ⚠️ 出于安全考虑，`JST_APP_SECRET` / `JST_ACCESS_TOKEN` 请务必用 `wrangler secret` 设置，
> 不要写进 `wrangler.toml` 或提交到代码仓库。

## return-worker 工作流程（POST /create-return）

1. 从 Supabase 取该采购单的待处理记录（过滤掉 1688 标签记录，见 README 待确认项①）
2. 取供应商：优先聚水潭 `/open/purchase/query`；失败则从记录 note 提取款号，再用 `STYLE_MAP` 匹配
3. 取退货地址：优先聚水潭 `/open/supplier/query`，其次 `RETURN_ADDR_MAP`
4. 汇总 SKU 数量 → 调用聚水潭 `/open/jushuitan/orders/upload` 创建退货单（shop_id=21571486）
5. 成功 → 给记录打 `[退货:已下单:内部单号]` 标签

## 聚水潭开放平台准备

- 在聚水潭开放平台（open.jushuitan.com）申请应用，获取 `app_key` / `app_secret`
- 授权获取 `access_token`
- 接口地址：`https://openapi.jushuitan.com`

## 商品资料同步（聚水潭 → 次品系统）

以聚水潭资料为准，把商品颜色/码数、供应商、退货地址同步成前端映射文件：

| 生成文件 | 内容 | 数据源 |
|---|---|---|
| `sku_info_map.json` | SKU → [款号, 颜色, 码数] | `/open/sku/query`（`properties_value` 解析颜色/码数） |
| `return_style_map.json` | 款号 → 供应商名称 | `/open/sku/query` 的 `supplier_id` + `/open/supplier/query` 的名称 |
| `return_addr_map.json` | 供应商 → 退货地址/手机/联系人 | `/open/supplier/query` |

运行方式（Windows PowerShell）：

```powershell
$env:JST_APP_KEY="你的app_key"
$env:JST_APP_SECRET="你的app_secret"
$env:JST_ACCESS_TOKEN="你的access_token"
node sync-jst-maps.js  ..```

> - 不带时间参数 = 全量同步；如只需增量，加 `$env:JST_MODIFIED_BEGIN` / `$env:JST_MODIFIED_END`（格式 `YYYY-MM-DD HH:mm:ss`，间隔≤7天）
> - 生成的 3 个 json 会写到网页同层目录（覆盖同名文件），提交到仓库后前端即可用最新资料
> - 建议：每天定时跑一次（如 Windows 计划任务），保持资料最新
