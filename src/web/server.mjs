/**
 * 本地 Web 服务：输入 CS2UP 配方分享链接 → 自动读取配方 → 搜索 10 把材料的真实挂单。
 *
 * 端点：
 *   GET  /                页面
 *   GET  /api/health      健康检查
 *   GET  /api/resolve?url=...&band=...   以 SSE 流式推送进度与结果
 *
 * 说明：这里之所以要一个服务端，是因为浏览器不能直接跨域读 cs2up.cn 的接口，
 * 也不能带 buff 的登录态去抓挂单 —— 这两件事都在服务端做。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fetchShareRecipe } from '../cs2up/recipe.mjs';
import { inferCollection, findCollectionName, materialsInCollection, listCollections } from '../cs2up/materials.mjs';
import { RecipeResolver } from '../market/resolve.mjs';
import { CollectionHunter } from '../market/hunter.mjs';
import { SteamMarket } from '../market/steam.mjs';
import { proxyFromEnv, findLocalProxy, parseProxyUrl } from '../util/net.mjs';
import { hasCookies, loadCookies, loadCookiesDetailed } from '../auth/session.mjs';
import { verifySteamSession, verifyCsfloatToken, parseSteamLoginSecure, saveCsfloatCreds } from '../auth/steam-login.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.CS2_WEB_PORT || 8788);
const HOST = '127.0.0.1';

let busy = false;

/** 读取 POST 的 JSON body（带上限） */
function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

/**
 * 解析用户粘贴的 Cookie。支持三种格式（与 scripts/set-cookies.mjs 一致）：
 *   1) DevTools 的 Cookie 请求头：  a=1; b=2
 *   2) Cookie-Editor 导出的 JSON 数组
 *   3) 每行一条 name=value
 */
function parseCookieInput(raw, domain) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      const arr = Array.isArray(o) ? o : (o.cookies || []);
      const out = [];
      for (const c of arr) {
        const name = c.name ?? c.Name;
        const value = c.value ?? c.Value;
        if (!name || value == null) continue;
        out.push({ domain: c.domain || c.Domain || domain, name: String(name), value: String(value), path: c.path || '/', secure: true, httpOnly: false });
      }
      if (out.length) return out;
    } catch { /* 落到下面按 header 解析 */ }
  }
  const out = [];
  for (const part of text.split(/[;\n\r]+/)) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (!name || /^cookie$/i.test(name)) continue;
    out.push({ domain, name, value, path: '/', secure: true, httpOnly: false });
  }
  return out;
}

/** 把 cookie 写进 data/ 下，供 auth/session.mjs 统一读取 */
function writeCookieFile(site, cookies) {
  const file = path.join(DATA_DIR, `cookies.manual.${site}.json`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    exportedAt: new Date().toISOString(),
    source: 'web-ui',
    site,
    counts: { total: cookies.length },
    cookies,
  }, null, 2), { mode: 0o600 });
  return file;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

const sse = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

