# 悠悠有品（youpin898）接口 —— 实测记录

> 本文件记录的是本机实测验证过的行为，支撑 `src/market/youpin.mjs` 的实现。

## 结论先行

- **移动端 ES 接口匿名可用，且没有 sign/HMAC**，每笔挂单直接带精确磨损 `Abrade`。
- **但匿名被硬卡在 `pageIndex=1`**：模板目录只给 20 条、每个模板只给 20 笔挂单，
  且磨损区间过滤参数匿名无效。所以匿名状态下**几乎不可能**刚好覆盖某个精确目标磨损。
- 要真正可用，必须带登录 token（可以翻页 + 服务端按磨损过滤）。

## 1. 端点

| 用途 | 端点 | 匿名 |
|---|---|---|
| 模板目录（= 单品列表） | `POST https://api.youpin898.com/api/homepage/es/template/GetCsGoPagedList` | ✅ 可用，但只有第 1 页 20 条 |
| 某模板的在售挂单 | `POST https://api.youpin898.com/api/homepage/es/commodity/GetCsGoPagedList` | ✅ 可用，但只有第 1 页 20 条 |
| 商品详情 | `GET https://api.youpin898.com/api/commodity/Commodity/Detail?id=<commodityId>` | ✅ 可用 |
| PC 端接口 | `pc-api.youpin898.com/api/homepage/pc/goods/market/queryOnSaleCommodityList` | ❌ 需要设备指纹，返回 `85100` 或 WAF 403 |

### 1.1 模板目录请求体（实测）
```json
{"filterMap":{},"gameId":730,"listSortType":0,"listType":10,
 "pageIndex":1,"pageSize":20,"sortType":0,"stickerAbrade":0,"stickersIsSort":false}
```
返回 `Data[]`，字段包含：
`Id`(=templateId)、`CommodityName`、`CommodityHashName`、`Exterior`(中文)、`Rarity`(中文)、
`Quality`、`Price`、`OnSaleCount`、`SteamPrice`、`IconUrl` 等。`TotalCount` 真实（34857）。

`listType` 会给出不同的结果集：10→34857、20→39968、30→11479（语义未确认，但可以用来扩大匿名覆盖面）。

### 1.2 挂单请求体（实测，注意字段类型是**字符串**）
```json
{"listSortType":"1","listType":10,"pageIndex":1,"pageSize":20,
 "sortType":"1","templateId":"113014","status":"20","userId":""}
```
返回：
```json
{"Code":0,"Msg":"success","TotalCount":500,"HasNext":null,
 "Data":{"CommodityList":[{
    "Id":2082969855,"CommodityNo":"20261012744368576022671360",
    "TemplateId":113014,"CommodityName":"AK-47 | The Oligarch (久经沙场)",
    "Price":"262","Abrade":"0.3407650291919708000",
    "IconUrl":"...","UserNickName":"..."}],
  "TemplateInfo":{...},"Filters":[...]}}
```

**每笔精确磨损 = `Data.CommodityList[].Abrade`，是字符串**（约 18 位小数），必须 parseFloat。

## 2. 磨损区间

`Exterior` 是中文；区间取自接口自己的 `Filters`（`FilterKey:"abrade"`）：

| 中文 | exteriorHashName | exteriorId | 区间 |
|---|---|---|---|
| 崭新出厂 | `WearCategory0` | 68 | 0.00–0.07 |
| 略有磨损 | `WearCategory1` | 69 | 0.07–0.15 |
| 久经沙场 | `WearCategory2` | 70 | 0.15–0.38 |
| 破损不堪 | `WearCategory3` | 71 | 0.38–0.45 |
| 战痕累累 | `WearCategory4` | 72 | 0.45–1.00 |

## 3. 错误码

| Code | Msg | 含义 |
|---|---|---|
| 0 | success | 正常 |
| -1 | 系统繁忙,请稍后再试 | **不是限流**，是请求格式错误（比如用 GET 打 POST 端点、body 解析不了） |
| 84103 | 登录悠悠有品，解锁更多功能 | 登录门槛：翻页、非默认排序、minAbrade/maxAbrade 都会触发 |
| 84104 | 参数错误 | 参数不合法（例如缺 templateId） |
| 85100 | 当前app版本过低 | PC 端缺设备 `uk`（HTTP 429） |
| HTTP 403 | Aliyun WAF HTML | IP 级封禁，快速连打 6~8 次 `/api/commodity/*` 就会触发，实测封锁 > 3 分钟 |

## 4. 登录态

网页端把 token 放在 `localStorage["uu_token"]`，请求时以 **`authorization: <token>`** 头发送。
本项目的读取方式：把 token 作为名为 `token` 的 cookie 写进
`data/cookies.manual.youpin.json`，适配器会自动转成 `authorization` 头。

```powershell
# Chrome 打开 youpin898.com → F12 → Application → Local Storage → 复制 uu_token 的值
powershell -File scripts\set-cookies.ps1 -Site youpin
```

## 5. 节流建议

- 匿名：≥ 2.5 秒/请求。
- 有登录态：≤ 1 请求/2~3 秒，每 50~100 请求停 60 秒；遇到 403/429 指数退避。
- 不要并发打 `/api/commodity/*`，很容易吃 WAF。
