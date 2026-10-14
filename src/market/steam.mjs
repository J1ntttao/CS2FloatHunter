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
 *  ⚠️ 注意：
 *     - 新版 /market/listings/730/<name> 是磨损聚合页，页面里可能同时出现 FN/MW/FT/WW/BS。
 *       每笔挂单的 description.market_hash_name 与 asset_properties.propertyid=2 才是身份和磨损的
 *       权威来源，不能用请求 URL 覆盖它们。
 *
 * Steam 因此可以直接作为候选池来源：先按挂单自身的 market_hash_name 过滤聚合页，
 * 再用每笔 float 求解配方。
 *
 * 货币：currency=23 是人民币。Steam 的 search/render 不认 currency 参数（返回 $），
 * 所以只用它做搜索/发现，价格一律走 priceoverview。
 */

import { httpsGet, proxyFromEnv, makeFetcher, DEFAULT_UA } from '../util/net.mjs';
import { steamListingUrl } from './inspect.mjs';
import { skinName } from '../cs2up/location.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { samplePages } from './page-sampling.mjs';

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

const EXTERIOR_RANGES = {
  'Factory New': [0, 0.07],
  'Minimal Wear': [0.07, 0.15],
  'Field-Tested': [0.15, 0.38],
  'Well-Worn': [0.38, 0.45],
  'Battle-Scarred': [0.45, 1],
};

/** Steam 新版前端 AssetPropertyFilter：property_id=1，float_min=2，float_max=3。 */
export function steamWearFilter(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || min > max) {
    throw new Error('Steam 磨损过滤区间无效');
  }
  const bytes = Buffer.alloc(12);
  bytes[0] = 0x08; bytes[1] = 2;
  bytes[2] = 0x15; bytes.writeFloatLE(min, 3);
  bytes[7] = 0x1d; bytes.writeFloatLE(max, 8);
  return bytes.toString('base64');
}

function listingQuery(name, min, max, sortBy) {
  const params = new URLSearchParams();
  if (min != null || max != null) {
    params.set('assetproperty', steamWearFilter(min ?? 0, max ?? 1));
    const exterior = name.match(/\(([^()]*)\)\s*$/)?.[1];
    const index = Object.keys(EXTERIOR_RANGES).indexOf(exterior);
    if (index >= 0) params.set('category_Exterior', `WearCategory${index}`);
    params.set('category_Quality', /^StatTrak™?\s/i.test(name) ? 'strange' : 'normal');
  }
  if (sortBy === 'wear.asc' || sortBy === 'wear.desc') {
    params.set('sort', '1'); params.set('propertyid', '2');
    params.set('dir', sortBy === 'wear.asc' ? '0' : '1');
  }
  return params;
}

