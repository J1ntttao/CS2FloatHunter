/**
 * Steam 社区市场适配器。
 *
 * 实测结论（本机有 SteamTools 中间人，直连 steamcommunity.com 的证书由
 * "SteamTools Certificate" 签发，Node 默认校验会失败，所以需要 allowInsecure）：
 *
 *  ✅ 能用：
 *     - GET /market/priceoverview/?appid=730&currency=23&market_hash_name=...
 *       → {"success":true,"lowest_price":"¥ 4.96","median_price":"¥ 5.12","volume":"78"}
 *       这是**唯一可靠的 Steam 价格来源**，匿名可用、按人民币返回。
 *     - GET /market/search/render/?appid=730&norender=1&count=&start=&query=&sort_column=
 *       → 可搜索、可排序、可分页；但返回价格是美元（$），需要另行换算。
 *
 *  ❌ 不能用：
 *     - /market/listings/730/<name>：被 SteamTools 返回 HTTP 500（它自己的 SSR 页面），
 *       拿不到 g_rgListingInfo。
 *     - 因此**Steam 无法提供每一笔挂单的精确磨损（float）**。
 *       Steam 的挂单 float 只存在于 game coordinator 的检视数据里，网页端也是靠
 *       protobuf 拿检视链接再解码，本环境无法实现。
 *
 * 所以 Steam 在本项目里的定位是**价格参照 / 更便宜的替代来源**：
 * 它能告诉你「同一个皮肤同一个磨损档，在 Steam 上最低多少钱」，
 * 用来和 BUFF 对比、找出更划算的一边。但它给的挂单只能保证「落在该磨损档区间内」，
 * 无法保证是我们算出的那个精确 float。
 *
 * 货币：currency=23 是人民币。Steam 的 search/render 不认 currency 参数（返回 $），
 * 所以只用它做搜索/发现，价格一律走 priceoverview。
 */

import { httpsGet, proxyFromEnv, makeFetcher, DEFAULT_UA } from '../util/net.mjs';
import { steamListingUrl } from './inspect.mjs';

const ORIGIN = 'https://steamcommunity.com';
export const CNY = 23;

/** 磨损档 → Steam 搜索用的 exterior tag */
export const STEAM_EXTERIOR_TAG = {
  fn: 'tag_WearCategory0',
  mw: 'tag_WearCategory1',
  ft: 'tag_WearCategory2',
  ww: 'tag_WearCategory3',
  bs: 'tag_WearCategory4',
};

/** 从 "¥ 4.96" / "$0.73" 这类文本里解析出数值 */
export function parsePriceText(txt) {
  if (!txt) return null;
  const m = String(txt).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** 从新版页面里找下一页游标（找不到返回 null） */
export function extractNextCursor(html) {
  for (const re of [/"next_cursor":"([^"]+)"/, /"cursor":"([A-Za-z0-9_\-=+%]+)"/, /cursor=([A-Za-z0-9_\-=+%]+)/]) {
    const m = html.match(re);
    if (m && m[1] && m[1] !== 'null') return m[1];
  }
  return null;
}

/**
 * 解析新版 Steam 挂单页（React/SSR，2026 年后的版本）。
 *
 * 旧版页面用全局变量 `g_rgListingInfo`，**现在已经完全没有了**（实测 0 次出现），
 * 所以任何基于它的解析都会失败。新版把数据注水在：
 *
 *   <script type="application/json" id="valve-ssr-data"> {route, loaderData, ...} </script>
 *
 * 而且数据被**多层 JSON 字符串嵌套**（loaderData 是字符串数组，里面又是 JSON 字符串），
 * 需要递归下降解析才能拿到 `listings` 数组。
 *
 * 每笔挂单的关键字段：
 *   listingid      —— 挂单 id，用于构造直接购买链接 ?listing=<id>
 *   unPrice/unFee  —— 价格（分）；strSubtotal 是显示价，如 "¥0.55"
 *   asset.asset_properties[]:
 *       {propertyid: 1, int_value: "438"}                —— paintseed
 *       {propertyid: 2, float_value: 0.18269971013069153} —— **精确磨损（直接就是 float！）**
 *       {propertyid: 6, string_value: "7E6EE3BE..."}      —— 加密串，无法当 protobuf 解，别碰
 *
 * 也就是说新版页面**直接给了 float**，既不用解检视链接，也不用任何外部服务。
 */
