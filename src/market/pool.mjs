/**
 * 候选池构建：把不同市场的数据统一成 { paintwear, price, ... } 的挂单列表。
 *
 * 两个市场的差异（都经实测）：
 *  - buff   ：列表接口可按 rarity 分页搜索；sell_order 支持 min_paintwear/max_paintwear 服务端过滤，
 *             每页可要 60 条，能抓到几百笔 → 求解精度高。
 *  - youpin ：匿名只能 pageIndex=1、每页固定 20 条；磨损过滤参数匿名不可用
 *             → 只能按 exterior 选模板，再客户端按 Abrade 过滤，池子小一个数量级。
 */

import { BuffMarket, RARITY as BUFF_RARITY } from './buff.mjs';
import { YoupinMarket, EXTERIOR_BY_CN, RARITY_BY_CN } from './youpin.mjs';
import { f32, normalizeWear } from '../tradeup/float.mjs';

/** 反向映射：内部稀有度代号 → 中文（youpin 用） */
const CN_OF_RARITY = Object.fromEntries(Object.entries(RARITY_BY_CN).map(([cn, k]) => [k, cn]));

/** 判断某件材料的磨损区间能否覆盖目标均值（决定它能不能用来凑这个配方） */
export function coversAvg(range, avg, band) {
  if (!range) return false;
  const [lo, hi] = range;
  const covLo = Math.max(lo, avg - band);
  const covHi = Math.min(hi, avg + band);
  return covHi > covLo;
}

function coverage(range, avg, band) {
  const lo = Math.max(range[0], avg - band);
  const hi = Math.min(range[1], avg + band);
  return { lo, hi, ok: hi > lo };
}

/**
 * 给候选池里的每一笔挂单算出它在**归一化空间**的贡献值。
 *
 * 这一步是必须的：炼金公式要用每把材料**自己**的磨损区间归一化后再平均，
 * 不同收藏品的材料区间不同，所以不能拿原始磨损直接平均。
 *
 * @param {Array} pool 挂单数组，每项需含 paintwear 与 matRange=[min,max]
 */
export function normalizePool(pool) {
  const norm = [];
  const usable = [];
  for (const l of pool) {
    if (l.paintwear == null) continue;
    const range = l.matRange;
    if (!range || !(range[1] - range[0] > 0)) continue;
    const n = normalizeWear(l.paintwear, range[0], range[1]);
    norm.push(n);
    usable.push({ ...l, norm: n });
  }
  return { norm, usable };
}

/**
 * 从 BUFF 构建候选池。
 * @returns {Promise<{pool:Array, usableItems:Array, log:string[]}>}
 */
export async function buildPoolFromBuff({
  rarity, wantAvg, band, maxItems, maxListingsPerItem, intervalMs = 3000,
  excludeStatTrak = false, verbose = true,
}) {
  const buff = new BuffMarket({ minIntervalMs: intervalMs, verbose });
  const log = [];
  const add = s => { log.push(s); if (verbose) console.log(s); };

  add(`[buff] 搜索 ${rarity} 材料 ...`);
  const list = await buff.listGoods({ rarity: BUFF_RARITY[rarity], pageSize: 50 });
  if (!list.ok) {
    return { pool: [], usableItems: [], log, error: list.kind };
  }
  add(`[buff] 命中 ${list.items.length} 件 / 共 ${list.total} 件`);

  const candidates = list.items
    .filter(it => !(it.name || '').includes('★'))
    .filter(it => !(it.name || '').includes('纪念品'))
    .filter(it => !excludeStatTrak || !(it.name || '').includes('StatTrak'))
    .sort((a, b) => (b.sell_num || 0) - (a.sell_num || 0))
    .slice(0, maxItems);

  const usableItems = [];
  for (const it of candidates) {
    const g = await buff.goodsInfo(it.id);
    if (!g.ok || !g.info?.paintwear_range) continue;
    const range = g.info.paintwear_range.map(Number);
    const cov = coverage(range, wantAvg, band);
    if (!cov.ok) continue;
    usableItems.push({
      market: 'buff', goodsId: it.id, templateId: it.id,
      name: g.info.name, range, lo: cov.lo, hi: cov.hi,
      sellNum: it.sell_num, minPrice: it.sell_min_price, iconUrl: it.goods_info?.icon_url,
    });
  }
  add(`[buff] 区间覆盖目标均值的材料 ${usableItems.length} 件`);

  const pool = [];
  for (const u of usableItems) {
    const so = await buff.sellOrders({
      goodsId: u.goodsId, minPaintwear: u.lo, maxPaintwear: u.hi,
      sortBy: 'paintwear.asc', pageSize: maxListingsPerItem,
    });
    if (!so.ok) {
      add(`[buff]   ${u.name} -> ${so.kind}，跳过`);
      if (so.kind === 'login_required') break;
      continue;
    }
    const got = so.listings.filter(l => l.paintwear != null);
    add(`[buff]   ${u.name}  [${u.lo.toFixed(5)}, ${u.hi.toFixed(5)}]  ${got.length} 笔 / 总 ${so.total}`);
    for (const l of got) pool.push({ ...l, matName: u.name, matRange: u.range, matIcon: u.iconUrl });
    if (pool.length >= 800) { add('[buff] 候选池已达 800，停止抓取'); break; }
  }
  return { pool, usableItems, log };
}

