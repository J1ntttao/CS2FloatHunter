# BUFF163 市场接口 —— 实测记录

本文件记录的都是**本机实测验证过**的行为（HTTP 200 + 实际 JSON），用于支撑
`src/market/buff.mjs` 的实现。踩过的坑都写在里面，改代码前先读这份。

> 传输层注意：本机 `curl.exe` 与 PowerShell `Invoke-WebRequest` **无法**访问 HTTPS
> （`schannel: SEC_E_NO_CREDENTIALS` / `基础连接已经关闭`），必须用 Node 的内置 fetch
> （OpenSSL）。所以所有抓取逻辑都跑在 Node 里。

## 1. 端点一览

| 用途 | 端点 | 登录要求 |
|---|---|---|
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
data.paintwear_range = ["0.15","0.38"]     // 字符串数组，决定这件材料能炼出什么
data.containers = ["Operation Phoenix Weapon Case"]
```

炼金的材料筛选必须用它来判断「这件材料的区间能否覆盖目标均值」。

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