export function parseValveSsrListings(html) {
  const tagMatch = html.match(/<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!tagMatch) return { ok: false, error: 'no_valve_ssr_data' };

  let outer;
  try { outer = JSON.parse(tagMatch[1]); } catch (e) {
    return { ok: false, error: 'ssr_json_parse_failed', detail: e.message };
  }

  const listingsGroups = findListingsArrays(outer);
  if (!listingsGroups.length) return { ok: false, error: 'no_listings_in_ssr', outer };

  const raw = listingsGroups[0];
  const pending = listingsGroups[1] || null;   // 预取的第二页（Steam 常一次注水两页）
  const listings = raw.map(normalizeListing).filter(Boolean);
  const pendingListings = pending ? pending.map(normalizeListing).filter(Boolean) : [];
  // 顺便带上总数，供翻页判断是否到底
  const rawTotal = listingsGroups[0].total_count ?? null;
  return { ok: true, listings, pendingListings, rawCount: raw.length, rawTotal };
}

/** 递归下降找 listings 数组（数据被多层 JSON 字符串包裹） */
function findListingsArrays(node, depth = 0, acc = []) {
  if (depth > 14 || acc.length >= 4) return acc;
  if (typeof node === 'string') {
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length > 2) {
      try { findListingsArrays(JSON.parse(s), depth + 1, acc); } catch { /* 不是 JSON，忽略 */ }
    }
    return acc;
  }
  if (Array.isArray(node)) {
    for (const x of node) findListingsArrays(x, depth + 1, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.listings) && node.listings.length && node.listings[0] && node.listings[0].listingid) {
      acc.push(node.listings);
    }
    for (const v of Object.values(node)) findListingsArrays(v, depth + 1, acc);
    return acc;
  }
  return acc;
}

/** 把一条原始挂单规整成内部结构 */
function normalizeListing(l) {
  if (!l || !l.listingid) return null;
  const props = (l.asset && l.asset.asset_properties) || [];
  const p1 = props.find(x => x.propertyid === 1);
  const p2 = props.find(x => x.propertyid === 2);
  const floatvalue = p2 && p2.float_value != null ? Number(p2.float_value) : null;
  const paintseed = p1 && p1.int_value != null ? Number(p1.int_value) : null;

  // 价格：unPrice + unFee 都是「分」
  const cents = (l.unPrice != null ? l.unPrice : null) != null
    ? l.unPrice + (l.unFee || 0)
    : null;

  return {
    market: 'steam',
    listingId: String(l.listingid),
    assetId: l.asset ? String(l.asset.assetid || l.asset.id) : null,
    floatvalue,
    paintseed,
    price: cents != null ? cents / 100 : null,
    priceCents: cents,
    priceText: l.strSubtotal || (cents != null ? (cents / 100).toFixed(2) : null),
    currencyId: l.eCurrency != null ? l.eCurrency : null,
    inspectPropertiesEncrypted: props.some(x => x.propertyid === 6),
    raw: l,
  };
}

export class SteamMarket {
  /**
   * @param {object} opts
   * @param {{host:string,port:number}|null} opts.proxy  走代理（不传则读环境变量）
   * @param {boolean} opts.allowInsecure  放宽证书校验（本机有 SteamTools 等中间人时必须开）
   * @param {string}  opts.caFile         自定义根证书
   * @param {boolean} opts.symbolOnly     是否只关心符号（默认人民币 ¥）
   */
  constructor({ minIntervalMs = 1600, proxy, allowInsecure = true, caFile = null, verbose = false } = {}) {
    this.proxy = proxy !== undefined ? proxy : proxyFromEnv();
    this.allowInsecure = allowInsecure;
    this.caFile = caFile;
    this.verbose = verbose;
    this.fetch = makeFetcher({
      proxy: this.proxy, allowInsecure, caFile,
      minIntervalMs, label: 'steam',
    });
    this._cache = new Map();
  }