/**
 * 从悠悠有品构建候选池。
 * 匿名：每个模板只有 20 笔挂单、模板目录只有 1 页 → 池子很小。
 * 有登录态（data/cookies.manual.youpin.json 里的 token）：可翻页、可用 min/maxAbrade 过滤 → 池子大得多。
 */
export async function buildPoolFromYoupin({
  rarity, wantAvg, band, maxTemplates = 40, intervalMs = 2500,
  listTypes = [10, 20, 30, 40, 50], verbose = true,
}) {
  const yp = new YoupinMarket({ minIntervalMs: intervalMs, verbose });
  const log = [];
  const add = s => { log.push(s); if (verbose) console.log(s); };

  const authed = yp.hasAuth;
  add(`[youpin] 登录态：${authed ? '有（可翻页 + 磨损区间过滤）' : '无（匿名，每模板仅 20 笔、目录仅 1 页）'}`);
  const cnRarity = CN_OF_RARITY[rarity];

  // ---- 收集模板目录 ----
  const seen = new Set();
  const templates = [];
  const types = authed ? listTypes : [listTypes[0]];
  const pages = authed ? 5 : 1;
  for (const listType of types) {
    for (let pageIndex = 1; pageIndex <= pages; pageIndex++) {
      const t = await yp.listTemplates({ listType, pageIndex });
      if (!t.ok) { add(`[youpin]   模板 listType=${listType} p${pageIndex} -> ${t.kind}，停止`); break; }
      let added = 0;
      for (const x of t.templates) {
        if (seen.has(x.templateId)) continue;
        seen.add(x.templateId);
        templates.push(x);
        added++;
      }
      add(`[youpin]   模板 listType=${listType} p${pageIndex}: +${added}（累计 ${templates.length}）`);
      if (!t.templates.length) break;
    }
  }

  // ---- 过滤出能用的模板 ----
  const usable = [];
  for (const x of templates) {
    if (cnRarity && x.rarity !== cnRarity) continue;
    if (!x.range) continue;
    const cov = coverage(x.range, wantAvg, band);
    if (!cov.ok) continue;
    usable.push({ ...x, lo: cov.lo, hi: cov.hi });
  }
  add(`[youpin] 稀有度+磨损区间都匹配的模板 ${usable.length} 件（目录共 ${templates.length} 件）`);
  if (!usable.length) {
    add('[youpin] 提示：匿名目录只有 20 件且顺序固定，几乎不可能刚好覆盖某个精确磨损。');
    add('[youpin]       要真正可用，请录入登录 token：');
    add('[youpin]       powershell -File scripts\\set-cookies.ps1 -Site youpin');
    add('[youpin]       （Chrome 打开 youpin898.com → F12 → Application → Local Storage → 复制 uu_token）');
  }

  // ---- 抓挂单 ----
  const pool = [];
  for (const u of usable.slice(0, maxTemplates)) {
    const maxPage = authed ? 5 : 1;
    let got = 0, total = 0;
    for (let pageIndex = 1; pageIndex <= maxPage; pageIndex++) {
      const cl = await yp.commodityList({
        templateId: u.templateId, pageIndex,
        minAbrade: authed ? u.lo : undefined,
        maxAbrade: authed ? u.hi : undefined,
      });
      if (!cl.ok) {
        if (pageIndex === 1) add(`[youpin]   ${u.name} -> ${cl.kind}，跳过`);
        break;
      }
      total = cl.total;
      // 匿名不支持服务端磨损过滤，必须客户端筛
      const keep = cl.listings.filter(l => l.paintwear != null && l.paintwear >= u.lo && l.paintwear <= u.hi);
      for (const l of keep) pool.push({ ...l, matName: u.name, matRange: u.range, matIcon: u.iconUrl });
      got += keep.length;
      if (!cl.listings.length) break;
    }
    add(`[youpin]   ${u.name}  [${u.lo.toFixed(5)}, ${u.hi.toFixed(5)}]  ${got} 笔 / 总 ${total}`);
  }
  return { pool, usableItems: usable, log, authed };
}

/** 汇总统计，用于 HTML 展示 */
export function poolStats(pool) {
  const ws = pool.map(l => f32(l.paintwear)).filter(Number.isFinite);
  const prices = pool.map(l => l.price).filter(Number.isFinite);
  return {
    count: pool.length,
    minWear: ws.length ? Math.min(...ws) : null,
    maxWear: ws.length ? Math.max(...ws) : null,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    markets: [...new Set(pool.map(l => l.market))],
  };
}
