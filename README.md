# CS2 目标磨损炼金助手

两种用法：

1. **网页版（推荐）**：粘贴配方链接确定收藏品 → 输入你想要的产物磨损 → 搜出能打出这个磨损的 10 把皮肤
2. **命令行版**：直接给目标磨损值 + 产物区间，在全市场里凑出 10 把材料

---

## 网页版

**一键启动**：双击根目录的 `start.bat`。它会检查 Node.js 版本和 BUFF 登录态，启动服务后自动打开浏览器；
服务已经在运行时直接打开页面。端口可用环境变量 `CS2_WEB_PORT` 修改（默认 8788）。

手动启动：

```powershell
node src\web\server.mjs
# 浏览器打开 http://127.0.0.1:8788
```

用户只需要做两件事：

1. **粘贴 CS2UP 配方广场的分享链接**，例如 `https://cs2up.cn/share.html?sid=7928752d714f8e31`
   （也可以只贴 `sid` 本身）
2. **输入想要的产物磨损值**，例如 `0.2`

点「开始搜索 10 把材料」，页面实时显示进度，最后给出**若干组配方**，
每组 10 把材料都带：皮肤名、精确磨损（float32）、归一化值、价格、以及**购买 / 检视链接**。

> 链接**只用来定位**「哪个收藏品、哪一档材料」（例如「创世纪收藏品 · 受限级」），
> **目标磨损完全由你决定**，不必和链接里那个配方相同。

### 它做了什么

1. 调 CS2UP 的 `GET /api/share-payloads?id=<sid>` 拿配方（实测见 `ref/cs2up/share.js:91`）
2. **定位收藏品**：CS2UP 给的是英文名（`The Genesis Collection`），本地材料库是中文（`创世纪收藏品`），
   直接比名字对不上。所以用配方里那些**皮肤的中文名**去本地库反查它们属于哪个收藏品，
   再用材料档位投票选出唯一答案（`inferCollection`）
3. 从本地材料库列出该收藏品该档位的**全部皮肤**（实测该档 5 个：双持贝瑞塔/天矢之眼、M4A1消音版/液化、MAC-10/纸老虎、新星/目镜、UMP-45/连续体）
4. 逐个用 BUFF 搜索解析成 `goods_id`，取各自的磨损区间
5. **按区间分档，只保留能覆盖目标磨损的那些**（同一个皮肤有 FN/MW/FT/WW/BS 多个商品，
   例如目标是 0.2 时只有 `[0.15, 0.38]` 这一个档位可用，其余 4 档会被明确跳过并显示出来）
6. 抓取「目标磨损 ± 搜索半径」内的真实挂单，在归一化空间里**精确求解** 10 把
7. 输出多组配方，标注是否 **★ 精确命中**、产物磨损、材料总价

### 关键数学

同一收藏品内所有皮肤的磨损区间相同，所以

```
产物磨损 = 平均(材料磨损) × (产物max − 产物min) + 产物min
→ 因为 产物区间 == 材料区间，所以「想要的产物磨损」就等于「材料的平均磨损」
```

这也解释了为什么 CS2UP 的配方里 `expected_wear` 恰好等于材料的加权平均磨损。

### 页面参数

| 参数 | 说明 |
|---|---|
| **① 配方链接** | 必填，用来定位收藏品与材料档位 |
| **② 想要的产物磨损值** | 必填。0~1 之间的小数 |
| **③ 检索范围** | `仅 BUFF` / `BUFF + Steam 比价` / `仅 Steam` |
| **磨损搜索半径** | 在算出的材料目标磨损上下各搜多大范围（默认 0.03）。调大更容易凑齐，但抓取更慢 |
| **请求间隔** | 每次请求 BUFF 的间隔（默认 2200ms）。**buff 风控严，不建议调小** |
| **代理** | 可选，形如 `http://127.0.0.1:7897`。留空则读环境变量 / 自动探测本地常见代理端口 |
| **放宽 Steam 证书校验** | 本机有 SteamTools 等中间人代理时需勾选（默认勾选） |

