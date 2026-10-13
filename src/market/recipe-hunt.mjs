import { skinIdentity, skinName } from '../cs2up/location.mjs';
import { nameFlags, materialsInCollection } from '../cs2up/materials.mjs';
import { EXTERIOR_RANGE, parseWearFromName } from './buff.mjs';
import { steamListingMatches } from './steam.mjs';
import { steamListingUrl } from './inspect.mjs';
import { loadCookies } from '../auth/session.mjs';
import {
  f32, ieee754Info, normalizeWear, outputWear, recommendedWearFor,
  requiredAvgNormalized, solveCombinations,
} from '../tradeup/float.mjs';

const EXTERIORS = {
  fn: 'Factory New', mw: 'Minimal Wear', ft: 'Field-Tested', ww: 'Well-Worn', bs: 'Battle-Scarred',
};
const intersects = (range, lo, hi) => Math.fround(range[0]) <= hi &&
  (range[1] === 1 ? hi <= 1 : Math.fround(range[1]) > lo);
const exteriorOf = name => parseWearFromName(String(name).replace(/[（]/g, '(').replace(/[）]/g, ')')) ||
  Object.keys(EXTERIORS).find(k => String(name).endsWith(`(${EXTERIORS[k]})`));
const listingKey = m => `${m.market}:${m.market === 'steam' ? m.listingId : m.orderId}`;
const assetKey = m => m.assetId ? `asset:${m.assetId}` : listingKey(m);

/** 比价使用同枪皮的真实挂单；其它磨损只作为参考，不能替代配方中的选中材料。 */
function attachOffers(picks, offers) {
  const used = new Set(picks.map(assetKey));
  return picks.map(pick => {
    const otherMarket = pick.market === 'buff' ? 'steam' : 'buff';
    const other = offers.filter(m => m.market === otherMarket && m.recipeMaterialId === pick.recipeMaterialId &&
      (!used.has(assetKey(m)) || assetKey(m) === assetKey(pick)))
      .sort((a, b) => Math.abs(a.paintwear - pick.paintwear) - Math.abs(b.paintwear - pick.paintwear) || a.price - b.price)[0];
    if (other) used.add(assetKey(other));
    const summarize = m => m ? ({ market: m.market, price: m.price, paintwear: m.paintwear,
      listingId: m.listingId, orderId: m.orderId, assetId: m.assetId, url: m.url,
      selected: listingKey(m) === listingKey(pick), delta: Math.abs(m.paintwear - pick.paintwear),
      sameWear: f32(m.paintwear) === f32(pick.paintwear) }) : null;
    const marketOffers = { [pick.market]: summarize(pick), [otherMarket]: summarize(other) };
    const { buff, steam } = marketOffers;
    const cheaperMarket = buff && steam && buff.price !== steam.price ? (buff.price < steam.price ? 'buff' : 'steam') : null;
    return { ...pick, marketOffers, cheaperMarket };
  });
}

function matchesGoods(goods, material, statTrak) {
  const flags = nameFlags(goods.name || goods.market_hash_name);
  if (flags.souvenir || flags.knifeOrGlove || flags.statTrak !== statTrak) return false;
  if (goods.name && skinIdentity(goods.name) !== skinIdentity(material.name)) return false;
  if (material.nameEn && goods.market_hash_name &&
      skinIdentity(goods.market_hash_name) !== skinIdentity(material.nameEn)) return false;
  return !!goods.name || !!(material.nameEn && goods.market_hash_name);
}

function steamNames(material, statTrak, lo, hi) {
  if (!material.nameEn) return [];
  const stem = skinName(material.nameEn).replace(/^StatTrak™?\s*/i, '');
  return Object.entries(EXTERIORS).filter(([key]) => intersects(EXTERIOR_RANGE[key], lo, hi))
    .map(([, exterior]) => `${statTrak ? 'StatTrak™ ' : ''}${stem} (${exterior})`);
}

/** 严格模式按枪皮分组；扩展模式按分享链接中的收藏品配额展开全部同档材料。 */
function searchSpecsFor(plan) {
  if (!plan.collectionSpecs) {
    return plan.materialSpecs.map(m => ({ ...m, quotaGroupId: m.id }));
  }
  const known = new Map(plan.materialSpecs.map(m => [m.id, m]));
  return plan.collectionSpecs.flatMap(group => materialsInCollection(group.collection, group.grade)
    .map(m => ({
      id: m.key, name: m.name, nameEn: known.get(m.key)?.nameEn || null,
      collection: group.collection, range: [m.min, m.max], quotaGroupId: group.id,
      count: null,
    })));
}

