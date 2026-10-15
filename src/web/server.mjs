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
import { randomUUID } from 'node:crypto';
import { fetchShareRecipe } from '../cs2up/recipe.mjs';
import { listCollections } from '../cs2up/materials.mjs';
import { locateCollection, planWithQuality } from '../cs2up/location.mjs';
import { RecipeResolver } from '../market/resolve.mjs';
import { CollectionHunter } from '../market/hunter.mjs';
import { SteamMarket } from '../market/steam.mjs';
import { proxyFromEnv, findLocalProxy, parseProxyUrl } from '../util/net.mjs';
import { hasCookies, loadCookiesDetailed } from '../auth/session.mjs';
import { verifySteamSession, verifyCsfloatToken, saveCsfloatCreds } from '../auth/steam-login.mjs';
import { prepareLoginInputs, verifyBuffSession } from '../auth/login-input.mjs';
import { marketAccess, normalizeMarket } from '../market/access.mjs';
import { SearchTasks } from './search-tasks.mjs';
import { SearchEta } from './search-eta.mjs';
import { SearchResults } from './search-results.mjs';
import { normalizeExteriors } from '../market/exteriors.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.CS2_WEB_PORT || 8788);
const HOST = '127.0.0.1';

const tasks = new SearchTasks();
const huntCheckpoints = new Map();
const searchResults = new SearchResults(process.env.CS2_SEARCH_RESULTS_DIR || path.join(DATA_DIR, 'search-results'));
const HUNT_TIMEOUT_MS = 15 * 60 * 1000;
const HUNT_SOLVER_BUDGET_MS = 40 * 1000;

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
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

async function handleResolve(req, res, url) {
  const link = url.searchParams.get('url') || '';
  const band = Math.max(0.001, Math.min(0.2, Number(url.searchParams.get('band') || 0.02)));
  const intervalMs = Math.max(1200, Math.min(8000, Number(url.searchParams.get('interval') || 2200)));

  sseHead(res);
  const t0 = Date.now();
  const send = (event, data) => sse(res, event, { ...data, t: Date.now() - t0 });

  if (tasks.busy) {
    send('error', { message: '已有任务在跑，请等它结束。' });
    res.end();
    return;
  }
  const task = tasks.start(res, url.searchParams.get('task_id'));
  if (!task) return;
  const progress = msg => { task.check(); send('progress', { message: msg }); };

  try {
    await task.run(async () => {
      // 登录态检查（buff 搜索接口必须登录）
      if (!hasCookies('buff')) {
        send('error', {
          message: 'BUFF 登录态缺失。请先运行：powershell -File scripts\\set-cookies.ps1 -Site buff',
          code: 'no_cookie',
        });
        return;
      }

      send('stage', { stage: 'recipe', message: '正在读取 CS2UP 配方 ...' });
      const recipe = await fetchShareRecipe(link, { signal: task.signal });
      task.check();
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

      const resolver = new RecipeResolver({ intervalMs, verbose: false, signal: task.signal });
      const resolved = await resolver.resolveRecipe(recipe, {
        band,
        onProgress: progress,
      });
      task.check();

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
    }, 6 * 60 * 1000);
  } catch (e) {
    send('error', { message: e?.message || String(e) });
  } finally {
    task.finish();
  }
}

/**
 * 端点：/api/hunt?url=<配方链接>&wear=<想要的产物磨损>&output_index=<产物索引>&exteriors=fn,mw,ft,ww,bs&interval=&market=buff|steam|both
 *
 * 与 /api/resolve 的区别：
 *   resolve = 照抄配方里每把材料的目标磨损，去找最接近的真实挂单
 *   hunt    = 固定分享配方中的收藏品投入数量，扩展同等级枪皮并按目标磨损求解
 *
 * market 参数控制「检索范围」：
 *   buff  = 只用 BUFF 真实挂单求解
 *   steam = 只用 Steam 真实挂单求解
 *   both  = 两边按同一磨损范围抓取真实挂单，合并求解并展示逐笔价格和购买链接
 */