### 三个市场的真实能力（全部实测）

| 能力 | BUFF | Steam |
|---|---|---|
| 逐笔挂单的**精确磨损 (float)** | ✅ `asset_info.paintwear` | ⚠️ 需从挂单页解检视链接（解码器已完成） |
| 按磨损区间服务端过滤 | ✅ `min/max_paintwear` | ❌ |
| 单品最低价（人民币） | ✅ | ✅ `priceoverview` |
| 市场搜索 / 排序 / 分页 | ✅ | ✅ `search/render`（价格是美元） |
| 需要登录 | ✅ 必须 | ❌ 匿名可读（但要能访问） |

### 检索范围三档的真实行为

| 选项 | 求解用什么数据 | 说明 |
|---|---|---|
| **仅 BUFF** | BUFF 挂单 | 唯一稳定可用的精确求解模式 |
| **BUFF + Steam 比价** | BUFF 挂单 | Steam 用于逐笔磨损比对与「哪边便宜」；结果标注 `dataSource: buff` |
| **仅 Steam** | **Steam 挂单**（无 BUFF 兜底） | Steam 取不到就**直接报错**，不会偷偷换成 BUFF 数据 |

> ⚠️ **曾经的一个严重 bug**：早期版本无论选哪一档，求解**始终用 BUFF 挂单**，
> `market` 参数只影响"要不要附带 Steam 价格"。也就是说选「仅 Steam」时，
> 页面上的磨损值、价格、购买链接**全部来自 BUFF**，却让人以为是 Steam 的。
> 现已改为真正的 Steam 求解路径（`CollectionHunter.huntFromSteam`），
> 并在结果里显式标注数据来源（`dataSource` + `dataSourceNote` + 配方卡徽章）。

Steam 求解路径的本质差异：

- 磨损不是"挂单字段"，而是**解码检视链接**得到的 → 只有能解出 float 的挂单才可用
- Steam 挂单页按**价格**排序，未登录只能看有限几页 → 某些商品可能根本没有落在目标区间内的挂单
- 因此该模式**不保证凑得齐**，凑不齐时如实报 `not_enough_steam`，并列出每个商品的情况

### 代理相关（实测）

- 本地 `7890` 端口**无监听**（填了会 `ECONNREFUSED`）
- 本地 `7897` 端口是 **SteamTools 的拦截器**，不是通用代理：能建 TCP 连接，
  但 HTTP `CONNECT` 会 TLS 握手中断、SOCKS5 握手超时
- 页面留空代理时会自动探测并提示，但**探测到的端口不一定可用**，以实际测试为准

---

## 代理与 TLS

Steam 需要代理；且本机若装了 SteamTools 之类中间人工具，证书由其签发
（实测签发者为 `SteamTools Certificate`），Node 默认校验会报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。

处理方式（`src/util/net.mjs`，**零依赖**，用 `node:net`/`node:tls` 自己实现隧道）：

- 代理类型：**HTTP CONNECT** 与 **SOCKS5**（含用户名/密码认证、远程 DNS），
  也支持 `socks5h://`、`socks4://`；不写前缀按 `http` 处理
- 代理优先级：**页面显式指定 > 环境变量 `HTTPS_PROXY`/`ALL_PROXY` > 自动探测本地端口 > 直连**
- 自动探测依次试 `7897, 7890, 7891, 10809, 10808, 1080, 8080, 8888, 3128, 8118, 20171`
- TLS：默认严格校验；勾选「放宽证书校验」后仅放宽；也支持用 `caFile` 指定自定义根证书
- 所有代理握手都有硬性超时兜底，任何一步卡住都会报错而不会永久挂起

> 为什么不直接用 Node 内置 fetch：它不支持 `dispatcher` 指定代理
> （实测 `import('undici')` 也不可用），且不会读 `HTTP_PROXY`。

---

## Steam 逐笔磨损：已打通（附实测结论）

### 关键发现：新版页面直接给 float，不需要解密也不需要外部服务