/** 按链接的收藏品配额求解，材料磨损根据目标和完整皮肤区间计算。 */
export async function huntRecipe(cfg, { buff, signal, onProgress = () => {}, timeBudgetMs = 30000, wants = 5 }) {
  const { recipePlan: plan, targetWear, statTrak = false, band = 0.03,
    dataSource, steam, steamPages = 4, buffPages = 3 } = cfg;
  if (!plan?.ok) return { ok: false, error: 'invalid_recipe_plan', message: '缺少有效的分享配方材料清单。' };
  const usesSteam = dataSource === 'steam' || dataSource === 'both';
  const usesBuff = dataSource !== 'steam';
  if (usesSteam && !steam) return { ok: false, error: 'no_steam', message: '未提供 Steam 客户端。' };
  const searchSpecs = searchSpecsFor(plan);
  if (!searchSpecs.length) return { ok: false, error: 'no_collection_materials', message: '链接中的收藏品和材料等级没有可搜索的材料。' };
  const outRange = plan.targetOutput.range;
  const normalizedTarget = requiredAvgNormalized(f32(targetWear), ...outRange);
  if (!Number.isFinite(normalizedTarget) || normalizedTarget < 0 || normalizedTarget > 1) {
    return { ok: false, error: 'target_out_of_range',
      message: `目标磨损 ${targetWear} 不在产物「${plan.targetOutput.name}」的区间 [${outRange.join(', ')}] 内。` };
  }
  const materialBands = searchSpecs.map(m => {
    const wear = recommendedWearFor(...m.range, normalizedTarget);
    return { ...m, targetWear: wear, band: [Math.max(f32(m.range[0]), wear - band), Math.min(f32(m.range[1]), wear + band)] };
  });
  const quotaText = plan.collectionSpecs
    ? plan.collectionSpecs.map(m => `${m.collection} × ${m.count}`).join('；')
    : materialBands.map(m => `${m.name} × ${m.count}`).join('；');
  onProgress(`${plan.collectionSpecs ? '按链接中的收藏品配额搜索全部同档枪皮' : '严格使用链接中的枪皮'}，共 ${plan.totalCount} 把：${quotaText}`);
  onProgress(`目标产物「${plan.targetOutput.name}」磨损 ${targetWear}，区间 [${outRange.join(', ')}]；按每种材料的完整区间反推搜索磨损。`);

  const pool = [], offers = [], perItem = [], seenOrders = new Set(), assetSlots = new Map();
  let cookies = null;
  if (usesSteam) {
    const stored = loadCookies('steam');
    cookies = stored.length ? stored.map(c => `${c.name}=${c.value}`).join('; ') : null;
  }
  const addListing = (listing, material, hashName, goodsId, market) => {
    const wear = market === 'steam' ? listing.floatvalue : listing.paintwear;
    const [lo, hi] = material.band;
    if (!Number.isFinite(wear) || wear < lo || wear > hi ||
        !Number.isFinite(listing.price) || listing.price < 0) return;
    if (market === 'steam') {
      if (!steamListingMatches(listing, hashName) || (listing.currencyId != null && listing.currencyId !== 23)) return;
    } else {
      if (String(listing.goodsId) !== String(goodsId)) return;
      if (listing.name && (skinIdentity(listing.name) !== skinIdentity(material.name) ||
          nameFlags(listing.name).statTrak !== statTrak || nameFlags(listing.name).souvenir)) return;
      if (listing.marketHashName && material.nameEn && skinIdentity(listing.marketHashName) !== skinIdentity(material.nameEn)) return;
    }
    const orderId = market === 'steam' ? listing.listingId : listing.orderId;
    const key = `${market}:${orderId}`;
    if (!orderId || seenOrders.has(key)) return;
    seenOrders.add(key);
    const url = market === 'steam' ? steamListingUrl(hashName, orderId) : listing.buyUrl || listing.url;
    const candidate = { ...listing, raw: undefined, market, recipeMaterialId: material.id,
      recipeGroupId: material.quotaGroupId,
      name: listing.name || material.name, marketHashName: listing.marketHashName || hashName,
      collectionName: material.collection, paintwear: wear, matRange: material.range,
      norm: normalizeWear(wear, ...material.range), url, buyUrl: url };
    const asset = assetKey(candidate);
    if (assetSlots.has(asset)) {
      const slot = assetSlots.get(asset), existing = pool[slot];
      if (existing.recipeMaterialId !== candidate.recipeMaterialId || f32(existing.paintwear) !== f32(wear)) return;
      if (existing.market === market) return;
      offers.push(candidate);
      if (candidate.price < existing.price) pool[slot] = candidate;
      return;
    }
    assetSlots.set(asset, pool.length);
    pool.push(candidate);
    offers.push(candidate);
  };

  for (const [index, material] of materialBands.entries()) {
    signal?.throwIfAborted();
    const [lo, hi] = material.band;
    onProgress(`[${index + 1}/${materialBands.length}] ${material.name}${material.count ? ` × ${material.count}` : ''}：材料目标磨损 ${material.targetWear.toFixed(10)}，搜索 [${lo.toFixed(6)}, ${hi.toFixed(6)}]`);
    const errors = [];
    let variants = [];
    if (usesBuff) {
      const listed = await buff.listGoods({ search: material.name, pageSize: 50 });
      if (!listed.ok) errors.push(`BUFF：${listed.kind || '商品查询失败'}`);
      else variants = listed.items.filter(g => matchesGoods(g, material, statTrak));
    }
    if (usesSteam) {
      if (!material.nameEn && variants[0]?.market_hash_name) material.nameEn = variants[0].market_hash_name;
      if (!material.nameEn && steam.search) {
        const found = await steam.search({ query: material.name, count: 20, language: 'schinese' });
        const match = found.ok && found.results?.find(item => {
          const flags = nameFlags(item.name);
          return !!item.name && !flags.souvenir && !flags.knifeOrGlove &&
            skinIdentity(item.localizedName) === skinIdentity(material.name);
        });
        material.nameEn = match?.name || null;
        if (!found.ok) errors.push(`Steam：${found.error || '商品名称查询失败'}`);
      }
      const names = material.nameEn ? steamNames(material, statTrak, lo, hi) :
        variants.map(g => g.market_hash_name).filter(name => {
          const exterior = exteriorOf(name);
          return exterior && intersects(EXTERIOR_RANGE[exterior], lo, hi);
        });
      if (!names.length) errors.push('没有确认到该枪皮的 Steam 英文名');
      for (const name of new Set(names)) {
        signal?.throwIfAborted();
        onProgress(`  抓取 ${name} 的 Steam 挂单 ...`);
        const result = await steam.listingsWithFloats(name, { cookies, pages: steamPages });
        if (!result.ok) {
          errors.push(`Steam：${result.error || '挂单查询失败'}`);
          if (dataSource === 'steam' && /重定向(?:循环|次数超过)/.test(String(result.error))) {
            return { ok: false, error: 'steam_redirect_loop', message: result.error, perItem };
          }
          continue;
        }
        for (const listing of result.listings) addListing(listing, material, name, undefined, 'steam');
      }
    }
    if (usesBuff) {
      for (const variant of variants) {
        const exterior = exteriorOf(variant.name) || exteriorOf(variant.market_hash_name);
        if (!exterior || !intersects(EXTERIOR_RANGE[exterior], lo, hi)) continue;
        onProgress(`  抓取 ${variant.name} 的 BUFF 挂单 ...`);
        for (let page = 1; page <= buffPages; page++) {
          signal?.throwIfAborted();
          const result = await buff.sellOrders({ goodsId: variant.id, minPaintwear: lo, maxPaintwear: hi,
            sortBy: 'price.asc', pageSize: 60, pageNum: page });
          if (!result.ok) { errors.push(`BUFF：${result.kind || '挂单查询失败'}`); break; }
          for (const listing of result.listings) addListing(listing, material, variant.market_hash_name, variant.id, 'buff');
          if (!result.listings.length || (result.totalPage && page >= result.totalPage) ||
              (result.total != null && page * 60 >= result.total)) break;
        }
      }
    }
    const available = pool.filter(l => l.recipeMaterialId === material.id).length;
    perItem.push({ name: material.name, collection: material.collection, group: material.quotaGroupId,
      required: material.count || 0, available, errors });
    onProgress(`  ${material.name}：找到 ${available} 件不同的真实材料${material.count ? `，需要 ${material.count} 件` : ''}${errors.length ? `（${errors.join('；')}）` : ''}`);
  }
  const shortages = plan.collectionSpecs
    ? plan.collectionSpecs.map(group => ({ ...group,
      available: pool.filter(l => l.recipeGroupId === group.id).length,
    })).filter(group => group.available < group.count)
    : perItem.filter(m => m.available < m.required);
  if (shortages.length) return {
    ok: false, error: 'not_enough_recipe_materials', poolSize: pool.length, perItem,
    message: (plan.collectionSpecs ? '链接指定的收藏品配额不足：' : '链接指定的材料不足：') +
      shortages.map(m => `「${m.name || m.collection}」需要 ${m.required || m.count} 把，只找到 ${m.available} 把` +
        (m.errors?.length ? `（${m.errors.join('；')}）` : '')).join('；') + '。可调大磨损搜索半径或增加抓取页数后重试。',
  };
  onProgress(`候选池 ${pool.length} 笔，按链接中的${plan.collectionSpecs ? '收藏品' : '材料'}固定数量求解 ...`);
  const quotaSpecs = plan.collectionSpecs || materialBands;
  const quotas = Object.fromEntries(quotaSpecs.map(m => [m.id, m.count]));
  pool.sort((a, b) => a.price - b.price);
  const solved = solveCombinations(pool.map(m => m.norm), {
    count: plan.totalCount, outMin: outRange[0], outMax: outRange[1], targetOut: targetWear,
    candidateGroups: pool.map(m => m.recipeGroupId), groupCounts: quotas,
    tries: 30000, maxResults: wants, timeBudgetMs,
  });
  const recipes = solved.results.map(result => {
    const picks = result.indices.map(i => pool[i]);
    // 相同枪皮和实际 float32 磨损可换为更便宜的未使用挂单，产物磨损保持不变。
    const occupied = new Set(picks.map(assetKey));
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      const cheaper = pool.find(m => m.recipeMaterialId === pick.recipeMaterialId &&
        f32(m.paintwear) === f32(pick.paintwear) && m.price < pick.price && !occupied.has(assetKey(m)));
      if (cheaper) { occupied.delete(assetKey(pick)); occupied.add(assetKey(cheaper)); picks[i] = cheaper; }
    }
    if (new Set(picks.map(assetKey)).size !== plan.totalCount ||
        quotaSpecs.some(m => picks.filter(p => p.recipeGroupId === m.id).length !== m.count)) {
      throw new Error('求解结果不符合链接的材料数量约束，已停止输出。');
    }
    const forMath = picks.map(m => ({ wear: m.paintwear, matMin: m.matRange[0], matMax: m.matRange[1] }));
    const calculatedWear = outputWear(forMath, ...outRange);
    const score = Math.abs(calculatedWear - f32(targetWear));
    const outputs = plan.outputSpecs.map(output => ({ ...output, wear: outputWear(forMath, ...output.range) }));
    return { score, exact: score === 0, outputWear: calculatedWear, outputs,
      targetOutput: plan.targetOutput.name, cost: picks.reduce((sum, m) => sum + m.price, 0),
      dataSource, statTrak, materials: dataSource === 'both' ? attachOffers(picks, offers) : picks };
  }).sort((a, b) => a.score - b.score || a.cost - b.cost);
  if (!recipes.length) return { ok: false, error: 'no_recipe_solution', message: '在指定材料数量和搜索范围内未找到可用组合。' };
  return {
    ok: true, dataSource, collectionName: plan.collection, materialGrade: plan.grade,
    outRange, targetOutput: plan.targetOutput.name, materialCount: materialBands.length,
    materialBands: plan.collectionSpecs ? [] : materialBands,
    collectionSpecs: plan.collectionSpecs,
    collectionBands: plan.collectionSpecs ? materialBands : [],
    requiredAvgNormalized: normalizedTarget, usableRanges: materialBands.map(m => m.range),
    skippedRanges: [], band: [Math.min(...materialBands.map(m => m.band[0])), Math.max(...materialBands.map(m => m.band[1]))],
    poolSize: pool.length, exactFound: recipes.some(r => r.exact), bestScore: recipes[0].score,
    marketCounts: { buff: pool.filter(m => m.market === 'buff').length, steam: pool.filter(m => m.market === 'steam').length },
    statTrak, perItem, steamItems: usesSteam ? { perItem } : null, ieee754: ieee754Info(targetWear), recipes,
  };
}