  _log(...a) { if (this.verbose) console.log('[steam]', ...a); }

  /**
   * 单品价格（人民币）。这是 Steam 侧最可靠的数据。
   * @returns {Promise<{ok:boolean, lowest?:number, median?:number, volume?:number, lowestText?:string, raw?:string, error?:string}>}
   */
  async priceOverview(marketHashName, { currency = CNY } = {}) {
    const key = `${currency}|${marketHashName}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const url = `${ORIGIN}/market/priceoverview/?appid=730&currency=${currency}&market_hash_name=${encodeURIComponent(marketHashName)}`;
    let out;
    try {
      const r = await this.fetch(url, { headers: { accept: 'application/json', referer: `${ORIGIN}/market/` } });
      let j = null;
      try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
      if (r.status !== 200) {
        out = { ok: false, error: `HTTP ${r.status}`, raw: r.body.slice(0, 200) };
      } else if (!j) {
        out = { ok: false, error: 'non_json', raw: r.body.slice(0, 200) };
      } else if (j.success !== true) {
        // 常见的 success:false 是「该磨损档没有在售」
        out = { ok: false, error: 'no_listing', raw: JSON.stringify(j) };
      } else {
        out = {
          ok: true,
          lowest: parsePriceText(j.lowest_price),
          median: parsePriceText(j.median_price),
          volume: j.volume != null ? Number(j.volume) : null,
          lowestText: j.lowest_price,
          medianText: j.median_price,
          currency,
        };
      }
    } catch (e) {
      out = { ok: false, error: e.message };
    }
    this._cache.set(key, out);
    return out;
  }

  /**
   * 搜索市场（用于发现/排序）。注意返回价格是美元，只作参考。
   */
  async search({ query = '', start = 0, count = 20, sortColumn = 'price', sortDir = 'asc', exterior = null } = {}) {
    const p = new URLSearchParams({
      appid: '730', norender: '1', count: String(count), start: String(start),
      sort_column: sortColumn, sort_dir: sortDir,
    });
    if (query) p.set('query', query);
    if (exterior) p.set('category_730_Exterior[]', STEAM_EXTERIOR_TAG[exterior] || exterior);
    const url = `${ORIGIN}/market/search/render/?${p}`;
    try {
      const r = await this.fetch(url, { headers: { accept: 'application/json', referer: `${ORIGIN}/market/` } });
      let j = null;
      try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
      if (!j || j.success !== true) return { ok: false, error: j ? 'unsuccessful' : 'non_json', raw: r.body.slice(0, 200) };
      return {
        ok: true,
        total: j.total_count,
        results: (j.results || []).map(it => ({
          name: it.hash_name,
          sellListings: it.sell_listings,
          priceText: it.sell_price_text,
          priceUsd: it.sell_price != null ? it.sell_price / 100 : null,
          appIcon: it.app_icon,
        })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 拉取 Steam 挂单页并拿到**每一笔的精确磨损**。
   *
   * 新版页面（React/SSR）把数据注水在 <script id="valve-ssr-data"> 里，
   * 每笔的 asset_properties 中 propertyid=2 直接就是 float_value —— 不需要解检视链接、
   * 不需要 CSGOFloat、不需要登录。（旧版的 g_rgListingInfo 已经彻底没了。）
   *
   * 翻页：实测 `?start=20` **有效**（`?cursor=` / `?page=` 会被忽略）。每页固定 20 笔。
   *
   * ⚠️ 固有限制：Steam 的挂单是**按价格排序**的，不是按磨损。
   * 因此无法「按磨损区间检索」，只能一页页扫、扫到多少算多少。
   * 这是 Steam 侧的限制，不是实现问题。
   *
   * @param {object} opts
   *   pages   抓多少页（每页 20 笔，默认 3）
   *   cookies 可选，带上登录态可降低风控概率
   * @returns {Promise<{ok:boolean, listings:Array, error?:string, diag?:object, pagesFetched?:number}>}
   */
  async listingsWithFloats(marketHashName, { cookies = null, pages = 3 } = {}) {
    const collected = [];
    const seen = new Set();
    let diag = null;
    let pagesFetched = 0;
    let rateLimited = false;

    for (let page = 0; page < Math.max(1, pages); page++) {
      const start = page * 20;
      const base = `${ORIGIN}/market/listings/730/${encodeURIComponent(marketHashName)}`;
      const url = start ? `${base}?start=${start}` : base;
      const headers = {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: `${ORIGIN}/market/`,
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      };
      if (cookies) headers.cookie = cookies;

      let r;
      try {
        r = await this.fetch(url, { headers, retries: 2, timeoutMs: 40000 });
      } catch (e) {
        if (page === 0) return { ok: false, error: `请求挂单页失败：${e.message}`, listings: [] };
        break;
      }

      // 500/429/503 是 Steam（或中间人）在**限流**，不是"网络不通"，
      // 也不该归咎于没配代理。这里退避重试；仍失败就如实标注为限流。
      if (r.status === 500 || r.status === 429 || r.status === 503) {
        let recovered = false;
        for (let att = 0; att < 3 && !recovered; att++) {
          await new Promise(res => setTimeout(res, 6000 * (att + 1) + Math.random() * 2000));
          try {
            const r2 = await this.fetch(url, { headers, retries: 0, timeoutMs: 40000 });
            if (r2.status === 200) { r = r2; recovered = true; }
          } catch { /* 继续退避 */ }
        }
        if (!recovered) {
          rateLimited = true;
          if (page === 0) {
            return {
              ok: false, status: r.status, rateLimited: true,
              error: `Steam 返回 ${r.status}（限流）—— 请求太快，与代理配置无关。请稍后重试，或减少抓取页数。`,
              listings: [], htmlLen: (r.body || '').length,
            };
          }
          break;
        }
      }

      const html = r.body || '';
      if (r.status !== 200) {
        if (page === 0) {
          return { ok: false, status: r.status, error: `HTTP ${r.status}`, listings: [], htmlLen: html.length };
        }
        break;
      }

      const parsed = parseValveSsrListings(html);
      if (!diag) {
        diag = {
          finalUrl: r.finalUrl,
          htmlLen: html.length,
          hasValveSsr: html.includes('valve-ssr-data'),
          hasLegacyListingInfo: html.includes('g_rgListingInfo'),
          looksIntercepted: html.includes('queniuqe'),
          ssrError: parsed.ok ? null : parsed.error,
        };
      }
      if (!parsed.ok) {
        if (page === 0) {
          return {
            ok: false, error: `页面结构无法解析（${parsed.error}）`, diag, listings: [],
          };
        }
        break;
      }

      let added = 0;
      for (const l of [...parsed.listings, ...parsed.pendingListings]) {
        if (seen.has(l.listingId)) continue;
        seen.add(l.listingId);
        collected.push(l);
        added++;
      }
      pagesFetched++;

      // 这一页没有新数据（到底了）就停
      if (added === 0) break;
      // 已抓到的数量达到总量也停
      if (parsed.rawTotal && start + 20 >= parsed.rawTotal) break;
    }

    return {
      ok: true,
      listings: collected,
      diag,
      pagesFetched,
      rateLimited,
      withFloat: collected.filter(l => l.floatvalue != null).length,
    };
  }

  /** 连通性自检 */
  async health() {
    const r = await this.priceOverview('AK-47 | Redline (Field-Tested)');
    return {
      ok: r.ok,
      proxy: this.proxy ? `${this.proxy.host}:${this.proxy.port}` : null,
      allowInsecure: this.allowInsecure,
      sample: r.ok ? { lowest: r.lowest, lowestText: r.lowestText, volume: r.volume } : r,
    };
  }
}