Steam 挂单页已经**改版成 React/SSR**，旧版的全局变量 `g_rgListingInfo` **彻底没了**
（实测出现 0 次），任何基于它的解析都会失败。新版把数据注水在：

```html
<script type="application/json" id="valve-ssr-data"> {route, loaderData, ...} </script>
```

数据被**多层 JSON 字符串嵌套**（`loaderData` 是字符串数组，里面还是 JSON 字符串），
需要递归下降解析才能拿到 `listings`。每笔挂单的关键字段：

| 字段 | 含义 |
|---|---|
| `listingid` | 挂单 id，用来拼直接购买链接 `?listing=<id>` |
| `unPrice` / `unFee` | 价格（分）；`strSubtotal` 是显示价，如 `"¥0.55"` |
| `asset.asset_properties[propertyid=1].int_value` | paintseed |
| **`asset.asset_properties[propertyid=2].float_value`** | **精确磨损，直接就是 float** |
| `asset.asset_properties[propertyid=6].string_value` | 加密串，**不是 protobuf，别去解** |

也就是说：**读取挂单页即可拿到每一笔的 float**，不需要 CSGOFloat、不需要 bot、不需要登录。

### 两个必须用英文名的坑

- Steam 的 URL 段必须是 **`market_hash_name`（英文名）**，例如
  `Dual Berettas | Angel Eyes (Field-Tested)`。
  用中文名拼 `/market/listings/730/双持贝瑞塔...` 会拿到**不含挂单数据的空壳**
  （表现为 `no_listings_in_ssr`），而且**有时会"碰巧"重定向成功**，非常难查。
- 翻页参数实测 **`?start=20` 有效**；`?cursor=` / `?page=` 会被忽略。每页固定 20 笔。

### 实测数据（节流 6 秒/请求）

| 商品 | 挂单 | 有 float | 磨损范围 |
|---|---|---|---|
| Dual Berettas \| Angel Eyes (FT) | 80（4 页） | 80 | 0.4006 ~ 0.9849 |
| M4A1-S \| Liquidation (FT) | 79 | 79 | 0.6449 ~ 0.9911 |
| MAC-10 \| Cat Fight (FT) | 72 | 72 | 0.4071 ~ 0.9880 |
| Nova \| Ocular (FT) | 80 | 80 | 0.3943 ~ 0.9903 |
| UMP-45 \| Continuum (FT) | 79 | 79 | 0.3974 ~ 0.9232 |

**390 笔挂单，390 笔都解出了 float。**

### 但「仅 Steam」仍然很难凑齐配方 —— 这是 Steam 侧的固有限制

上面那张表暴露了关键问题：**`.Fi` 后缀不代表 float 就落在 [0.15, 0.38] 里**，
实测这 5 个「久经沙场」商品的挂单磨损全在 **0.39 ~ 0.99**，目标区间 [0.15, 0.38] 内 **0 笔**。

原因是 Steam 的 `?start=` 是**按价格升序**排的，最便宜的挂单恰好都是战痕累累/破损不堪。
你想要的窄磨损区间里的挂单，在很后面的页里。

由此得出：

| 结论 | 说明 |
|---|---|
| Steam **不能按磨损检索** | 没有可用的服务端磨损过滤参数，只能一页页扫 |
| 扫描深度 = 成本 | 每页 20 笔，要跨过大量不适用的挂单才可能命中目标区间 |
| 限流很紧 | 连续请求会返回 **HTTP 500**（实测），必须节流到数秒/请求并退避 |
| 因此 | **「仅 Steam」适合验证/比价，不适合当主求解来源**；稳定可用的是「仅 BUFF」 |

服务端会把「限流」和「取不到」**分开报错**（`steam_rate_limited` vs `steam_unreachable`），
不再一律归咎于代理。

---

目标是像 CSGOFloat 那样，在 Steam 挂单页显示每一笔的精确 float。**解码这一环已经做完并测通**，
唯一缺的是能打开 Steam 挂单页。

## 成本优化（重要）

第一版按 **磨损升序** 取前 60 笔挂单，拿到的全是「磨损最贴近但未必便宜」的货，成本很高。

