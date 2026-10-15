# BUFF163 市场接口 —— 实测记录

本文件记录的都是**本机实测验证过**的行为（HTTP 200 + 实际 JSON），用于支撑
`src/market/buff.mjs` 的实现。踩过的坑都写在里面，改代码前先读这份。

> 传输层注意：本机 `curl.exe` 与 PowerShell `Invoke-WebRequest` **无法**访问 HTTPS
> （`schannel: SEC_E_NO_CREDENTIALS` / `基础连接已经关闭`），必须用 Node 的内置 fetch
> （OpenSSL）。所以所有抓取逻辑都跑在 Node 里。

## 1. 端点一览

| 用途 | 端点 | 登录要求 |
|---|---|---|
| 收藏品目录 | `GET /market/csgo` 的 `#search-itemset` | 目录页面可公开访问 |
| 市场列表/搜索 | `GET /api/market/goods` | **需要登录** |
| 单品挂单（含每笔磨损） | `GET /api/market/goods/sell_order` | 登录后稳定；匿名有配额 |
| 单品详情（拿磨损区间） | `GET /api/market/goods/info` | 登录后稳定；匿名有配额 |
| 求购 | `GET /api/market/goods/buy_order` | 同 sell_order |
| 价格历史 | `GET /api/market/goods/price_history` | 需要登录 |

## 2. 失败表达方式（重要）

buff **不用 HTTP 状态码表达业务错误**，一律 HTTP 200，靠 JSON 里的 `code`：

```
{"code":"OK"}                 正常
{"code":"Login Required","error":"请先登录"}    未登录 / 匿名配额耗尽
{"code":"System Error","error":"访问频率过高, 请稍后重试……"}   限流
{"code":"Invalid Argument","error":"Not a valid choice"}      参数值非法
{"code":"Path Not Found"}     路径错误
```

因此代码里**必须判 `code`，不能判状态码**。`classify()` 就是干这个的。

## 3. 已踩过的具体坑

### 3.1 列表接口不接受 `sort_by=default`

- `/api/market/goods?sort_by=default` → `Invalid Argument / Not a valid choice`
- 不传 `sort_by` → 正常返回
- 传 `sort_by=price.asc` → 正常返回
- 但 `/api/market/goods/sell_order?sort_by=default` → **正常**

所以 `listGoods()` 里只在显式给了非 `default` 值时才带 `sort_by`。

合法的 `sort_by` 值（来自 `goods/info` 的 `sort_by_fields`）：
`default, created.desc, heat.desc, price.asc, price.desc, paintwear.asc, paintwear.desc, sticker.desc, sticker_premium.asc, seller.asc`

### 3.2 列出的可用筛选参数（实测有效）

`rarity`（如 `ancient_weapon` 隐秘、`legendary_weapon` 保密、`mythical_weapon` 受限、
`rare_weapon` 军规、`uncommon_weapon` 工业、`common_weapon` 消费）、
`exterior`（`wearcategory0`~`wearcategory4`）、`quality`（`normal`/`strange`/`unusual`/`unusual_strange`/`tournament`）、
`itemset`（收藏品/箱子，如 `set_community_2`）、`category_group`、`category`、`search`、
`min_price`、`max_price`、`page_num`、`page_size`。

> 注意：`casket` 与 `tab` **不是**列表接口参数（已在 1.33MB 的 `main.js` 里确认 0 次出现）。
> `tab` 只是页面 URL 的 hash，用来决定调哪个端点。

### 3.3 挂单里的精确磨损字段

```
data.items[].asset_info.paintwear   // 字符串，如 "0.35163846611976624"
data.items[].asset_info.assetid
data.items[].asset_info.info.paintseed
data.items[].id                     // 挂单 id
data.items[].price                  // 字符串
data.items[].asset_info.has_tradable_cooldown
data.items[].asset_info.tradable_unfrozen_time
```

`paintwear` 是**字符串**，必须自己 parseFloat（`parseWear()` 里再转 float32）。

### 3.4 单品详情里的磨损区间

```
data.paintwear_range = ["0.15","0.38"]     // 当前外观商品的可用磨损范围
data.containers = ["Operation Phoenix Weapon Case"]
```

该范围属于当前外观商品，不能直接用于炼金归一化。`data.relative_goods` 包含同枪皮的关联外观；只取 `is_change` 为假的同品质商品，按外观顺序查询最前与最后的商品详情，合并其最小值和最大值作为完整枪皮区间。材料归一化与产物映射均使用完整区间，挂单筛选则使用所选外观与完整区间的交集。

### 3.5 收藏品与品质元数据（2026-10-15 实测）

`/market/csgo` 的 `#search-itemset` 中，`h6` 表示分类，`p[value]` 提供收藏品 / 箱子 ID 和中文名称；本次实测读取 92 项。`/api/market/goods?game=csgo&itemset=<id>&quality=normal` 分页列出商品，暗金使用 `quality=strange`。每项的 `goods_info.info.tags` 含 `rarity`、`exterior`、`itemset` 等标签；代码按标签和英文商品身份再过滤，排除箱子、纪念品、刀和手套，合并同枪皮的外观商品。

`src/market/catalog.mjs` 负责目录、分页读取和完整区间核验，缓存到 `data/buff-catalog/catalog.json`，有效期 24 小时。手动刷新会重新抓取；登录失败、元数据不完整或区间核验失败时返回明确错误。

单收藏品投入同品质的 10 把材料时，下一品质的每种枪皮概率相等。完整区间相同的产物，对同组材料映射出的最终磨损相同。页面同时列出完整区间和相同磨损分组。

## 4. 风控

- 请求间隔建议 **≥ 2~3 秒**（`--interval` 默认 3000）。
- 遇到 `System Error` 或 429 要指数退避（`HttpClient` 已内置）。
- **最阴险的一点**：匿名配额耗尽时，`sell_order` 会从 `OK` 悄悄降级成
  `Login Required`（仍 HTTP 200）。所以看到 `Login Required` 不一定是 cookie 失效，
  也可能是被限流了 —— 先等一下再重试。
- 本机实测：匿名额度用完后，连 `goods/info` 都会返回 `Login Required`，
  所以**登录态基本上是必需的**。

## 5. cookies 怎么来

Chrome 155 的 cookie 是 `v20`（App-Bound Encryption），
主密钥 `os_crypt.app_bound_encrypted_key` 被 SYSTEM DPAPI + 用户 DPAPI 双层包裹，
**非管理员解不开**；且沙箱禁止启动 Chrome（`exit 0x6FF9`），
所以 CDP / DLL 注入两条路都走不通。

本项目采用**手工粘贴 Cookie**：`scripts/set-cookies.ps1`。
需要的字段（实测够用）：`session`、`csrf_token`、`Device-Id`、`game`、`remember_me` 等，
直接整行复制 DevTools 里的 `Cookie:` 请求头即可。