async function handleResolve(req, res, url) {
  const link = url.searchParams.get('url') || '';
  const band = Math.max(0.001, Math.min(0.2, Number(url.searchParams.get('band') || 0.02)));
  const intervalMs = Math.max(1200, Math.min(8000, Number(url.searchParams.get('interval') || 2200)));

  sseHead(res);
  const t0 = Date.now();
  const send = (event, data) => sse(res, event, { ...data, t: Date.now() - t0 });

  if (busy) {
    send('error', { message: '已有任务在跑，请等它结束。' });
    res.end();
    return;
  }
  busy = true;

  try {
    // 登录态检查（buff 搜索接口必须登录）
    if (!hasCookies('buff')) {
      send('error', {
        message: 'BUFF 登录态缺失。请先运行：powershell -File scripts\\set-cookies.ps1 -Site buff',
        code: 'no_cookie',
      });
      return;
    }

    send('stage', { stage: 'recipe', message: '正在读取 CS2UP 配方 ...' });
    const recipe = await fetchShareRecipe(link);
    if (!recipe.ok) {
      send('error', { message: recipe.message, code: recipe.error });
      return;
    }
    send('recipe', {
      recipe: {
        sid: recipe.sid,
        title: recipe.title,
        subtitle: recipe.subtitle,
        recipeLine: recipe.recipeLine,
        matchup: recipe.matchup,
        statTrak: recipe.statTrak,
        inputRarityLabel: recipe.inputRarityLabel,
        outputRarityLabel: recipe.outputRarityLabel,
        collections: recipe.collections,
        metrics: recipe.metrics,
        totalCount: recipe.totalCount,
        targetWear: recipe.targetWear,
        materials: recipe.materials,
        outputs: recipe.outputs,
      },
    });

    send('stage', { stage: 'materials', message: `开始搜索 ${recipe.materials.length} 种材料的真实挂单 ...` });

    const resolver = new RecipeResolver({ intervalMs, verbose: false });
    const TIMEOUT_MS = 6 * 60 * 1000;
    const guard = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('搜索超时（6 分钟）')), TIMEOUT_MS));

    const resolved = await Promise.race([
      resolver.resolveRecipe(recipe, {
        band,
        onProgress: msg => send('progress', { message: msg }),
      }),
      guard,
    ]);

    send('result', {
      materials: resolved.materials.map(m => ({
        name: m.name,
        count: m.count,
        targetWear: m.targetWear,
        collection: m.collection,
        unitPrice: m.unitPrice,
        ok: m.ok,
        error: m.error || null,
        message: m.message || null,
        note: m.note || null,
        goods: m.goods ? { goodsId: m.goods.goodsId, name: m.goods.name, url: `https://buff.163.com/goods/${m.goods.goodsId}`, fuzzy: !!m.goods.fuzzy } : null,
        range: m.range || null,
        totalListings: m.totalListings ?? null,
        candidates: (m.candidates || []).slice(0, 12).map(c => ({
          orderId: c.orderId, price: c.price, paintwear: c.paintwear, paintwearRaw: c.paintwearRaw,
          wearDelta: c.wearDelta, norm: c.norm, assetId: c.assetId,
          url: c.buyUrl, inspectUrl: c.inspectUrl, tradable: c.tradable,
        })),
      })),
      outputs: resolved.outputs,
      crossCheck: resolved.crossCheck || null,
      warnings: resolved.warnings,
    });

    send('done', { elapsedMs: Date.now() - t0 });
  } catch (e) {
    send('error', { message: e?.message || String(e) });
  } finally {
    busy = false;
    res.end();
  }
}

/**
 * 从配方里定位「收藏品 + 材料档位」。
 *
 * CS2UP 给的是英文收藏品名（The Genesis Collection），本地材料库是中文（创世纪收藏品），
 * 直接按名字匹配对不上。所以用**配方里那些皮肤的中文名**去反查它们属于哪个收藏品，
 * 再用材料档位投票选出唯一答案。
 */
function locateCollection(recipe) {
  const names = [
    ...recipe.materials.map(m => m.name),
    ...recipe.outputs.map(o => o.name),
  ];
  // 材料档位：优先用配方标称的 input_rarity，其次由产物档位推下一档
  const grade = recipe.inputRarity || null;
  let collection = inferCollection(names, grade);
  if (!collection) {
    for (const o of recipe.outputs) {
      collection = findCollectionName(o.collection);
      if (collection) break;
    }
  }
  if (!collection) return { ok: false, error: 'collection_not_found', message: `无法从配方定位收藏品（配方标称 ${recipe.collections?.join(', ') || '未知'}）。` };

  const mats = materialsInCollection(collection, grade);
  if (!mats.length) {
    return {
      ok: false, error: 'no_materials',
      message: `收藏品「${collection}」里没有 ${grade} 档的皮肤。`,
    };
  }
  return { ok: true, collection, grade, materialCount: mats.length, materials: mats.map(m => m.name) };
}