async function handleHunt(req, res, url) {
  const link = url.searchParams.get('url') || '';
  const wearRaw = url.searchParams.get('wear');
  const targetWear = Number(wearRaw);
  const exteriors = normalizeExteriors(url.searchParams.has('exteriors') ? url.searchParams.get('exteriors') : undefined);
  const randomPages = Number(url.searchParams.get('random_pages') ?? 20);
  const intervalMs = Math.max(1200, Math.min(8000, Number(url.searchParams.get('interval') || 2200)));
  const qualityParam = url.searchParams.get('stattrak');
  const market = normalizeMarket(url.searchParams.get('market'));
  const outputIndexRaw = url.searchParams.get('output_index');
  const outputIndex = outputIndexRaw == null || outputIndexRaw === '' ? 0 : Number(outputIndexRaw);
  const allowInsecure = url.searchParams.get('insecure') !== '0';
  // 页面可显式指定代理；留空则交给适配器读环境变量/自动探测
  // 支持 http:// 与 socks5:// 前缀；不写前缀按 http 处理
  const proxyParam = url.searchParams.get('proxy');
  const proxy = proxyParam ? parseProxyUrl(proxyParam) : undefined;
  const resumeId = url.searchParams.get('resume_id') || '';
  const checkpointSignature = JSON.stringify({
    link, wear: wearRaw, exteriors, intervalMs, randomPages, market, quality: qualityParam || null,
    outputIndex,
  });

  sseHead(res);
  const t0 = Date.now();
  const eta = new SearchEta({ solverMs: HUNT_SOLVER_BUDGET_MS });
  const send = (event, data) => sse(res, event, { ...data, ...eta.snapshot(), t: Date.now() - t0 });
  const sendResume = info => { if (info?.id) send('resume', info); };

  let checkpoint;
  if (resumeId) {
    checkpoint = huntCheckpoints.get(resumeId);
    if (!checkpoint || checkpoint.signature !== checkpointSignature) {
      send('error', { message: '继续搜索失败：恢复状态不存在或搜索条件已改变。请重新开始搜索。', code: 'resume_invalid' });
      res.end();
      return;
    }
  } else {
    checkpoint = { id: randomUUID(), signature: checkpointSignature, items: {}, createdAt: Date.now() };
    huntCheckpoints.set(checkpoint.id, checkpoint);
  }
  const discardCheckpoint = () => {
    if (checkpoint) {
      send('resume', { id: checkpoint.id, canContinue: false, pending: [] });
      huntCheckpoints.delete(checkpoint.id);
    }
  };

  if (tasks.busy) { send('error', { message: '已有任务在跑，请等它结束。' }); res.end(); return; }
  const task = tasks.start(res, url.searchParams.get('task_id'));
  if (!task) return;
  const progress = m => { task.check(); send('progress', { message: m }); };
  const onWork = event => {
    task.check(); eta.update(event);
    if (event.type === 'materialStart') { task.currentMaterialId = event.id; task.skipRequested = false; }
    if (event.type === 'materialEnd' || event.type === 'solver') { task.currentMaterialId = null; task.skipRequested = false; }
    send(event.type === 'materialStart' || event.type === 'materialEnd' ? 'material' : 'eta', event);
  };
  const heartbeat = setInterval(() => send('eta', {}), 2000);

  try {
    await task.run(async () => {
      if (!wearRaw || !Number.isFinite(targetWear) || targetWear <= 0 || targetWear >= 1) {
        send('error', { message: '请填写想要的产品磨损值（0 到 1 之间的小数，例如 0.2）', code: 'bad_wear' });
        discardCheckpoint();
        return;
      }
      if (!exteriors) {
        send('error', { message: '请至少勾选一个有效的磨损品质等级。', code: 'invalid_exteriors' });
        discardCheckpoint(); return;
      }
      if (!Number.isInteger(randomPages) || randomPages < 0 || randomPages > 500) {
        send('error', { message: '随机页数须为 0–500 的整数。', code: 'invalid_search_options' });
        discardCheckpoint(); return;
      }
      send('stage', { stage: 'recipe', message: checkpoint.recipe ? '复用已读取的 CS2UP 配方，继续未完成搜索 ...' : '正在读取 CS2UP 配方中的材料种类与数量 ...' });
      sendResume({ id: checkpoint.id, canContinue: true, pending: [] });
      const recipe = checkpoint.recipe || await fetchShareRecipe(link, { signal: task.signal });
      task.check();
      if (!recipe.ok) { send('error', { message: recipe.message, code: recipe.error }); discardCheckpoint(); return; }
      const located = locateCollection(recipe);
      if (!located.ok) { send('error', { message: located.message, code: located.error }); discardCheckpoint(); return; }
      if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= located.outputSpecs.length) {
        send('error', { message: `目标产物选择无效：索引 ${outputIndexRaw ?? outputIndex} 超出配方产物范围。`, code: 'invalid_output_index' });
        discardCheckpoint(); return;
      }
      const statTrak = qualityParam === '1' ? true : qualityParam === '0' ? false : recipe.statTrak;
      const loc = planWithQuality(located, statTrak, outputIndex);
      checkpoint.recipe = recipe;

      send('located', {
        sid: recipe.sid,
        statTrak,
        collection: loc.collection,
        collections: loc.collections,
        collectionSpecs: loc.collectionSpecs,
        grade: loc.grade,
        materialCount: loc.materialCount,
        materials: loc.materials,
        targetOutput: loc.targetOutput.name,
        targetOutputIndex: loc.targetOutputIndex,
        targetOutputProbability: loc.targetOutput.probability,
        outputs: loc.outputSpecs,
        recipe: {
          title: recipe.title, recipeLine: recipe.recipeLine,
          inputRarityLabel: recipe.inputRarityLabel, outputRarityLabel: recipe.outputRarityLabel,
          statTrak: recipe.statTrak, collections: recipe.collections,
        },
        targetWear,
      });
      send('stage', { stage: 'hunt', message: `搜索链接收藏品中的全部同等级枪皮，固定比例 ${loc.collectionSpecs.map(m => `${m.collection} × ${m.count}`).join('；')}，目标「${loc.targetOutput.name}」磨损 ${targetWear} ...` });

      const hunter = new CollectionHunter({ intervalMs, verbose: false, signal: task.signal });

      // 「仅 Steam」= 真的只用 Steam 的挂单来求解。
      // 注意这条路径没有 BUFF 兜底：Steam 拿不到就明确失败，绝不偷偷换成 BUFF 的数据。
      let r;
      if (market === 'steam') {
        const steam = new SteamMarket({ minIntervalMs: 2500, allowInsecure, proxy, verbose: false, signal: task.signal });
        const sh = await steam.health().catch(e => ({ ok: false, error: e.message }));
        task.check();
        if (!sh.ok) {
          const local = await findLocalProxy().catch(() => null);
          send('error', {
            message: `「仅 Steam」模式需要能访问 Steam，但当前连不上：${JSON.stringify(sh.sample || sh.error)}。` +
              `请在页面上填写可用代理（自动探测到：${local ? `${local.type}://${local.host}:${local.port}` : '无'}）。` +
              `提示：本地 7890 端口实测无监听，7897 是 SteamTools 的拦截器、不是通用代理。`,
            code: 'steam_unreachable',
            resume: { id: checkpoint.id, canContinue: true, pending: [] },
          });
          return;
        }
        const access = marketAccess(market, { hasBuff: hasCookies('buff') });
        if (!access.ok) {
          send('error', { message: access.message, code: access.code });
          return;
        }
        send('stage', { stage: 'steam', message: '「仅 Steam」模式：只用 Steam 挂单求解（无 BUFF 兜底）' });
        r = await hunter.huntFromSteam({
          recipePlan: loc, resumeState: checkpoint,
          collectionName: loc.collection, materialGrade: loc.grade,
          targetWear, statTrak, exteriors, steamRandomPages: randomPages, count: loc.totalCount, steam,
        }, { onProgress: progress, onWork, shouldSkip: () => task.consumeSkip(), timeBudgetMs: HUNT_SOLVER_BUDGET_MS, wants: 5 });
      } else {
        const access = marketAccess(market, { hasBuff: hasCookies('buff') });
        if (!access.ok) {
          send('error', { message: access.message, code: access.code });
          return;
        }
        r = await hunter.hunt({
          dataSource: market === 'both' ? 'both' : 'buff',
          steam: market === 'both' ? new SteamMarket({ minIntervalMs: 2500, allowInsecure, proxy, verbose: false, signal: task.signal }) : undefined,
          recipePlan: loc, resumeState: checkpoint,
          collectionName: loc.collection, materialGrade: loc.grade,
          targetWear, statTrak, exteriors, steamRandomPages: randomPages, count: loc.totalCount,
        }, { onProgress: progress, onWork, shouldSkip: () => task.consumeSkip(), timeBudgetMs: HUNT_SOLVER_BUDGET_MS, wants: 5 });
      }
      task.check();

      if (!r.ok) {
        sendResume(r.resume || { id: checkpoint.id, canContinue: true, pending: [] });
        send('error', {
          message: r.message,
          code: r.error,
          detail: { perItem: r.perItem || null, skippedRanges: r.skippedRanges || null,
            reachableRange: r.reachableRange || null },
          resume: r.resume || { id: checkpoint.id, canContinue: true, pending: [] },
        });
        return;
      }
      send('progress', { message: `数据来源：${r.dataSource === 'both' ? 'BUFF + Steam（两边均搜索真实挂单磨损）' : r.dataSource === 'steam' ? 'Steam（挂单与磨损均来自 Steam）' : 'BUFF'}` });

      task.check();
      const resultPayload = {
        market,
        // 顶层标明这批结果的数据来源，避免用户误以为「仅 Steam」出来的数字是 Steam 的
        dataSource: r.dataSource || 'buff',
        dataSourceNote: r.dataSource === 'steam'
          ? '挂单、磨损与价格均来自 Steam 挂单页（价格为买家实付，含手续费）；搜索同收藏品、同等级枪皮，严格保持链接中的收藏品投入数量，完整磨损区间来自本地材料库'
          : (market === 'both'
            ? 'BUFF 和 Steam 按相同磨损范围搜索真实挂单并合并求解；较便宜的价格加粗，产物磨损与总价按选中挂单计算。另一市场磨损不同的挂单仅作参考。'
            : '挂单与磨损均来自 BUFF'),
        steamItems: r.steamItems || null,
        steamInfo: null,
        steamListingInfo: null,
        collection: r.collectionName,
        grade: r.materialGrade,
        outRange: r.outRange,
        usableRanges: r.usableRanges,
        skippedRanges: r.skippedRanges,
        exteriors: r.exteriors,
        randomPages: r.randomPages,
        poolSize: r.poolSize,
        marketCounts: r.marketCounts,
        statTrak: r.statTrak,
        perItem: r.perItem,
        materialCount: r.materialCount,
        materialBands: r.materialBands,
        collectionBands: r.collectionBands,
        collectionSpecs: r.collectionSpecs,
        targetOutput: r.targetOutput,
        targetOutputIndex: r.targetOutputIndex,
        targetOutputProbability: r.targetOutputProbability,
        exactFound: r.exactFound,
        bestScore: r.bestScore,
        optimization: r.optimization,
        reachableRange: r.reachableRange,
        ieee754: r.ieee754,
        targetWear,
        recipes: r.recipes,
        resume: r.resume || { id: checkpoint.id, canContinue: false, pending: [] },
      };
      try {
        resultPayload.saved = await searchResults.save(resultPayload, {
          link, targetWear, exteriors, randomPages, market, statTrak, outputIndex,
        });
      } catch (e) {
        resultPayload.saveError = `结果保存失败：${e.message}`;
      }
      send('result', resultPayload);
      sendResume(r.resume);
      eta.update({ type: 'done' });
      send('done', { elapsedMs: Date.now() - t0 });
      if (!r.resume?.canContinue) huntCheckpoints.delete(checkpoint.id);
    }, HUNT_TIMEOUT_MS);
  } catch (e) {
    const pending = Array.isArray(checkpoint.pendingMaterials)
      ? checkpoint.pendingMaterials.filter(item => !checkpoint.items[item.id]?.complete)
      : Object.entries(checkpoint.items)
        .filter(([, item]) => !item.complete).map(([id]) => ({ id }));
    const resume = { id: checkpoint.id,
      canContinue: !checkpoint.pendingMaterials || pending.length > 0, pending };
    sendResume(resume);
    const message = e?.name === 'TimeoutError'
      ? '搜索超时，已保留成功材料。请点击“重试失败项（继续）”，只补抓失败或尚未完成的材料。'
      : e?.message || String(e);
    eta.update({ type: 'done' });
    send('error', { message, resume });
  } finally {
    clearInterval(heartbeat);
    task.finish();
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch { return json(res, 400, { ok: false, error: 'bad url' }); }

  if (url.pathname === '/api/search-results' || url.pathname.startsWith('/api/search-results/')) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, message: '仅支持 GET' });
    try {
      if (url.pathname === '/api/search-results') return json(res, 200, { ok: true, items: await searchResults.list() });
      const id = url.pathname.slice('/api/search-results/'.length);
      const item = await searchResults.get(id);
      if (!item) return json(res, 404, { ok: false, message: '搜索记录不存在' });
      if (url.searchParams.get('download') === '1') res.setHeader('content-disposition', `attachment; filename="search-${id}.json"`);
      return json(res, 200, item);
    } catch { return json(res, 500, { ok: false, message: '读取搜索记录失败' }); }
  }

  if (url.pathname === '/api/recipe') {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const recipe = await fetchShareRecipe(url.searchParams.get('url') || '', { signal: controller.signal });
      if (!recipe.ok) return json(res, 400, { ok: false, message: recipe.message });
      const located = locateCollection(recipe);
      if (!located.ok) return json(res, 400, { ok: false, message: located.message, error: located.error });
      const plan = planWithQuality(located, recipe.statTrak);
      return json(res, 200, {
        ok: true, sid: recipe.sid, statTrak: recipe.statTrak,
        outputs: plan.outputSpecs.map((output, index) => ({ ...output, index })),
      });
    } catch (e) {
      if (!controller.signal.aborted) return json(res, 400, { ok: false, message: e.message });
      return;
    }
  }

  if (url.pathname === '/api/health') {
    const { cookies, sources } = loadCookiesDetailed('buff');
    const steam = loadCookiesDetailed('steam');
    const local = await findLocalProxy().catch(() => null);
    return json(res, 200, {
      ok: true,
      service: 'cs2-float-hunter',
      busy: tasks.busy,
      buffCookies: cookies.length,
      steamCookies: steam.cookies.length,
      steamLoginSecureSet: steam.cookies.some(c => c.name === 'steamLoginSecure' && c.value),
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
      const inputs = prepareLoginInputs(body);
      const steamProxy = inputs.steam
        ? (body.proxy ? parseProxyUrl(String(body.proxy)) : (proxyFromEnv() || await findLocalProxy().catch(() => null))) : null;
      // 保存只代表输入格式可用；在线验证结果单独返回。
      if (inputs.buff) { writeCookieFile('buff', inputs.buff); result.buff = inputs.buff.length; }
      if (inputs.steam) { writeCookieFile('steam', inputs.steam); result.steam = inputs.steam.length; }
      const checks = await Promise.all([
        inputs.buff ? verifyBuffSession(inputs.buff) : null,
        inputs.steam ? verifySteamSession(inputs.steam.map(c => `${c.name}=${c.value}`).join('; '), {
          allowInsecure: body.insecure !== false,
          proxy: steamProxy,
        }) : null,
      ]);
      if (checks[0]) result.buffVerify = checks[0];
      if (checks[1]) result.steamVerify = checks[1];
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

  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.taskId || typeof body.taskId !== 'string') return json(res, 400, { ok: false, error: '缺少任务 ID' });
      return json(res, 200, { ok: true, cancelled: tasks.cancel(body.taskId) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/next' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.taskId || typeof body.taskId !== 'string') return json(res, 400, { ok: false, error: '缺少任务 ID' });
      const task = tasks.active;
      const skipped = !!task && task.id === body.taskId && task.skip(body.materialId);
      return json(res, 200, { ok: true, skipped });
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

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[web] 端口 ${PORT} 已被占用：服务可能已经在运行，直接打开 http://${HOST}:${PORT} 即可；`);
    console.error('[web] 或设置环境变量 CS2_WEB_PORT 换一个端口。');
  } else {
    console.error(`[web] 启动失败：${e.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[web] CS2 磨损猎人已启动: http://${HOST}:${PORT}`);
  const { cookies } = loadCookiesDetailed('buff');
  console.log(`[web] BUFF 登录态: ${cookies.length ? `${cookies.length} 条 cookie ✓` : '缺失 ✗（请先运行 scripts/set-cookies.ps1 -Site buff）'}`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
