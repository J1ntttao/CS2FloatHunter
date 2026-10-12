/**
 * 「按目标磨损凑 10 把」——但材料限定在某个配方的收藏品里。
 *
 * 用户流程：
 *   1. 粘贴 CS2UP 配方分享链接 → 定位到「哪个收藏品 + 哪一档材料」
 *   2. 输入想要的**产物磨损**
 *   3. 在该收藏品的这一档材料里，凑出 10 把能打出该磨损的皮肤
 *
 * 关键数学：同一收藏品内所有皮肤的磨损区间相同，所以
 *   产物磨损 = 平均(材料磨损) × (产物max − 产物min) + 产物min
 * 反推即得材料平均磨损；再用站点算法（先按各自区间归一化再平均）在 float32 下精确求解。
 *
 * 磨损区间一律以 BUFF 的 paintwear_range 为准（本地材料库的 min/max 实测有偏差）。
 */

import { BuffMarket } from './buff.mjs';
import { materialsInCollection, nameFlags, normalizeName } from '../cs2up/materials.mjs';
import { loadCookies } from '../auth/session.mjs';
import {
  f32, normalizeWear, outputWear, requiredNormalizedSum,
  solveCombinations, ieee754Info, verifyCombination,
} from '../tradeup/float.mjs';

export class CollectionHunter {
  constructor({ intervalMs = 2200, verbose = false } = {}) {
    this.buff = new BuffMarket({ minIntervalMs: intervalMs, verbose });
    this.verbose = verbose;
  }

  _log(...a) { if (this.verbose) console.log('[hunter]', ...a); }