/**
 * 用 Steam 给配方里的材料补充「Steam 最低价」，用于跨市场比价。
 * 只读不写：不改动配方，只在每把材料上挂一个 steam 字段。
 */
async function attachSteamPrices(recipes, { allowInsecure = true, proxy = undefined, onProgress = () => {} } = {}) {
  const steam = new SteamMarket({ minIntervalMs: 1600, allowInsecure, proxy, verbose: false });
  const nameCache = new Map();
  // 收集所有需要查的 market_hash_name（同一件商品只查一次）
  const names = new Set();
  for (const rec of recipes) for (const m of rec.materials) if (m.marketHashName) names.add(m.marketHashName);

  onProgress(`向 Steam 查询 ${names.size} 个商品的价格 ...`);
  for (const n of names) {
    const r = await steam.priceOverview(n);
    nameCache.set(n, r);
    if (r.ok) onProgress(`  ${n} → Steam 最低 ${r.lowestText}`);
    else onProgress(`  ${n} → Steam 无数据（${r.error}）`);
  }

  let cheaperOnSteam = 0;      // 配方里「Steam 更便宜」的材料位置数
  let distinctCheaper = 0;     // 查询的商品里，Steam 更便宜的**商品**数
  for (const [n, r] of nameCache) {
    if (!r.ok || r.lowest == null) continue;
    // 找该商品在配方里的任意一个 BUFF 价格做对比
    let bufPrice = null;
    for (const rec of recipes) {
      const m = rec.materials.find(x => x.marketHashName === n && x.price != null);
      if (m) { bufPrice = m.price; break; }
    }
    if (bufPrice != null && r.lowest < bufPrice) distinctCheaper++;
  }

  for (const rec of recipes) {
    for (const m of rec.materials) {
      const s = m.marketHashName ? nameCache.get(m.marketHashName) : null;
      if (!s || !s.ok) { m.steam = { ok: false, error: s?.error || 'no_name' }; continue; }
      m.steam = {
        ok: true, lowest: s.lowest, lowestText: s.lowestText, volume: s.volume,
        cheaper: s.lowest != null && m.price != null && s.lowest < m.price,
      };
      if (m.steam.cheaper) cheaperOnSteam++;
    }
    // 按「哪边便宜买哪边」估算总成本
    rec.costIfCheapest = rec.materials.reduce((a, m) => {
      const sp = m.steam?.ok && m.steam.lowest != null ? m.steam.lowest : Infinity;
      const bp = m.price ?? Infinity;
      return a + Math.min(sp, bp);
    }, 0);
  }
  // 返回时顺便带上「商品维度」的比价结果，避免把“材料位置数”误当成“商品数”
  return { steam, nameCache, cheaperOnSteam, distinctCheaper, queried: names.size };
}

/**
 * 为配方里的材料补充「Steam 上的逐笔精确磨损」，挑出最接近我们需要的那个 float 的挂单。
 *
 * 这里必须说清楚一个现实限制：**Steam 挂单页是按价格排序的，不是按磨损排序的**，
 * 而且未登录只能看到有限几页。所以「Steam 上恰好有一笔落在我们需要的 float 附近」
 * 是运气问题 —— 找不到时如实报告，不做任何假装。
 */