现在改成按 **价格升序** 抓取（`sort_by=price.asc`），磨损是否合适完全交给
「区间过滤 + 求解器」保证。实测同一目标（0.2）：

| | 材料总价 |
|---|---|
| 改之前（按磨损排序） | ¥90.31 |
| 改之后（按价格排序） | **¥72.30** |
| 再用 Steam 挑便宜的一边 | **¥62.31** |

另有一道**同款等价挂单替换**：同一商品里磨损几乎相同（差 < 1e-6）的挂单自动挑最便宜的，
页面会显示「替换了几处、省下多少钱」。

---

### 接口

| 端点 | 说明 |
|---|---|
| `GET /` | 页面 |
| `GET /api/health` | 健康检查 + 登录态状态 |
| `GET /api/hunt?url=&wear=&band=&interval=&market=buff|steam|both&proxy=&insecure=` | **主流程**，SSE 流式返回 `stage`/`located`/`progress`/`result`/`done`/`error` |
| `GET /api/steam-health` | Steam 连通性自检（含代理与证书状态） |
| `POST /api/cookies` | 提交 BUFF / Steam 登录态与 CSFloat 令牌，**保存并立即验证**，返回验证结论 |
| `GET /api/collections` | 列出本地材料库里的所有收藏品 |
| `GET /api/resolve?url=&band=&interval=` | 旧流程：照抄配方里每把材料的目标磨损去找最接近的挂单 |

### 实测（配方链接 + 目标磨损 0.2）

```
已定位：创世纪收藏品 / 受限级 / 5 个皮肤
共 5 种磨损区间档：[0.45,1]×5 [0,0.07]×5 [0.15,0.38]×5 [0.38,0.45]×5 [0.07,0.15]×5
目标产物磨损 0.2 → 需要材料平均磨损 ≈ 0.200000
跳过 4 个档位（区间不覆盖目标）：[0.45,1] [0,0.07] [0.38,0.45] [0.07,0.15]
候选池 282 笔 → ★ 精确命中  产物磨损 = 0.20000000298023224  总价 ¥78.35
```

注意 `0.2` 在 IEEE754 单精度下**不存在**，会被吸附到 `0.20000000298023224` —— 页面会明确提示这一点。

---

## 命令行版：按目标磨损凑配方

```
node src/cli.mjs --target 0.1512345 --out-min 0.10 --out-max 0.70
```

---

## 通用说明

## 它到底做了什么