  /**
   * 找出该收藏品里所有符合档位的皮肤，并解析成 BUFF 商品。
   * @param {string} collectionName 中文收藏品名
   * @param {string} grade          内部代号，如 'restricted'
   * @param {boolean} statTrak      是否要暗金
   */
  async enumerateMaterials(collectionName, grade, { statTrak = false, onProgress = () => {} } = {}) {
    const all = materialsInCollection(collectionName, grade);
    onProgress(`收藏品「${collectionName}」${grade} 档共 ${all.length} 个皮肤，开始解析 BUFF 商品 ...`);

    const out = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      const l = await this.buff.listGoods({ search: m.name, pageSize: 50 });
      if (!l.ok) {
        out.push({ db: m, ok: false, error: l.kind });
        continue;
      }
      // 在结果里挑：名字匹配（忽略磨损后缀）+ StatTrak 口味一致 + 非纪念品
      const want = normalizeName(m.name);
      const cands = l.items.filter(it => {
        const f = nameFlags(it.name);
        if (f.souvenir) return false;
        if (!!statTrak !== f.statTrak) return false;
        if (f.knifeOrGlove) return false;
        return normalizeName(it.name) === want;
      });
      if (!cands.length) {
        out.push({ db: m, ok: false, error: 'no_match' });
        continue;
      }
      // 同一个皮肤有多个磨损档商品，全部收下（每个都有自己的区间与挂单）
      out.push({ db: m, ok: true, variants: cands.map(c => ({ goodsId: c.id, name: c.name, sellNum: c.sell_num, minPrice: c.sell_min_price })) });
      onProgress(`  [${i + 1}/${all.length}] ${m.name} → ${cands.length} 个磨损档商品`);
    }
    return out;
  }

  /** 取某商品的 BUFF 磨损区间（带缓存） */
  async range(goodsId, cache) {
    if (cache.has(goodsId)) return cache.get(goodsId);
    const g = await this.buff.goodsInfo(goodsId);
    const r = g.ok && g.info?.paintwear_range ? g.info.paintwear_range.map(Number) : null;
    cache.set(goodsId, r);
    return r;
  }

  /**
   * 从 **Steam** 构建候选池并求解（真正只依赖 Steam 的路径）。
   *
   * 与 BUFF 路径的关键差别：
   *   - 磨损不是「挂单字段」，而是**解码检视链接**得到的 → 只有能解出来的挂单才可用
   *   - Steam 挂单页按价格排序，未登录只能看有限几页 → 可能出现「附近没有合适磨损」的情况
   *   - 因此这条路径**不保证**能凑齐，凑不齐时必须如实报错，绝不能拿 BUFF 数据顶替
   */
  async huntFromSteam(cfg, { onProgress = () => {}, timeBudgetMs = 30000, wants = 5 } = {}) {
    const {
      collectionName, materialGrade, targetWear, statTrak = false,
      band = 0.03, count = 10,
      steam,                    // 传入已构造好的 SteamMarket（带代理设置）
      maxItems = 40,            // 最多抓多少个商品的挂单页（很慢，要限制）
      steamPages = 4,           // 每个商品抓几页（每页 20 笔；Steam 按价格排序，只能多扫）
    } = cfg;

    if (!steam) return { ok: false, error: 'no_steam', message: '未提供 Steam 客户端' };

    // 1) 枚举该档位的皮肤（这一步来自本地材料库，与 BUFF 无关）
    const mats = await this.enumerateMaterials(collectionName, materialGrade, { statTrak, onProgress });
    const okMats = mats.filter(m => m.ok);
    if (!okMats.length) {
      return { ok: false, error: 'no_materials', message: `收藏品「${collectionName}」的 ${materialGrade} 档没有解析到任何皮肤。` };
    }

    // 2) 用 BUFF 只是为了拿**磨损区间**（判断哪些皮肤能覆盖目标磨损）——
    //    这一步必须说清楚：区间信息本身不是价格/挂单，不构成"用 BUFF 求解"。
    //    如果连区间都拿不到，就直接失败，不猜。
    onProgress('获取各皮肤的磨损区间（用于判断哪些能覆盖目标磨损）...');
    const cache = new Map();
    const variants = [];
    for (const m of okMats) {
      for (const v of m.variants) {
        const r = await this.range(v.goodsId, cache);
        if (!r || r[1] <= r[0]) continue;
        variants.push({ ...v, dbName: m.db.name, range: r });
      }
    }

    const lo0 = Number(targetWear) - band;
    const hi0 = Number(targetWear) + band;
    const usableVariants = [];
    const skippedRanges = [];
    const seenRange = new Set();
    for (const v of variants) {
      const key = `${v.range[0]}|${v.range[1]}`;
      const covers = Math.min(v.range[1], hi0) > Math.max(v.range[0], lo0);
      if (!covers) { if (!seenRange.has(key)) { seenRange.add(key); skippedRanges.push(v.range); } continue; }
      usableVariants.push(v);
    }
    if (!usableVariants.length) {
      return {
        ok: false, error: 'no_usable_range',
        message: `没有任何皮肤的磨损区间能覆盖 ${targetWear}（±${band}）。`,
        skippedRanges,
      };
    }
    const outRange = usableVariants[0].range;
    onProgress(`可用皮肤 ${usableVariants.length} 个，磨损区间 [${outRange[0]}, ${outRange[1]}]`);

    // 3) 转成 Steam 需要的标识：**必须用 market_hash_name（英文名）**，
    //    不能用中文名 —— 用中文名拼 /market/listings/730/<中文> 会拿到不含挂单数据的空壳
    //    （实测表现为 no_listings_in_ssr，而且有时会"碰巧"重定向成功，非常难查）。
    onProgress('向 BUFF 查询各商品的市场英文名（Steam 需要 market_hash_name）...');
    const byHash = new Map();
    for (const v of usableVariants) {
      const info = await this.buff.goodsInfo(v.goodsId).catch(() => null);
      const mhn = info && info.ok ? info.info?.market_hash_name : null;
      if (!mhn) continue;
      if (!byHash.has(mhn)) byHash.set(mhn, { ...v, marketHashName: mhn });
    }
    const targets = [...byHash.values()].slice(0, maxItems);
    if (!targets.length) {
      return {
        ok: false, error: 'no_market_hash_name',
        message: '拿不到任何商品的 Steam 英文名（market_hash_name），无法查询 Steam 挂单页。',
      };
    }
    onProgress(`Steam：开始抓取 ${targets.length} 个商品的挂单页（每页 20 笔 × ${steamPages} 页），并读取每笔的精确磨损 ...`);

    const pool = [];
    const perItem = [];
    const steamCookie = (() => {
      try {
        const list = loadCookies('steam');
        return list.length ? list.map(c => `${c.name}=${c.value}`).join('; ') : null;
      } catch { return null; }
    })();
    for (const t of targets) {
      const r = await steam.listingsWithFloats(t.marketHashName || t.name, { cookies: steamCookie, pages: steamPages });
      if (!r.ok) {
        perItem.push({ name: t.name, ok: false, error: r.error, rateLimited: !!r.rateLimited });
        onProgress(`  ${t.name} → 失败：${r.error}`);
        continue;
      }
      const withFloat = r.listings.filter(l => l.floatvalue != null);
      perItem.push({ name: t.name, ok: true, total: r.listings.length, withFloat: withFloat.length, pagesFetched: r.pagesFetched });
      onProgress(`  ${t.name} → ${r.listings.length} 笔挂单，${withFloat.length} 笔解出磨损`);
      for (const l of withFloat) {
        if (l.floatvalue < t.range[0] || l.floatvalue > t.range[1]) continue;
        pool.push({
          ...l,
          matRange: t.range,
          dbName: t.dbName,
          norm: normalizeWear(l.floatvalue, t.range[0], t.range[1]),
          paintwear: l.floatvalue,
          market: 'steam',
          url: l.url,
          buyUrl: l.url,
        });
      }
    }

    const steamOk = perItem.filter(x => x.ok).length;
    const rateLimitedCount = perItem.filter(x => x.rateLimited).length;
    if (!steamOk) {
      // 区分「限流」和「真取不到」——之前的报错一律归咎于代理，是误导
      if (rateLimitedCount > 0) {
        return {
          ok: false, error: 'steam_rate_limited',
          message: `Steam 对所有 ${targets.length} 个商品都返回限流（HTTP 500/429）。` +
            `这是请求太快导致的，与代理无关：请等几分钟再试，或把抓取页数调小。`,
          perItem,
        };
      }
      return {
        ok: false, error: 'steam_unreachable',
        message: '所有商品的 Steam 挂单页都取不到（既非限流，也解析不出数据）。请检查代理是否可用。',
        perItem,
      };
    }
    if (pool.length < count) {
      return {
        ok: false, error: 'not_enough_steam',
        message: `Steam 上只找到 ${pool.length} 笔「磨损落在 [${lo.toFixed(4)}, ${hi.toFixed(4)}] 内」的挂单，凑不满 ${count} 把。` +
          `原因：Steam 挂单是**按价格排序**的，不能按磨损检索，只能一页页扫（每页 20 笔）；` +
          `同一商品在不同页上的磨损分布很散。可以调大磨损搜索半径，或改用「BUFF + Steam 比价」。`,
        poolSize: pool.length, perItem, rateLimited: rateLimitedCount > 0,
      };
    }

    // 4) 求解
    onProgress(`Steam 候选池 ${pool.length} 笔，开始求解 ${count} 把 ...`);
    const norm = pool.map(p => p.norm);
    const solved = solveCombinations(norm, {
      count, outMin: outRange[0], outMax: outRange[1], targetOut: targetWear,
      tries: 30000, maxResults: wants, timeBudgetMs,
    });

    const recipes = solved.results.map(r => {
      const picks = r.indices.map(i => pool[i]);
      const matsFor = picks.map(p => ({ wear: p.paintwear, matMin: p.matRange[0], matMax: p.matRange[1] }));
      const out = outputWear(matsFor, outRange[0], outRange[1]);
      const cost = picks.reduce((a, p) => a + (p.price || 0), 0);
      return {
        score: r.score,
        exact: r.score === 0,
        outputWear: out,
        cost,
        dataSource: 'steam',
        materials: picks.map(p => ({
          market: 'steam',
          listingId: p.listingId,
          assetId: p.assetId,
          name: p.name,
          paintwear: p.paintwear,
          matRange: p.matRange,
          norm: p.norm,
          price: p.price,
          url: p.url,
          buyUrl: p.buyUrl,
          inspectUrl: null,
        })),
      };
    });

    return {
      ok: true,
      dataSource: 'steam',
      collectionName, materialGrade,
      outRange, skippedRanges,
      band: [lo0, hi0],
      poolSize: pool.length,
      materialCount: variants.length,
      steamItems: { total: targets.length, ok: steamOk, perItem },
      exactFound: solved.exactFound,
      bestScore: solved.bestScore,
      ieee754: ieee754Info(targetWear),
      recipes,
    };
  }

  /**
   * 主流程（BUFF 路径）。
   * @param {object} cfg
   *   collectionName  中文收藏品名
   *   materialGrade   材料档位（内部代号）
   *   targetWear      想要的产物磨损
   *   statTrak        是否暗金
   *   band            材料磨损带半径
   *   count           材料数量（默认 10）
   */
  async hunt(cfg, { onProgress = () => {}, timeBudgetMs = 30000, wants = 5 } = {}) {
    const {
      collectionName, materialGrade, targetWear, statTrak = false,
      band = 0.02, count = 10,
    } = cfg;
    const cache = new Map();

    // 1) 枚举该档位的所有皮肤
    const mats = await this.enumerateMaterials(collectionName, materialGrade, { statTrak, onProgress });
    const okMats = mats.filter(m => m.ok);
    if (!okMats.length) {
      return { ok: false, error: 'no_materials', message: `收藏品「${collectionName}」的 ${materialGrade} 档没有解析到任何可买皮肤。` };
    }

    // 2) 取每件的磨损区间。
    //    同一个皮肤有多个磨损档商品（FN/MW/FT/WW/BS），区间各不相同；
    //    而**只有区间能覆盖目标平均磨损的那些才可能用来凑这个配方**，
    //    所以这里按区间分组，而不是随便取一个“最常见”的区间。
    onProgress(`解析 ${okMats.length} 个皮肤的磨损区间 ...`);
    const variants = [];
    for (const m of okMats) {
      for (const v of m.variants) {
        const r = await this.range(v.goodsId, cache);
        if (r && r[1] > r[0]) variants.push({ ...v, dbName: m.db.name, range: r });
      }
    }
    if (!variants.length) {
      return { ok: false, error: 'no_range', message: '没能取到任何皮肤的磨损区间（BUFF 接口异常或登录态失效）。' };
    }

    // 按区间分组统计
    const groupMap = new Map();
    for (const v of variants) {
      const k = `${v.range[0]}|${v.range[1]}`;
      if (!groupMap.has(k)) groupMap.set(k, { range: v.range, items: [] });
      groupMap.get(k).items.push(v);
    }
    const groups = [...groupMap.values()].sort((a, b) => b.items.length - a.items.length);
    onProgress(`共 ${groups.length} 种磨损区间档：` + groups.map(g => `[${g.range[0]},${g.range[1]}]×${g.items.length}`).join('  '));

    // 3) 目标产物磨损 → 需要的材料平均磨损。
    //    产物区间 = 材料区间（同收藏品同档，实测 BUFF 上二者一致），
    //    所以「需要多少平均磨损」就等于目标产物磨损本身。
    const ie = ieee754Info(targetWear);
    const avgWear = f32(targetWear);
    onProgress(`目标产物磨损 ${targetWear} → 需要材料平均磨损 ≈ ${Number(avgWear).toFixed(6)}`);

    // 4) 只保留区间能覆盖「平均磨损 ± band」的档位
    const lo = avgWear - band;
    const hi = avgWear + band;
    const usable = [];
    const skipped = [];
    for (const g of groups) {
      const clo = Math.max(g.range[0], lo);
      const chi = Math.min(g.range[1], hi);
      if (chi > clo) usable.push({ ...g, lo: clo, hi: chi });
      else skipped.push(g.range);
    }
    if (!usable.length) {
      return {
        ok: false, error: 'no_usable_range',
        message: `该收藏品这一档没有任何磨损区间能覆盖 ${Number(avgWear).toFixed(4)}（目标产物磨损）。` +
          `可用区间只有 ${groups.map(g => `[${g.range[0]},${g.range[1]}]`).join('、')}。`,
        groups: groups.map(g => g.range),
      };
    }
    if (skipped.length) {
      onProgress(`跳过 ${skipped.length} 个档位（区间不覆盖目标）：${skipped.map(s => `[${s[0]},${s[1]}]`).join(' ')}`);
    }

    // 产物区间取「可用档位里出现最多的那个」（同收藏品内理论上一致）
    const outRange = usable[0].range;
    const wantNormSum = requiredNormalizedSum(targetWear, outRange[0], outRange[1], count);

    // 5) 抓挂单。
    //
    // 这里是**成本关键**：以前用 sort_by=paintwear.asc（按磨损升序）取前 60 笔，
    // 结果拿到的全是「磨损最接近但未必便宜」的挂单，成本很高。
    // 改成：对每个皮肤、每个可用区间都按**价格升序**取，从而优先拿到便宜货；
    // 磨损是否合适交给上面的区间过滤 + 后面的求解器保证。
    onProgress(`抓取磨损落在 [${lo.toFixed(6)}, ${hi.toFixed(6)}] 的挂单（按价格从低到高）...`);
    const pool = [];
    for (const g of usable) {
      for (const w of g.items) {
        const so = await this.buff.sellOrders({
          goodsId: w.goodsId, minPaintwear: g.lo, maxPaintwear: g.hi,
          sortBy: 'price.asc', pageSize: 60,
        });
        if (!so.ok) {
          onProgress(`  ${w.name} → ${so.kind}，跳过`);
          if (so.kind === 'login_required') break;
          continue;
        }
        const got = so.listings.filter(l => l.paintwear != null);
        if (got.length) {
          const prices = got.map(l => l.price).filter(Number.isFinite);
          const cheapest = prices.length ? Math.min(...prices) : null;
          onProgress(`  ${w.name}  [${g.lo.toFixed(4)}, ${g.hi.toFixed(4)}]  ${got.length} 笔 / 总 ${so.total}  最低 ¥${cheapest}`);
        }
        for (const l of got) {
          pool.push({
            ...l,
            matRange: w.range,
            dbName: w.dbName,
            norm: normalizeWear(l.paintwear, w.range[0], w.range[1]),
          });
        }
        if (pool.length >= 900) break;
      }
      if (pool.length >= 900) { onProgress('候选池已达 900，停止抓取'); break; }
    }

    if (pool.length < count) {
      return {
        ok: false, error: 'not_enough',
        message: `只抓到 ${pool.length} 笔符合条件的挂单，凑不满 ${count} 把。可以把「磨损搜索半径」调大一点再试。`,
        poolSize: pool.length, outRange,
      };
    }

    // 5) 求解
    onProgress(`候选池 ${pool.length} 笔，开始求解 ${count} 把 ...`);
    const norm = pool.map(p => p.norm);
    const solved = solveCombinations(norm, {
      count, outMin: outRange[0], outMax: outRange[1], targetOut: targetWear,
      tries: 30000, maxResults: wants, timeBudgetMs,
    });

    const recipes = solved.results.map(r => {
      const picks = r.indices.map(i => pool[i]);
      const matsFor = picks.map(p => ({ wear: p.paintwear, matMin: p.matRange[0], matMax: p.matRange[1] }));
      const out = outputWear(matsFor, outRange[0], outRange[1]);
      const cost = picks.reduce((a, p) => a + (p.price || 0), 0);
      return {
        score: r.score,
        exact: r.score === 0,
        outputWear: out,
        cost,
        materials: picks.map(p => ({
          market: p.market,
          goodsId: p.goodsId,
          orderId: p.orderId,
          assetId: p.assetId,
          name: p.name || p.dbName,
          marketHashName: p.marketHashName || null,
          paintwear: p.paintwear,
          paintwearRaw: p.paintwearRaw,
          matRange: p.matRange,
          norm: p.norm,
          price: p.price,
          tradable: p.tradable,
          url: p.buyUrl || p.url,
          inspectUrl: p.inspectUrl,
        })),
      };
    }).filter(Boolean);

    // 6) 成本优化：同一件商品的等价挂单里挑最便宜的，同时给出候选价区间
    onProgress('按同款同磨损等价挂单选最便宜的，优化总价 ...');
    for (const rec of recipes) {
      let oldCost = 0, newCost = 0, swaps = 0;
      for (const m of rec.materials) {
        oldCost += m.price ?? 0;
        // 同 goodsId、磨损几乎相同（同一档挂单）里挑最便宜的
        const equiv = pool.filter(p =>
          p.goodsId === m.goodsId && Math.abs(p.paintwear - m.paintwear) < 1e-6 && p.price != null);
        const cheapest = equiv.reduce((a, b) => (b.price < a.price ? b : a), equiv[0] || null);
        if (cheapest && cheapest.price < (m.price ?? Infinity)) {
          m.price = cheapest.price;
          m.orderId = cheapest.orderId;
          m.assetId = cheapest.assetId;
          m.url = cheapest.buyUrl || cheapest.url;
          m.inspectUrl = cheapest.inspectUrl;
          swaps++;
        }
        // 该商品的挂单价格区间（说明还有多便宜的空间）
        const sameGoods = pool.filter(p => p.goodsId === m.goodsId && p.price != null).map(p => p.price);
        m.candidatesOnMarket = sameGoods.length;
        m.priceMin = sameGoods.length ? Math.min(...sameGoods) : null;
        m.priceMax = sameGoods.length ? Math.max(...sameGoods) : null;
        newCost += m.price ?? 0;
      }
      rec.cost = newCost;
      rec.costBeforeOptimize = oldCost;
      rec.optimizeSwaps = swaps;
    }

    return {
      ok: true,
      dataSource: 'buff',
      collectionName, materialGrade,
      outRange,
      requiredAvgWear: avgWear,
      usableRanges: usable.map(u => u.range),
      skippedRanges: skipped,
      band: [lo, hi],
      poolSize: pool.length,
      materialCount: variants.length,
      exactFound: solved.exactFound,
      bestScore: solved.bestScore,
      ieee754: ie,
      recipes,
    };
  }
}