async function attachSteamListings(recipes, { allowInsecure = true, proxy = undefined, marketHashNames = null, onProgress = () => {} } = {}) {
  const steam = new SteamMarket({ minIntervalMs: 2500, allowInsecure, proxy, verbose: false });
  const cookieHeader = steamCookieHeader();

  // 去重：同一件商品只抓一次挂单页
  const names = new Set();
  for (const rec of recipes) {
    for (const m of rec.materials) {
      if (!m.marketHashName) continue;
      if (marketHashNames && !marketHashNames.has(m.marketHashName)) continue;
      names.add(m.marketHashName);
    }
  }

  onProgress(`Steam：准备抓取 ${names.size} 个商品的挂单页并解码逐笔磨损 ...`);
  const cache = new Map();
  for (const n of names) {
    const r = await steam.listingsWithFloats(n, { cookies: cookieHeader });
    if (!r.ok) {
      cache.set(n, { ok: false, error: r.error, diag: r.diag || null });
      onProgress(`  ${n} → 失败：${r.error}`);
      continue;
    }
    const withFloat = r.listings.filter(l => l.floatvalue != null);
    cache.set(n, { ok: true, listings: r.listings, withFloat: withFloat.length, total: r.listings.length });
    onProgress(`  ${n} → ${r.listings.length} 笔挂单，其中 ${withFloat.length} 笔解出了磨损`);
  }

  let matched = 0, withFloatTotal = 0;
  for (const rec of recipes) {
    for (const m of rec.materials) {
      const c = m.marketHashName ? cache.get(m.marketHashName) : null;
      if (!c || !c.ok) { m.steamListing = { ok: false, error: c?.error || 'no_name', diag: c?.diag || null }; continue; }
      withFloatTotal += c.withFloat;
      // 在解出 float 的挂单里，找最接近「该材料所需磨损」的那一笔
      const cands = c.listings.filter(l => l.floatvalue != null);
      if (!cands.length) {
        m.steamListing = { ok: true, candidates: 0, total: c.total, note: '该商品在 Steam 上没有解出磨损的挂单' };
        continue;
      }
      let best = null;
      for (const l of cands) {
        const delta = Math.abs(l.floatvalue - m.paintwear);
        if (!best || delta < best.delta) best = { ...l, delta };
      }
      matched++;
      m.steamListing = {
        ok: true,
        candidates: cands.length,
        total: c.total,
        best: {
          floatvalue: best.floatvalue,
          delta: best.delta,
          price: best.price,
          priceText: best.priceText,
          listingId: best.listingId,
          assetId: best.assetId,
          url: best.url,
        },
        // 是否足够接近（1e-5 以内才算"能替代"）
        usable: best.delta < 1e-5,
      };
    }
  }
  return { steam, queried: names.size, matched, withFloatTotal };
}

/** 读 Steam 的登录态并拼成 Cookie 头（没有就返回 null） */
function steamCookieHeader() {
  try {
    const list = loadCookies('steam');
    if (!list.length) return null;
    return list.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return null; }
}

/**
 * 端点：/api/hunt?url=<配方链接>&wear=<想要的产物磨损>&band=&interval=&market=buff|steam|both
 *
 * 与 /api/resolve 的区别：
 *   resolve = 照抄配方里每把材料的目标磨损，去找最接近的真实挂单
 *   hunt    = 只借用配方定位「收藏品 + 材料档位」，然后在其中凑出 10 把能打出**你指定磨损**的皮肤
 *
 * market 参数控制「检索范围」：
 *   buff  = 只搜 BUFF（唯一能提供逐笔精确磨损的来源）
 *   steam = 只搜 Steam（只有每件商品的最低价，拿不到逐笔磨损，用于比价）
 *   both  = 以 BUFF 求解，同时拉 Steam 价格做对比，并给出「哪边便宜买哪边」的总价
 */