> **计算引擎不是我自己推的公式，而是 [西林磨损计算器](https://68688888.github.io/) 的官方算法。**
> 源码（`script.js`）已抓到 `ref/` 下，我的实现与它**逐位对齐**，
> 由 `tests/test-vs-site.mjs` 把站点源码直接跑在 Node 里做差分对照（46,000 组随机用例，零偏差）。

1. **IEEE754 校验**：先判断你输入的目标磨损在 float32 下是否真实存在。
   CS2 内部用单精度浮点，很多“特殊磨损”（如 `0.06666666`）在单精度下**根本无法表示**，
   会被吸附到最近的可表示值。工具会告诉你实际会得到哪个值。
2. **按材料各自区间归一化**（关键，站点 `Utils.normalizeWearForCalculation`）：

   ```
   normalized = float32( (材料磨损 − 材料min) / (材料max − 材料min) )   再 clamp 到 [0,1]
   ```

   **每把材料要用它自己的磨损区间归一化**，不能直接平均原始磨损 ——
   不同收藏品的材料区间不同，只有区间完全一致时两者才等价。
3. **算产物磨损**（站点主流程）：

   ```
   normalizedSum = float32(normalizedSum + normalized)     // 逐项单精度累加
   avgNormalized = float32(normalizedSum / float32(材料数))
   产物磨损       = float32(产物min + float32(avgNormalized × float32(产物max − 产物min)))
   ```
4. **抓真实挂单**：搜索同档材料 → 拉取每件材料的磨损区间 → 只抓磨损落在可行带内的挂单，
   每笔都带**平台提供的精确磨损**（buff 是 `asset_info.paintwear`，悠悠是 `Abrade`）。
5. **精确求解**：在归一化空间里找 10 笔不同的挂单，使其产物磨损精确命中目标。
   先用「随机重启 + 局部搜索 + 2 换 2 抛光」；若未命中且候选数够小（≤ 几十个），
   再用**相遇中点（meet-in-the-middle）做确定性精确求解**。
6. **输出**：控制台账单（**每笔都带购买链接**）+ JSON + 自包含可视化 HTML。

### 单收藏品 vs 混收藏品

| | 单收藏品（默认） | 混收藏品（`--mix`） |
|---|---|---|
| 材料来源 | 同一批同档材料 | 可来自多个收藏品 |
| 产物 | **确定**：唯一的那个高一档产物 | **概率分布**：按材料数量加权随机出 |
| 适用 | 想锁定产物 | 只想要某个磨损值，能接受多种产物 |

混收藏品的概率：投入某收藏品 N 把 / 共 10 把，就有 N/10 的概率出该收藏品的产物。
网页会为每组配方列出每个产物的**收藏品、投入把数、概率、产物磨损**。

> 注意：混收藏品让可选材料变多，**更容易凑出精确磨损**，但也更容易挑到贵的材料。
> 先用默认单收藏品模式看看，不够再开 `--mix`。

---

## 快速开始

### 0. 环境
- Node.js **≥ 22.5**（用到内置 `node:sqlite`；实测 v24 正常）
- Windows + Chrome（仅用于你手动取 Cookie / Token）

### 1. 录入 BUFF 登录态（必需）

BUFF 的搜索接口必须登录（不登录返回 `{"code":"Login Required"}`），所以这步不能省。

在 Chrome 里打开 `buff.163.com` → `F12` → `Network` → 刷新页面 → 点任意请求
→ **Request Headers → 复制 `Cookie:` 那一整行的值**，然后：

```powershell
powershell -File scripts\set-cookies.ps1 -Site buff
```

脚本会读剪贴板、解析、写入 `data/cookies.manual.buff.json`。
也支持 `-String "session=...; csrf_token=..."` 或 `-FromFile cookies.txt`。

### 2. 自检

```powershell
node scripts\doctor.mjs
```

会显示登录态是否有效、市场列表是否可用、挂单里是否拿得到精确磨损。

### 3. 跑配方

```powershell
node src\cli.mjs --target 0.1512345 --out-min 0.10 --out-max 0.70
```

---

## 参数说明

| 参数 | 说明 |
|---|---|
| `--target <float>` | **目标产物磨损**（必填） |
| `--out-min` / `--out-max` | 产物磨损区间。查产物：游戏内检视或 buff/cs2up 的物品页 |
| `--rarity <key>` | 材料稀有度：`consumer`\|`industrial`\|`milspec`\|`restricted`\|`classified`（默认） |
| `--market <m>` | 数据源：`buff`（默认）\|`youpin`\|`both` |
| `--band <float>` | 材料磨损带宽度（默认 0.02）。**调大更容易命中，但抓取更慢** |
| `--max-items <n>` | 最多检查多少件材料（默认 25，仅 buff） |
| `--max-listings <n>` | 每件材料最多抓多少笔挂单（默认 60，仅 buff） |
| `--max-templates <n>` | 悠悠最多检查多少模板（默认 40） |
| `--mix` | 开启混收藏品配方（产物变成概率分布） |
| `--max-collections <n>` | 混收藏品时最多几个收藏品（默认 3） |
| `--interval <ms>` | 请求间隔（默认 3000；**buff 风控严，别调太小**） |
| `--wants <n>` | 返回几组候选配方（默认 5） |
| `--dry` | 不联网，用合成数据演示数学流程 |

### 关键：材料稀有度要比产物低一档

| 产物 | 材料要用 |
|---|---|
| 隐秘（红） | `classified` 保密（粉） |
| 保密（粉） | `restricted` 受限（紫） |
| 受限（紫） | `milspec` 军规（蓝） |
| 军规（蓝） | `industrial` 工业（浅蓝） |
| 工业（浅蓝） | `consumer` 消费（白） |

---

## 输出

- `out/recipe-<时间>.json` —— 完整台账（请求参数、IEEE754 信息、每组配方与每笔挂单）
- `out/report-<时间>.html` —— **自包含可视化网页**，双击即可打开，无需服务器

网页包含：目标与 IEEE754 校验、每组配方的 10 把材料清单（磨损 + 价格 + 平台）、
材料总价、以及“按此顺序放入炉子”的提示。

---

## 命令一览

```powershell
# 自检登录态与连通性
node scripts\doctor.mjs

# 录入 buff / 悠悠 cookie
powershell -File scripts\set-cookies.ps1 -Site buff
powershell -File scripts\set-cookies.ps1 -Site youpin

# 跑配方
node src\cli.mjs --target 0.1512345 --out-min 0.10 --out-max 0.70

# 数学自测（31 项，归一化 / 反推 / IEEE754 / 求解器 / 相遇中点）
node tests\test-float.mjs

# 与西林磨损计算器源码逐位对照（把站点 script.js 跑在 Node 里做差分测试）
node tests\test-vs-site.mjs

# 尝试从 Chrome 直接导出 cookie（见下方“为什么默认不用这条路”）
powershell -File scripts\run-export-cookies.ps1
```

---

## 平台支持现状（都是实测结论）

| 平台 | 状态 | 说明 |
|---|---|---|
| **BUFF163** | ✅ **完整可用** | 登录后可搜索（按稀有度/外饰/收藏品/价格）、可服务端按磨损过滤、每页 60 笔，能凑出几百笔候选池。**实测已跑出 float32 精确命中（误差 = 0）的配方**：目标 `0.1512345` → 产物 `0.1512344926595688` |
| **悠悠有品** | ⚠️ 匿名受限 | 匿名可用且有精确磨损，但目录只有 20 条、每模板只有 20 笔挂单、翻页与磨损过滤都要登录 → 实际很难凑出目标。**录入 token 后可用性大幅提升** |
| **Steam 社区市场** | ❌ 网络不可达 | 本机 `steamcommunity.com` 直接连接失败（`fetch failed`），非代码问题，需代理 |
| **西林磨损计算器** | ✅ 算法基准 | 抓取其 `script.js` 作为**计算引擎的唯一真源**，逐位对齐（`ref/` + `tests/test-vs-site.mjs`） |
| **CS2UP** | — | 配方广场，作为参考，未做抓取 |

### 悠悠有品怎么启用登录

悠悠网页把 token 存在 `localStorage["uu_token"]`，请求时以 `authorization` 头发送。

1. Chrome 打开 `youpin898.com`，`F12` → **Application → Local Storage → 复制 `uu_token` 的值**
2. `powershell -File scripts\set-cookies.ps1 -Site youpin`，把 token 粘贴进去
3. 适配器会自动把它转成 `authorization` 头，并启用翻页与 `minAbrade/maxAbrade` 过滤

---

## 为什么默认不用“直接从 Chrome 读 Cookie”

因为这条路在这台机器上**走不通**，三个障碍依次是（都实测过）：

1. **App-Bound Encryption**：Chrome 155 的 cookie 全是 `v20` 前缀，主密钥
   `os_crypt.app_bound_encrypted_key` 被 **SYSTEM DPAPI + 用户 DPAPI 双层**包裹，
   必须由 `IElevator` COM 服务做路径校验后解密 —— **非管理员解不开**（本机不是管理员）。
2. **沙箱禁止启动 Chrome**：`chrome.exe` 一启动就以 `exit 0x6FF9` 被杀，
   所以 `--remote-debugging-port`（CDP 读取明文 cookie）这条路也断了。
   Chrome 136+ 还要求非默认 `--user-data-dir` 才能开调试端口。
3. **profile 独占锁**：Chrome 运行时对整份 profile 加独占锁。
   （这一条后来被绕过了：Node 的 `fs.copyFileSync` 能以共享方式复制出 Cookies 库，
   所以 `scripts/export-cookies.mjs` 能读到库文件 —— 但读到的仍是 **v20 密文**，解不开。）

所以最终采用**手工粘贴登录态**：一次操作几秒钟，且不依赖任何破解手段。
`scripts/export-cookies.mjs` 保留着，如果将来 Chrome 回退到 `v10` 加密、或者你以管理员运行，它就能直接工作。

---

## 项目结构

```
web/
  index.html           网页版界面（SSE 实时进度）
src/
  cli.mjs              主流程编排
  tradeup/float.mjs    float32 磨损数学 + 组合求解器（移植自西林磨损计算器）
  market/buff.mjs      BUFF 适配器
  market/youpin.mjs    悠悠有品适配器
  market/pool.mjs      多市场候选池构建 + 归一化
  web/report.mjs       自包含 HTML 可视化（命令行版产物）
  web/server.mjs       网页版服务（读配方链接 + 搜索材料）
  cs2up/recipe.mjs     CS2UP 分享配方读取器
  cs2up/materials.mjs  本地材料库索引（收藏品 → 皮肤清单 + 稀有度）
  market/resolve.mjs   配方 → 真实挂单解析器（旧流程）
  market/hunter.mjs    收藏品内按目标磨损凑 10 把（主流程）
  market/steam.mjs     Steam 社区市场适配器（价格 + 搜索 + 挂单页解析）
  market/inspect.mjs   CS2 检视链接解码器（纯 protobuf，解出逐笔 float）
  auth/session.mjs     cookie 加载与请求头
  auth/steam-login.mjs Steam 登录态解析与**真实**验证
  util/http.mjs        串行节流 + 指数退避的 HTTP 客户端
  util/net.mjs         支持代理的 HTTPS 客户端（CONNECT 隧道 + 自选 TLS 策略）
ref/
  script.js            西林磨损计算器的源码（算法真源，逐位对照用）
  materials-data.js    其材料库
  crates-data.js       其箱子库
scripts/
  doctor.mjs           环境/登录态自检
  set-cookies.ps1      手工录入登录态（读剪贴板）
  set-cookies.mjs      解析器（支持 Cookie 头 / Cookie-Editor JSON / 每行一条）
  run-export-cookies.ps1  Chrome cookie 导出入口（PowerShell 负责 DPAPI）
  export-cookies.mjs   解密与落盘（Node 负责 AES-GCM + SQLite）
tests/
  test-float.mjs       数学与求解器自测（31 项）
  test-vs-site.mjs     与站点源码的逐位差分测试（7 项 / 46,000 用例）
  test-cs2up.mjs       CS2UP 配方读取器测试（sid 解析 + 真实配方）
  test-steam.mjs       Steam 价格与搜索自测
  test-inspect.mjs     检视链接解码器自测（21 项）
  test-steam-login.mjs Steam / CSFloat 登录态验证自测
docs/
  BUFF-API.md          BUFF 接口实测记录（含所有踩过的坑）
  YOUPIN-API.md        悠悠有品接口实测记录
```

---

## 注意事项

- **挂单会被别人买走**，配方出来后请尽快按顺序购入；本工具只做计算，不代下单。
- 价格是**挂单价**，实际成交有手续费与滑点，本工具按你的要求**未计入** ROI/手续费。
- 产物区间 `--out-min/--out-max` 必须填**产物（高一档）**的区间，不是材料的。
  填错会得到“没有任何材料的磨损区间能覆盖所需均值”。
- **材料与产物必须同收藏品、同档位**，否则产物不唯一。本工具按“单收藏品 →
  确定产物”的方式求解，10 把材料取自同一批同档材料。
- 抓取有风控，请保留默认的 `--interval`。BUFF 限流时会返回
  `{"code":"System Error"}` 甚至静默降级成 `Login Required`，客户端已内置退避重试。
- 求解结果依赖当时的挂单，**换一次运行结果就会不同**（挂单是实时变动的）。