/** 商品身份与挂单实际磨损同时校验，避免聚合页混档或无身份数据被误用。 */
export function steamListingMatches(listing, marketHashName, { allowOtherExteriors = false } = {}) {
  if (allowOtherExteriors && listing.marketHashName &&
      skinName(listing.marketHashName) === skinName(marketHashName)) {
    return steamListingMatches(listing, listing.marketHashName);
  }
  if (!listing.marketHashName || listing.marketHashName !== marketHashName) return false;
  const exterior = marketHashName.match(/\(([^()]*)\)\s*$/)?.[1];
  const range = EXTERIOR_RANGES[exterior];
  const wear = listing.floatvalue;
  if (!range || !Number.isFinite(wear)) return false;
  return wear >= Math.fround(range[0]) &&
    (exterior === 'Battle-Scarred' ? wear <= 1 : wear < Math.fround(range[1]));
}

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
 *   listingid      —— 挂单 id，用于构造挂单详情链接 ?detail=<id>
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

  const raw = listingsGroups[0].listings;
  const pending = listingsGroups[1]?.listings || null;   // 预取的第二页（Steam 常一次注水两页）
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
    if (Array.isArray(node.listings) && (!node.listings.length || node.listings[0]?.listingid)) {
      acc.push({ listings: node.listings, total_count: node.total_count ?? node.totalCount ?? null });
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

  // 新版 Steam 的商品页会跳转到一个聚合页，页内可能同时注水 FN/MW/FT/WW/BS。
  // 不能使用请求 URL 推断档位，必须保留每笔挂单自己的商品描述。
  const description = l.description || {};

  return {
    market: 'steam',
    listingId: String(l.listingid),
    assetId: l.asset?.assetid != null ? String(l.asset.assetid) : l.asset?.id != null ? String(l.asset.id) : null,
    floatvalue,
    paintseed,
    price: cents != null ? cents / 100 : null,
    priceCents: cents,
    priceText: l.strSubtotal || (cents != null ? (cents / 100).toFixed(2) : null),
    currencyId: l.eCurrency != null ? Number(l.eCurrency) : null,
    name: description.market_name || null,
    marketHashName: description.market_hash_name || null,
    exterior: description.market_name_inside_group || null,
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
  constructor({ minIntervalMs = 1600, proxy, allowInsecure = true, caFile = null, verbose = false, signal } = {}) {
    this.proxy = proxy !== undefined ? proxy : proxyFromEnv();
    this.allowInsecure = allowInsecure;
    this.caFile = caFile;
    this.verbose = verbose;
    this.signal = signal;
    this.fetch = makeFetcher({
      proxy: this.proxy, allowInsecure, caFile,
      minIntervalMs, label: 'steam', signal,
    });
    this._cache = new Map();
  }

  _log(...a) { if (this.verbose) console.log('[steam]', ...a); }

  /**
   * 单品价格（人民币）。这是 Steam 侧最可靠的数据。
   * @returns {Promise<{ok:boolean, lowest?:number, median?:number, volume?:number, lowestText?:string, raw?:string, error?:string}>}
   */
  async priceOverview(marketHashName, { currency = CNY } = {}) {
    this.signal?.throwIfAborted();
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
      this.signal?.throwIfAborted();
      out = { ok: false, error: e.message };
    }
    this._cache.set(key, out);
    return out;
  }

  /**
   * 搜索市场（用于发现/排序）。注意返回价格是美元，只作参考。
   */
  async search({ query = '', start = 0, count = 20, sortColumn = 'price', sortDir = 'asc', exterior = null, language = null } = {}) {
    const p = new URLSearchParams({
      appid: '730', norender: '1', count: String(count), start: String(start),
      sort_column: sortColumn, sort_dir: sortDir,
    });
    if (query) p.set('query', query);
    if (language) p.set('l', language);
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
          localizedName: it.asset_description?.market_name || it.name || null,
          sellListings: it.sell_listings,
          priceText: it.sell_price_text,
          priceUsd: it.sell_price != null ? it.sell_price / 100 : null,
          appIcon: it.app_icon,
        })),
      };
    } catch (e) {
      this.signal?.throwIfAborted();
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
   * 新版前端支持 assetproperty（protobuf/base64）区间过滤，
   * 也支持 sort=1&propertyid=2 按磨损排序。仍逐笔核验实际身份与磨损。
   *
   * @param {object} opts
   *   pages   抓多少页（每页 20 笔，默认 3）
   *   cookies 可选，带上登录态可降低风控概率
   * @returns {Promise<{ok:boolean, listings:Array, error?:string, diag?:object, pagesFetched?:number}>}
   */
  async listingsWithFloats(marketHashName, { cookies = null, pages = 3, resumeState = null,
    minPaintwear = null, maxPaintwear = null, sortBy = 'price', retainOutOfBand = false,
    allowOtherExteriors = false, randomPages = 0, onPage = () => {}, onWork = () => {} } = {}) {
    resumeState ||= {};
    const params = listingQuery(marketHashName, minPaintwear, maxPaintwear, sortBy);
    const signature = `${marketHashName}?${params}${retainOutOfBand ? '&retainOutOfBand=1' : ''}${allowOtherExteriors ? '&allExteriors=1' : ''}&randomPages=${randomPages}`;
    if (resumeState) {
      if (resumeState.signature && resumeState.signature !== signature) {
        resumeState.listings = []; resumeState.nextPage = 0; delete resumeState.baseUrl;
        delete resumeState.exhausted; delete resumeState.complete;
        delete resumeState.sampledPages; delete resumeState.fetchedPages; delete resumeState.totalPages;
        delete resumeState.sampleComplete;
      }
      resumeState.signature = signature;
    }
    const collected = Array.isArray(resumeState?.listings) ? [...resumeState.listings] : [];
    const seen = new Set();
    for (const l of collected) if (l?.listingId) seen.add(l.listingId);
    let diag = null;
    let pagesFetched = 0;
    let rateLimited = false;
    let stoppedEarly = false;

    const requestedPages = Math.max(1, pages);
    const randomTarget = Math.max(0, Math.floor(Number(randomPages) || 0));
    const firstPage = Math.max(0, Number(resumeState.nextPage) || 0);
    const fetchedPages = new Set(resumeState.fetchedPages || []);
    let pageQueue = randomTarget
      ? (resumeState.sampledPages || [0]).filter(page => !fetchedPages.has(page))
      : Array.from({ length: Math.max(0, requestedPages - firstPage) }, (_, i) => firstPage + i);
    if (resumeState.sampleComplete || resumeState.exhausted) return { ok: true, listings: collected, pagesFetched: 0 };
    for (const page of pageQueue) {
      this.signal?.throwIfAborted();
      onWork({ type: 'pageStart', page: page + 1 });
      const start = page * 20;
      const base = resumeState?.baseUrl || `${ORIGIN}/market/listings/730/${encodeURIComponent(marketHashName)}`;
      const query = new URLSearchParams(params);
      if (start) query.set('start', String(start));
      const url = `${base}${query.size ? `?${query}` : ''}`;
      const headers = {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: `${ORIGIN}/market/`,
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      };
      if (cookies) headers.cookie = cookies;

      let r;
      try {
        r = await this.fetch(url, { headers, retries: 2, timeoutMs: 40000 });
        // 英文名可能跳转到 G... 聚合页并丢掉查询参数；在最终地址重新应用过滤。
        if (r.status === 200 && r.finalUrl && query.size) {
          const resolved = new URL(r.finalUrl);
          if ([...query].some(([key, value]) => resolved.searchParams.get(key) !== value)) {
            for (const [key, value] of query) resolved.searchParams.set(key, value);
            r = await this.fetch(resolved.toString(), { headers, retries: 2, timeoutMs: 40000 });
          }
          if (resumeState) resumeState.baseUrl = `${resolved.origin}${resolved.pathname}`;
        }
      } catch (e) {
        this.signal?.throwIfAborted();
          if (page === 0 && !collected.length) return { ok: false, error: `请求挂单页失败：${e.message}`, listings: [] };
          if (resumeState) { resumeState.listings = collected; resumeState.nextPage = page; }
          return { ok: true, partial: true, error: `请求挂单页失败：${e.message}`, listings: collected, pagesFetched };
      }

      // 500/429/503 是 Steam（或中间人）在**限流**，不是"网络不通"，
      // 也不该归咎于没配代理。这里退避重试；仍失败就如实标注为限流。
      if (r.status === 500 || r.status === 429 || r.status === 503) {
        let recovered = false;
        for (let att = 0; att < 3 && !recovered; att++) {
          await delay(6000 * (att + 1) + Math.random() * 2000, undefined, { signal: this.signal });
          try {
            const r2 = await this.fetch(url, { headers, retries: 0, timeoutMs: 40000 });
            if (r2.status === 200) { r = r2; recovered = true; }
          } catch { this.signal?.throwIfAborted(); /* 继续退避 */ }
        }
        if (!recovered) {
          rateLimited = true;
          if (page === 0 && !collected.length) {
            return {
              ok: false, status: r.status, rateLimited: true,
              error: `Steam 返回 ${r.status}（限流）—— 请求太快，与代理配置无关。请稍后重试，或减少抓取页数。`,
              listings: [], htmlLen: (r.body || '').length,
            };
          }
          if (resumeState) { resumeState.listings = collected; resumeState.nextPage = page; }
          return { ok: true, partial: true, rateLimited: true, status: r.status,
            error: `Steam 返回 ${r.status}（限流）`, listings: collected, pagesFetched };
        }
      }

      const html = r.body || '';
      if (r.status !== 200) {
        if (page === 0 && !collected.length) {
          return { ok: false, status: r.status, error: `HTTP ${r.status}`, listings: [], htmlLen: html.length };
        }
        if (resumeState) { resumeState.listings = collected; resumeState.nextPage = page; }
        return { ok: true, partial: true, error: `HTTP ${r.status}`, listings: collected, pagesFetched };
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
        if (page === 0 && !collected.length) {
          return {
            ok: false, error: `页面结构无法解析（${parsed.error}）`, diag, listings: [],
          };
        }
        if (resumeState) { resumeState.listings = collected; resumeState.nextPage = page; }
        return { ok: true, partial: true, error: `页面结构无法解析（${parsed.error}）`, listings: collected, pagesFetched };
      }

      if (parsed.rawTotal != null) resumeState.totalPages = Math.ceil(parsed.rawTotal / 20);
      const allRows = [...parsed.listings, ...parsed.pendingListings];
      for (const l of allRows) {
        if (!steamListingMatches(l, marketHashName, { allowOtherExteriors })) continue;
        if (!retainOutOfBand && ((minPaintwear != null && l.floatvalue < minPaintwear) ||
            (maxPaintwear != null && l.floatvalue > maxPaintwear))) continue;
        if (seen.has(l.listingId)) continue;
        seen.add(l.listingId);
        collected.push(l);
      }
      if (randomTarget && page === 0 && !resumeState.sampledPages) {
        if (resumeState.totalPages) resumeState.sampledPages = samplePages(resumeState.totalPages, randomTarget);
        else if (parsed.rawCount === 0) resumeState.sampledPages = [0];
        else {
          resumeState.listings = collected;
          return { ok: true, partial: true, listings: collected, error: 'Steam 未提供总页数，无法随机抽页；已保留第一页，可继续重试。' };
        }
        pageQueue.push(...resumeState.sampledPages.filter(p => p !== 0 && !fetchedPages.has(p)));
      }
      pagesFetched++;
      onWork({ type: 'pageDone', page: page + 1, totalPages: randomTarget
        ? Math.min(randomTarget, resumeState.totalPages || randomTarget) : resumeState.totalPages || null });
      // 每页成功后立即落盘到材料检查点；下一页超时/中断时，继续操作从下一页开始，
      // 不重新抓取已经完成的页面。
      if (resumeState) {
        resumeState.listings = collected;
        resumeState.nextPage = page + 1;
        if (randomTarget) { fetchedPages.add(page); resumeState.fetchedPages = [...fetchedPages]; }
      }
      if (await onPage(collected) === false) { stoppedEarly = true; break; }

      // 聚合页可能整页都是其它档位，不能因过滤后为空就误判到底。
      if (parsed.rawCount === 0 && !randomTarget) { resumeState.exhausted = true; break; }
      // 已抓到的数量达到总量也停
      if (parsed.rawTotal && !randomTarget && start + 20 >= parsed.rawTotal) {
        if (resumeState) resumeState.exhausted = true;
        break;
      }
    }

    if (resumeState) {
      resumeState.listings = collected;
      if (!stoppedEarly && !resumeState.exhausted && !randomTarget) resumeState.nextPage = requestedPages;
      if (randomTarget && resumeState.sampledPages?.every(p => fetchedPages.has(p))) resumeState.sampleComplete = true;
    }
    return {
      ok: true,
      listings: collected,
      diag,
      pagesFetched,
      rateLimited,
      stoppedEarly, sampleComplete: resumeState.sampleComplete || false,
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