async function handleHunt(req, res, url) {
  const link = url.searchParams.get('url') || '';
  const wearRaw = url.searchParams.get('wear');
  const targetWear = Number(wearRaw);
  const band = Math.max(0.002, Math.min(0.15, Number(url.searchParams.get('band') || 0.03)));
  const intervalMs = Math.max(1200, Math.min(8000, Number(url.searchParams.get('interval') || 2200)));
  const statTrak = url.searchParams.get('stattrak') === '1';
  const market = (url.searchParams.get('market') || 'buff').toLowerCase();
  const allowInsecure = url.searchParams.get('insecure') !== '0';
  // 页面可显式指定代理；留空则交给适配器读环境变量/自动探测
  // 支持 http:// 与 socks5:// 前缀；不写前缀按 http 处理
  const proxyParam = url.searchParams.get('proxy');
  const proxy = proxyParam ? parseProxyUrl(proxyParam) : undefined;

  sseHead(res);
  const t0 = Date.now();
  const send = (event, data) => sse(res, event, { ...data, t: Date.now() - t0 });

  if (busy) { send('error', { message: '已有任务在跑，请等它结束。' }); res.end(); return; }
  busy = true;

  try {
    if (!wearRaw || !Number.isFinite(targetWear) || targetWear <= 0 || targetWear >= 1) {
      send('error', { message: '请填写想要的产品磨损值（0 到 1 之间的小数，例如 0.2）', code: 'bad_wear' });
      return;
    }
    if (!hasCookies('buff')) {
      send('error', { message: 'BUFF 登录态缺失。请先运行：powershell -File scripts\\set-cookies.ps1 -Site buff', code: 'no_cookie' });
      return;
    }

    send('stage', { stage: 'recipe', message: '正在读取 CS2UP 配方，用于确定收藏品 ...' });
    const recipe = await fetchShareRecipe(link);
    if (!recipe.ok) { send('error', { message: recipe.message, code: recipe.error }); return; }
    const loc = locateCollection(recipe);
    if (!loc.ok) { send('error', { message: loc.message, code: loc.error }); return; }

    send('located', {
      collection: loc.collection,
      grade: loc.grade,
      materialCount: loc.materialCount,
      materials: loc.materials,
      recipe: {
        title: recipe.title, recipeLine: recipe.recipeLine,
        inputRarityLabel: recipe.inputRarityLabel, outputRarityLabel: recipe.outputRarityLabel,
        statTrak: recipe.statTrak, collections: recipe.collections,
      },
      targetWear,
    });
    send('stage', { stage: 'hunt', message: `在「${loc.collection}」${loc.grade} 档里搜索能打出 ${targetWear} 的 10 把材料 ...` });

    const hunter = new CollectionHunter({ intervalMs, verbose: false });
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('搜索超时（15 分钟）')), 15 * 60 * 1000));

    // 「仅 Steam」= 真的只用 Steam 的挂单来求解。
    // 注意这条路径没有 BUFF 兜底：Steam 拿不到就明确失败，绝不偷偷换成 BUFF 的数据。
    let r, steamListingInfo = null;
    if (market === 'steam') {
      const steam = new SteamMarket({ minIntervalMs: 2500, allowInsecure, proxy, verbose: false });
      const sh = await steam.health().catch(e => ({ ok: false, error: e.message }));
      if (!sh.ok) {
        const local = await findLocalProxy().catch(() => null);
        send('error', {
          message: `「仅 Steam」模式需要能访问 Steam，但当前连不上：${JSON.stringify(sh.sample || sh.error)}。` +
            `请在页面上填写可用代理（自动探测到：${local ? `${local.type}://${local.host}:${local.port}` : '无'}）。` +
            `提示：本地 7890 端口实测无监听，7897 是 SteamTools 的拦截器、不是通用代理。`,
          code: 'steam_unreachable',
        });
        return;
      }
      send('stage', { stage: 'steam', message: '「仅 Steam」模式：只用 Steam 挂单求解（无 BUFF 兜底）' });
      r = await Promise.race([
        hunter.huntFromSteam({
          collectionName: loc.collection, materialGrade: loc.grade,
          targetWear, statTrak, band, count: 10, steam, maxItems: 40,
        }, { onProgress: m => send('progress', { message: m }), timeBudgetMs: 40000, wants: 5 }),
        guard,
      ]);
    } else {
      r = await Promise.race([
        hunter.hunt({
          collectionName: loc.collection, materialGrade: loc.grade,
          targetWear, statTrak, band, count: 10,
        }, { onProgress: m => send('progress', { message: m }), timeBudgetMs: 40000, wants: 5 }),
        guard,
      ]);
    }

    if (!r.ok) {
      send('error', {
        message: r.message,
        code: r.error,
        detail: { perItem: r.perItem || null, skippedRanges: r.skippedRanges || null },
      });
      return;
    }
    send('progress', { message: `数据来源：${r.dataSource === 'steam' ? 'Steam（挂单与磨损均来自 Steam）' : 'BUFF'}` });

    // BUFF 路径下，检索范围含 steam 时补逐笔磨损与比价
    if (market === 'both') {
      send('stage', { stage: 'steam', message: '正在抓 Steam 挂单页并解码每一笔的精确磨损 ...' });
      try {
        const sl = await attachSteamListings(r.recipes, {
          allowInsecure, proxy,
          onProgress: m => send('progress', { message: m }),
        });
        steamListingInfo = { queried: sl.queried, matched: sl.matched, withFloat: sl.withFloatTotal };
      } catch (e) {
        steamListingInfo = { error: e.message };
        send('progress', { message: `Steam 逐笔磨损抓取失败：${e.message}` });
      }
    }

    let steamInfo = null;
    if (market === 'both') {
      send('stage', { stage: 'steam', message: '正在向 Steam 查询这些商品的价格（用于比价）...' });
      try {
        const s = await attachSteamPrices(r.recipes, { allowInsecure, proxy, onProgress: m => send('progress', { message: m }) });
        steamInfo = { queried: s.queried, cheaperOnSteam: s.cheaperOnSteam, distinctCheaper: s.distinctCheaper };
        send('progress', { message: `Steam 比价完成：共查询 ${s.queried} 个商品，其中 ${s.distinctCheaper} 个在 Steam 上更便宜` });
      } catch (e) {
        steamInfo = { error: e.message };
        send('progress', { message: `Steam 比价失败：${e.message}` });
      }
    }

    send('result', {
      market,
      // 顶层标明这批结果的数据来源，避免用户误以为「仅 Steam」出来的数字是 Steam 的
      dataSource: r.dataSource || 'buff',
      dataSourceNote: r.dataSource === 'steam'
        ? '挂单与磨损均来自 Steam（本地解码检视链接），未使用 BUFF 挂单'
        : (market === 'both'
          ? '求解用 BUFF 挂单；Steam 仅作逐笔磨损与价格比对'
          : '挂单与磨损均来自 BUFF'),
      steamItems: r.steamItems || null,
      steamInfo,
      steamListingInfo,
      collection: r.collectionName,
      grade: r.materialGrade,
      outRange: r.outRange,
      usableRanges: r.usableRanges,
      skippedRanges: r.skippedRanges,
      band: r.band,
      poolSize: r.poolSize,
      materialCount: r.materialCount,
      exactFound: r.exactFound,
      bestScore: r.bestScore,
      ieee754: r.ieee754,
      targetWear,
      recipes: r.recipes,
    });
    send('done', { elapsedMs: Date.now() - t0 });
  } catch (e) {
    send('error', { message: e?.message || String(e) });
  } finally {
    busy = false;
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch { return json(res, 400, { ok: false, error: 'bad url' }); }

  if (url.pathname === '/api/health') {
    const { cookies, sources } = loadCookiesDetailed('buff');
    const steam = loadCookiesDetailed('steam');
    const local = await findLocalProxy().catch(() => null);
    return json(res, 200, {
      ok: true,
      service: 'cs2-float-hunter',
      busy,
      buffCookies: cookies.length,
      steamCookies: steam.cookies.length,
      cookieSources: sources.map(s => s.label),
      envProxy: proxyFromEnv(),
      localProxy: local,
      now: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/cookies' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = { ok: true };
      if (body.buff != null && String(body.buff).trim()) {
        const c = parseCookieInput(body.buff, '.buff.163.com');
        if (!c.length) { return json(res, 400, { ok: false, error: 'BUFF Cookie 解析不出任何字段' }); }
        writeCookieFile('buff', c);
        result.buff = c.length;
      }
      if (body.steam != null && String(body.steam).trim()) {
        const rawSteam = String(body.steam).trim();
        // 特例：用户常常只粘 steamLoginSecure 的**值本身**（形如 <steamid64>%7C%7C<token>），
        // 它没有 name=value 结构，通用解析会把它当垃圾丢掉，所以要先单独识别。
        const bareLogin = (!rawSteam.includes(';') && !/[\r\n]/.test(rawSteam))
          ? parseSteamLoginSecure(rawSteam) : null;

        let c = parseCookieInput(rawSteam, 'steamcommunity.com');
        if (bareLogin) {
          c = [
            { domain: 'steamcommunity.com', name: 'steamLoginSecure', value: bareLogin.raw, path: '/', secure: true, httpOnly: true },
            { domain: 'steamcommunity.com', name: 'sessionid', value: Math.random().toString(36).slice(2), path: '/', secure: true, httpOnly: false },
          ];
          result.note = '识别为单独的 steamLoginSecure 值，已补成完整 Cookie';
        } else if (!c.some(x => x.name === 'steamLoginSecure')) {
          const parsed = parseSteamLoginSecure(rawSteam);
          if (parsed) {
            c.push({ domain: 'steamcommunity.com', name: 'steamLoginSecure', value: parsed.raw, path: '/', secure: true, httpOnly: true });
            result.note = '已把其中的 steamLoginSecure 值补成完整 Cookie';
          }
        }
        if (!c.length) {
          return json(res, 400, {
            ok: false,
            error: 'Steam 登录态解析不出任何字段。请粘贴完整 Cookie 整行，或直接粘贴 steamLoginSecure 的值（形如 7656119xxxxxxxxx%7C%7C<十六进制>）。',
          });
        }
        writeCookieFile('steam', c);
        result.steam = c.length;
        const cookieHeader = c.map(x => `${x.name}=${x.value}`).join('; ');
        result.steamVerify = await verifySteamSession(cookieHeader, { allowInsecure: true });
      }
      if (body.csfloatToken != null && String(body.csfloatToken).trim()) {
        const tok = String(body.csfloatToken).trim();
        result.csfloatVerify = await verifyCsfloatToken(tok, { allowInsecure: true });
        if (result.csfloatVerify.ok) saveCsfloatCreds({ csfloatToken: tok });
        else result.csfloatTokenSaved = false;
      }
      const b = loadCookiesDetailed('buff').cookies.length;
      const s = loadCookiesDetailed('steam').cookies.length;
      result.buffTotal = b;
      result.steamTotal = s;
      return json(res, 200, result);
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/resolve') {
    return handleResolve(req, res, url);
  }

  if (url.pathname === '/api/hunt') {
    return handleHunt(req, res, url);
  }

  if (url.pathname === '/api/steam-health') {
    const allowInsecure = url.searchParams.get('insecure') !== '0';
    try {
      const s = new SteamMarket({ allowInsecure, verbose: false });
      const h = await s.health();
      return json(res, 200, { ok: true, steam: h });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/collections') {
    return json(res, 200, { ok: true, collections: listCollections() });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(ROOT, 'web', 'index.html');
    if (!fs.existsSync(file)) return json(res, 500, { ok: false, error: 'web/index.html 缺失' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[web] CS2 磨损猎人已启动: http://${HOST}:${PORT}`);
  const { cookies } = loadCookiesDetailed('buff');
  console.log(`[web] BUFF 登录态: ${cookies.length ? `${cookies.length} 条 cookie ✓` : '缺失 ✗（请先运行 scripts/set-cookies.ps1 -Site buff）'}`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
