import { skinIdentity, skinName } from '../cs2up/location.mjs';
import { nameFlags, materialsInCollection, findInDbByBuffName } from '../cs2up/materials.mjs';
import { EXTERIORS as WEAR_TIERS, normalizeExteriors, exteriorRange, exteriorKey } from './exteriors.mjs';
import { steamListingMatches } from './steam.mjs';
import { steamListingUrl } from './inspect.mjs';
import { samplePages } from './page-sampling.mjs';
import { loadCookies } from '../auth/session.mjs';
import { feasibleCandidates } from './combination-search.mjs';
import {
  f32, ieee754Info, normalizeWear, outputWear, outputTargetInfo,
  requiredAvgNormalized, solveCombinations,
} from '../tradeup/float.mjs';

const listingKey = m => `${m.market}:${m.market === 'steam' ? m.listingId : m.orderId}`;
const assetKey = m => m.assetId ? `asset:${m.assetId}` : listingKey(m);
const currencyOf = m => m.market === 'buff' ? 23 : m.currencyId == null ? null : Number(m.currencyId);
const comparePrices = (a, b) => currencyOf(a) === currencyOf(b)
  ? (Number.isFinite(a.price) ? a.price : Infinity) - (Number.isFinite(b.price) ? b.price : Infinity)
  : (currencyOf(a) ?? Infinity) - (currencyOf(b) ?? Infinity);
const cheaperThan = (a, b) => currencyOf(a) === currencyOf(b) && Number.isFinite(a.price) &&
  (!Number.isFinite(b.price) || a.price < b.price);

/** 比价使用同枪皮的真实挂单；其它磨损只作为参考，不能替代配方中的选中材料。 */
function attachOffers(picks, offers) {
  const used = new Set(picks.map(assetKey));
  return picks.map(pick => {
    const otherMarket = pick.market === 'buff' ? 'steam' : 'buff';
    const other = offers.filter(m => m.market === otherMarket && m.recipeMaterialId === pick.recipeMaterialId &&
      (!used.has(assetKey(m)) || assetKey(m) === assetKey(pick)))
      .sort((a, b) => Math.abs(a.paintwear - pick.paintwear) - Math.abs(b.paintwear - pick.paintwear) || comparePrices(a, b))[0];
    if (other) used.add(assetKey(other));
    const summarize = m => m ? ({ market: m.market, price: m.price, currencyId: currencyOf(m), paintwear: m.paintwear,
      listingId: m.listingId, orderId: m.orderId, assetId: m.assetId, url: m.url,
      selected: listingKey(m) === listingKey(pick), delta: Math.abs(m.paintwear - pick.paintwear),
      sameWear: f32(m.paintwear) === f32(pick.paintwear) }) : null;
    const marketOffers = { [pick.market]: summarize(pick), [otherMarket]: summarize(other) };
    const { buff, steam } = marketOffers;
    const cheaperMarket = buff && steam && Number.isFinite(buff.price) && Number.isFinite(steam.price) &&
      buff.currencyId === steam.currencyId && buff.price !== steam.price ? (buff.price < steam.price ? 'buff' : 'steam') : null;
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
export async function huntRecipe(cfg, { buff, signal, onProgress = () => {}, onWork = () => {},
  shouldSkip = () => false, timeBudgetMs = 30000, wants = 5 }) {
  const { recipePlan: plan, targetWear, statTrak = false, exteriors: requestedExteriors,
    dataSource, steam, steamPages = 4, steamMaxPages = Infinity, steamRandomPages = 0,
    buffPages = Infinity, resumeState = null } = cfg;
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
  const exteriors = normalizeExteriors(requestedExteriors);
  if (!exteriors) return { ok: false, error: 'invalid_exteriors', message: '请至少勾选一个有效的磨损品质等级。' };
  const materialBands = searchSpecs.map(m => ({ ...m, band: m.range.map(f32),
    exteriorRanges: exteriors.flatMap(key => {
      const range = exteriorRange(key, m.range);
      return range ? [{ key, label: WEAR_TIERS[key].label, range }] : [];
    }) }));
  // 分享配方提供的英文名先用，先覆盖不同收藏品，减少名称查询和单组深翻页的等待。
  if (plan.collectionSpecs) {
    const positions = new Map();
    const ranked = materialBands.slice().sort((a, b) => Number(!!b.nameEn) - Number(!!a.nameEn));
    for (const material of ranked) {
      const position = positions.get(material.quotaGroupId) || 0;
      material.scanPosition = position;
      positions.set(material.quotaGroupId, position + 1);
    }
    materialBands.sort((a, b) => a.scanPosition - b.scanPosition || Number(!!b.nameEn) - Number(!!a.nameEn));
  }
  onWork({ type: 'plan', total: materialBands.reduce((n, m) => n + m.exteriorRanges.length * (usesSteam && usesBuff ? 2 : 1), 0) });
  const quotaText = plan.collectionSpecs
    ? plan.collectionSpecs.map(m => `${m.collection} × ${m.count}`).join('；')
    : materialBands.map(m => `${m.name} × ${m.count}`).join('；');
  onProgress(`${plan.collectionSpecs ? '按链接中的收藏品配额搜索全部同档枪皮' : '严格使用链接中的枪皮'}，共 ${plan.totalCount} 把：${quotaText}`);
  onProgress(`目标产物「${plan.targetOutput.name}」磨损 ${targetWear}，区间 [${outRange.join(', ')}]；需要平均归一化磨损 ${normalizedTarget.toFixed(10)}，允许低磨损与高磨损材料互相补偿，搜索已勾选档位的完整区间：${exteriors.map(k => WEAR_TIERS[k].label).join('、')}。`);

  const pool = [], offers = [], perItem = [], seenOrders = new Set(), assetSlots = new Map();
  const rejected = new Map();
  const rejectionCounts = material => {
    const counts = {};
    for (const reason of rejected.get(material.id)?.values() || []) counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  };
  const checkpointItems = resumeState ? (resumeState.items ||= {}) : {};
  const requests = resumeState ? (resumeState.requests ||= {}) : {};
  const request = async (key, work) => {
    signal?.throwIfAborted();
    if (requests[key]) return requests[key];
    const result = await work();
    signal?.throwIfAborted();
    // 正常返回空列表也已搜索完成，不能在重试其它失败项时重复抓取。
    if (result.ok && !result.partial && !result.stoppedEarly) requests[key] = result;
    return result;
  };
  const resumeInfo = () => {
    const pending = materialBands.filter(m => !checkpointItems[m.id]?.complete)
      .map(m => ({ id: m.id, name: m.name, collection: m.collection }));
    return { id: resumeState?.id || null, canContinue: !!resumeState && pending.length > 0, pending };
  };
  const saveInterruptedItem = (material, errors) => {
    if (!resumeState) return;
    const available = pool.filter(l => l.recipeMaterialId === material.id).length;
    const itemResult = { name: material.name, collection: material.collection, group: material.quotaGroupId,
      required: material.count || 0, available, errors };
    // 超时/取消会在当前请求完成前跳出，必须先把当前材料标记为未完成，
    // 否则服务端只能看到之前已完成的材料，页面也不会显示继续按钮。
    checkpointItems[material.id] = { complete: false, perItem: itemResult,
      scanMode: 'exteriors-v2', exteriors,
      nameEn: material.nameEn, searchBand: material.band,
      candidates: offers.filter(l => l.recipeMaterialId === material.id) };
    return itemResult;
  };
  if (resumeState) resumeState.pendingMaterials = materialBands.map(m => ({ id: m.id, name: m.name, collection: m.collection }));
  let cookies = null;
  if (usesSteam) {
    const stored = loadCookies('steam');
    cookies = stored.length ? stored.map(c => `${c.name}=${c.value}`).join('; ') : null;
  }
  const addListing = (listing, material, hashName, goodsId, market) => {
    const reject = reason => {
      if (!rejected.has(material.id)) rejected.set(material.id, new Map());
      rejected.get(material.id).set(`${market}:${listing.listingId || listing.orderId || JSON.stringify(listing)}`, reason);
    };
    const wear = market === 'steam' ? listing.floatvalue : listing.paintwear;
    // 仅接收勾选档位且位于该皮肤实际可用区间的挂单；归一化仍用皮肤完整区间。
    const tier = exteriorKey(market === 'steam' ? listing.marketHashName : listing.marketHashName || hashName || listing.name);
    const selectedRange = tier && exteriors.includes(tier) && exteriorRange(tier, material.range);
    if (!selectedRange || exteriorKey(hashName) !== tier) return reject('非所选品质档');
    const [lo, hi] = selectedRange;
    if (!Number.isFinite(wear)) return reject('缺少真实 float');
    if (wear < lo || wear > hi) return reject('float 超出皮肤或品质区间');
    if (market === 'steam') {
      if (!steamListingMatches(listing, hashName)) return reject('商品身份不匹配');
    } else {
      if (String(listing.goodsId) !== String(goodsId)) return reject('商品身份不匹配');
      if (listing.name && (skinIdentity(listing.name) !== skinIdentity(material.name) ||
          nameFlags(listing.name).statTrak !== statTrak || nameFlags(listing.name).souvenir)) return reject('商品身份不匹配');
      if (listing.marketHashName && material.nameEn && skinIdentity(listing.marketHashName) !== skinIdentity(material.nameEn)) return reject('商品身份不匹配');
    }
    const orderId = market === 'steam' ? listing.listingId : listing.orderId;
    const key = `${market}:${orderId}`;
    if (!orderId) return reject('缺少挂单 ID');
    if (seenOrders.has(key)) return;
    seenOrders.add(key);
    const url = market === 'steam' ? steamListingUrl(listing.marketHashName, orderId) : listing.buyUrl || listing.url;
    const candidate = { ...listing, raw: undefined, market, recipeMaterialId: material.id,
      price: Number.isFinite(listing.price) && listing.price >= 0 ? listing.price : null,
      currencyId: market === 'buff' ? 23 : currencyOf(listing),
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
      if (cheaperThan(candidate, existing)) pool[slot] = candidate;
      return;
    }
    assetSlots.set(asset, pool.length);
    pool.push(candidate);
    offers.push(candidate);
  };

  const quotaSpecs = plan.collectionSpecs || materialBands;
  const quotas = Object.fromEntries(quotaSpecs.map(m => [m.id, m.count]));
  const targetSum = normalizedTarget * plan.totalCount;
  let steamLimited = false;
  let feasible = { pool, reachable: false, shortage: true };
  let bestFit = null;
  let lastFitSize = -1;
  const targetInfo = outputTargetInfo(targetWear, plan.totalCount, ...outRange);
  const fitCurrentPool = () => {
    feasible = feasibleCandidates(pool, quotas, targetSum, outRange, plan.totalCount);
    if (feasible.shortage || pool.length === lastFitSize) return;
    lastFitSize = pool.length;
    const candidates = (feasible.reachable && feasible.pool.length >= plan.totalCount ? feasible.pool : pool).slice().sort(comparePrices);
    const seed = bestFit?.materials.map(m => candidates.findIndex(c => listingKey(c) === listingKey(m)));
    const solved = solveCombinations(candidates.map(m => m.norm), {
      count: plan.totalCount, outMin: outRange[0], outMax: outRange[1], targetOut: targetWear,
      candidateGroups: candidates.map(m => m.recipeGroupId), groupCounts: quotas,
      seedIndices: seed?.every(i => i >= 0) ? seed : null,
      tries: 100, maxResults: 1, timeBudgetMs: Math.min(150, timeBudgetMs),
    });
    const result = solved.results[0];
    if (!result || (bestFit && result.score >= bestFit.score)) return;
    bestFit = { score: result.score, materials: result.indices.map(i => candidates[i]) };
    onProgress(`增量拟合：候选 ${pool.length} 笔，当前最优产物误差 ${result.score.toExponential(3)}${result.score === 0 ? '，已精确命中' : ''}。`);
  };
  const pageStates = resumeState ? (resumeState.steamPages ||= {}) : {};
  const buffPageStates = resumeState ? (resumeState.buffPages ||= {}) : {};
  for (const [index, material] of materialBands.entries()) {
    signal?.throwIfAborted();
    let skipped = false;
    const skipThisMaterial = () => (skipped ||= shouldSkip() || false);
    onWork({ type: 'materialStart', id: material.id, name: material.name });
    if (skipThisMaterial()) {
      const errors = ['用户选择进入下一把武器'];
      saveInterruptedItem(material, errors);
      onProgress(`[${index + 1}/${materialBands.length}] ${material.name}：已跳过，进入下一把武器；当前断点保留，可稍后继续`);
      const itemResult = { name: material.name, collection: material.collection, group: material.quotaGroupId,
        required: material.count || 0, available: pool.filter(l => l.recipeMaterialId === material.id).length, errors };
      perItem.push(itemResult);
      if (resumeState) checkpointItems[material.id] = { complete: false, perItem: itemResult,
        scanMode: 'exteriors-v2', exteriors, nameEn: material.nameEn, searchBand: material.band,
        candidates: offers.filter(l => l.recipeMaterialId === material.id) };
      onWork({ type: 'materialEnd', id: material.id });
      continue;
    }
    const saved = checkpointItems[material.id];
    if (saved?.nameEn) material.nameEn = saved.nameEn;
    // 旧库存/半径缓存不可作为新档位搜索已完成的证明。
    const compatible = saved?.scanMode === 'exteriors-v2' && JSON.stringify(saved.exteriors) === JSON.stringify(exteriors);
    if (compatible) for (const listing of saved.candidates || []) {
      addListing(listing, material, listing.marketHashName, listing.goodsId, listing.market);
    }
    if (compatible && saved.complete) {
      perItem.push(saved.perItem);
      onProgress(`[${index + 1}/${materialBands.length}] ${material.name}：复用已完成搜索，${saved.perItem.available} 件材料（所选档位均已完成）`);
      for (let i = 0; i < material.exteriorRanges.length * (usesSteam && usesBuff ? 2 : 1); i++) onWork({ type: 'tierDone' });
      fitCurrentPool();
      onWork({ type: 'materialEnd', id: material.id });
      continue;
    }
    const errors = [];
    saveInterruptedItem(material, errors);
    onProgress(`[${index + 1}/${materialBands.length}] ${material.name}：逐档搜索所选品质的完整 float 区间，保留挂单并增量拟合`);
    let variants = [];
    try {
      if (usesBuff) {
        const listed = await request(`buff:goods:${material.id}`, () => buff.listGoods({ search: material.name, pageSize: 50 }));
        if (!listed.ok) errors.push(`BUFF：${listed.kind || '商品查询失败'}`);
        else variants = listed.items.filter(g => matchesGoods(g, material, statTrak));
      }
      if (usesSteam && !steamLimited && !material.nameEn) {
        if (variants[0]?.market_hash_name) material.nameEn = variants[0].market_hash_name;
        else if (steam.search) {
          const found = await request(`steam:search:${material.id}`, () => steam.search({ query: material.name, count: 20, language: 'schinese' }));
          const match = found.ok && found.results?.find(item => {
            const flags = nameFlags(item.name);
            return !!item.name && !flags.souvenir && !flags.knifeOrGlove &&
              (skinIdentity(item.localizedName) === skinIdentity(material.name) || findInDbByBuffName(item.localizedName)?.key === material.id);
          });
          material.nameEn = match?.name || null;
          if (!match) delete requests[`steam:search:${material.id}`];
        }
      }
      for (const tier of material.exteriorRanges) {
        if (skipThisMaterial()) { skipped = true; break; }
        const [lo, hi] = tier.range;
        if (usesSteam) {
          if (steamLimited) { errors.push('Steam：限流，请稍后继续未完成档位'); break; }
          if (!material.nameEn) { errors.push('没有确认到该枪皮的 Steam 英文名'); break; }
          const stem = skinName(material.nameEn).replace(/^StatTrak™?\s*/i, '');
          const name = `${statTrak ? 'StatTrak™ ' : ''}${stem} (${WEAR_TIERS[tier.key].name})`;
          const key = `exteriors-v2:${name}:${lo}:${hi}`;
          const state = pageStates[key] ||= {};
          onWork({ type: 'tierStart' });
          onProgress(`  ${name}：${tier.label} float 区间 [${lo.toFixed(8)}, ${hi.toFixed(8)}]，逐页抓取 ...`);
          let lastNext = -1;
          while (!state.exhausted && !state.complete && !state.sampleComplete) {
            if (skipThisMaterial()) { skipped = true; break; }
            signal?.throwIfAborted();
            const before = state.nextPage || 0;
            const pages = Math.min(steamMaxPages, before + steamPages);
            if (pages <= before || before === lastNext) { errors.push(`Steam：${name} 分页尚未完成，请继续搜索`); break; }
            lastNext = before;
            onWork({ type: 'pageStart' });
            let reported = false;
            const result = await steam.listingsWithFloats(name, {
              cookies, pages, resumeState: state, minPaintwear: lo, maxPaintwear: hi,
              retainOutOfBand: false, allowOtherExteriors: false, randomPages: steamRandomPages,
              onWork: event => {
                onWork(event);
              },
              onPage: listings => {
                reported = true;
                for (const listing of listings) addListing(listing, material, name, undefined, 'steam');
                const accepted = pool.filter(l => l.recipeMaterialId === material.id).length;
                onProgress(`  ${name}：已抓第 ${state.nextPage || 1} 页${steamRandomPages ? `，随机抽页进度 ${state.fetchedPages?.length || 0}/${Math.min(steamRandomPages, state.totalPages || steamRandomPages)}` : ''}，抓取层保留 ${listings.length} 件，求解池保留 ${accepted} 件真实材料。`);
                saveInterruptedItem(material, errors);
                fitCurrentPool();
                return !skipThisMaterial();
              },
            });
            for (const listing of result.listings || []) addListing(listing, material, name, undefined, 'steam');
            if (!reported && result.ok && !result.partial) onWork({ type: 'pageDone' });
            saveInterruptedItem(material, errors);
            fitCurrentPool();
            if (!result.ok || result.partial) {
              errors.push(`Steam：${result.error || '挂单查询失败'}`);
              if (result.rateLimited || [429, 500, 503].includes(result.status)) {
                steamLimited = true;
                onProgress('Steam 已限流，保留候选与逐档分页断点，暂停后续请求。');
              }
              break;
            }
            // 无分页状态的适配器已一次性返回结果；正式 Steam 适配器只在确认到底时完成。
            if (state.nextPage == null || state.exhausted || state.sampleComplete) state.complete = true;
            if (skipped) break;
          }
          if (state.complete || state.exhausted) onWork({ type: 'tierDone' });
        }
        if (usesBuff) {
          if (skipped) break;
          onWork({ type: 'tierStart' });
          const goods = variants.filter(v => exteriorKey(v.market_hash_name || v.name) === tier.key);
          for (const variant of goods) {
            if (skipThisMaterial()) break;
            const name = variant.market_hash_name || variant.name;
            const buffState = buffPageStates[variant.id] ||= { fetched: [] };
            const queue = steamRandomPages ? (buffState.sampled || [1]).filter(p => !buffState.fetched.includes(p)) : [];
            for (let index = 0, page = steamRandomPages ? queue[0] : 1; page != null && page <= buffPages;
              page = steamRandomPages ? queue[++index] : page + 1) {
              if (skipThisMaterial()) break;
              onWork({ type: 'pageStart' });
              onProgress(`  ${name}：${tier.label} float 区间 [${lo.toFixed(8)}, ${hi.toFixed(8)}]，BUFF 第 ${page} 页 ...`);
              const result = await request(`buff:exteriors-v2:${variant.id}:${lo}:${hi}:${page}`, () =>
                buff.sellOrders({ goodsId: variant.id, minPaintwear: lo, maxPaintwear: hi, sortBy: 'price.asc', pageSize: 60, pageNum: page }));
              onWork({ type: 'pageDone', totalPages: steamRandomPages ? Math.min(steamRandomPages, result.totalPage || steamRandomPages) : result.totalPage });
              if (!result.ok) { errors.push(`BUFF：${result.kind || '挂单查询失败'}`); break; }
              for (const listing of result.listings) addListing(listing, material, name, variant.id, 'buff');
              if (steamRandomPages && !buffState.sampled) {
                const total = result.totalPage || (result.total != null ? Math.ceil(result.total / 60) : null);
                if (!total && result.listings.length) { errors.push('BUFF：无法确认总页数，已保留第一页，请继续重试'); break; }
                buffState.sampled = samplePages(total || 1, steamRandomPages).map(p => p + 1);
                queue.push(...buffState.sampled.filter(p => p !== page && !buffState.fetched.includes(p)));
              }
              if (!buffState.fetched.includes(page)) buffState.fetched.push(page);
              saveInterruptedItem(material, errors); fitCurrentPool();
              if (steamRandomPages) continue;
              if (!result.listings.length || (result.totalPage && page >= result.totalPage) || (result.total != null && page * 60 >= result.total)) break;
            }
          }
          onWork({ type: 'tierDone' });
        }
        if (skipped) break;
      }
    } catch (e) {
      saveInterruptedItem(material, [`请求中断：${e?.message || String(e)}`]);
      if (signal?.aborted) throw e;
      errors.push(`请求异常：${e?.message || String(e)}`);
    }
    const available = pool.filter(l => l.recipeMaterialId === material.id).length;
    if (skipped) errors.push('用户选择进入下一把武器');
    const itemResult = { name: material.name, collection: material.collection, group: material.quotaGroupId,
      required: material.count || 0, available, errors, rejected: rejectionCounts(material) };
    perItem.push(itemResult);
    if (resumeState) checkpointItems[material.id] = { complete: errors.length === 0, perItem: itemResult,
      scanMode: 'exteriors-v2', exteriors, nameEn: material.nameEn, searchBand: material.band,
      candidates: offers.filter(l => l.recipeMaterialId === material.id) };
    onProgress(`  ${material.name}：找到 ${available} 件不同的真实材料${errors.length ? `（${errors.join('；')}）` : ''}`);
    if (Object.keys(itemResult.rejected).length) onProgress(`  ${material.name}：排除原因：${Object.entries(itemResult.rejected).map(([reason, n]) => `${reason} ${n} 件`).join('；')}。`);
    fitCurrentPool();
    onWork({ type: 'materialEnd', id: material.id });
  }
  const eligiblePool = pool;
  feasible = feasibleCandidates(eligiblePool, quotas, targetSum, outRange, plan.totalCount);
  const shortages = plan.collectionSpecs
    ? plan.collectionSpecs.map(group => ({ ...group,
      available: eligiblePool.filter(l => l.recipeGroupId === group.id).length,
    })).filter(group => group.available < group.count)
    : perItem.map((m, i) => ({ ...m, available: eligiblePool.filter(l => l.recipeMaterialId === materialBands[i].id).length }))
      .filter(m => m.available < m.required);
  if (shortages.length) return {
    ok: false, error: steamLimited ? 'steam_rate_limited' : 'not_enough_recipe_materials', poolSize: eligiblePool.length, perItem,
    resume: resumeInfo(),
    message: (steamLimited ? 'Steam 限流导致本轮搜索未完成，已保留候选与分页进度。稍后点击“重试失败项（继续）”。当前缺口：' :
      plan.collectionSpecs ? '链接指定的收藏品配额不足：' : '链接指定的材料不足：') +
      shortages.map(m => `「${m.name || m.collection}」需要 ${m.required || m.count} 把，只找到 ${m.available} 把` +
        (m.errors?.length ? `（${m.errors.join('；')}）` : '')).join('；') +
        (steamLimited ? '。' : '。已按勾选档位搜索，失败项保留断点；可增加所选品质等级后重新搜索。'),
  };
  onProgress(`候选池 ${pool.length} 笔，按链接中的${plan.collectionSpecs ? '收藏品' : '材料'}固定数量求解 ...`);
  if (!feasible.reachable) onProgress('目标超出本次候选的磨损上下界，继续用全部真实材料寻找最近近似组合。');
  onProgress(`保留全部 ${pool.length} 笔真实材料：先选最近磨损组合，再用单件替换与两件补偿降低整组产物误差。`);
  pool.sort(comparePrices);
  onWork({ type: 'solver' });
  const startedSolving = Date.now();
  const exactCandidates = new Set(feasible.pool);
  const exactPool = feasible.reachable && feasible.pruned > 0 && feasible.pool.length >= plan.totalCount
    ? pool.filter(m => exactCandidates.has(m)) : pool;
  const solvePool = (candidates, budget, seedMaterials) => {
    const indicesInPool = new Map(pool.map((m, i) => [m, i]));
    const seed = seedMaterials?.map(m => candidates.indexOf(m));
    const result = solveCombinations(candidates.map(m => m.norm), {
      count: plan.totalCount, outMin: outRange[0], outMax: outRange[1], targetOut: targetWear,
      candidateGroups: candidates.map(m => m.recipeGroupId), groupCounts: quotas,
      seedIndices: seed?.every(i => i >= 0) ? seed : null,
      tries: 30000, maxResults: wants, timeBudgetMs: budget,
    });
    return result.results.map(r => ({ ...r, indices: r.indices.map(i => indicesInPool.get(candidates[i])).sort((a, b) => a - b) }));
  };
  let results = solvePool(exactPool, exactPool === pool ? timeBudgetMs : timeBudgetMs * 0.7, bestFit?.materials);
  if (exactPool !== pool && (!results.length || results[0].score > targetInfo.minimumScore)) {
    onProgress('精确拟合尚未命中，放回全部材料继续单件替换与两件补偿，保留当前最接近组合。');
    const remaining = Math.max(0, timeBudgetMs - (Date.now() - startedSolving));
    results.push(...solvePool(pool, remaining, results[0]?.indices.map(i => pool[i]) || bestFit?.materials));
  }
  const uniqueResults = new Map();
  for (const r of results) uniqueResults.set(r.indices.join(','), r);
  const rankedResults = [...uniqueResults.values()].sort((a, b) => a.score - b.score);
  const solved = { results: rankedResults.filter(r => r.score === rankedResults[0]?.score).slice(0, wants) };
  const recipes = solved.results.map(result => {
    const picks = result.indices.map(i => pool[i]);
    // 相同枪皮和实际 float32 磨损可换为更便宜的未使用挂单，产物磨损保持不变。
    const occupied = new Set(picks.map(assetKey));
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      const cheaper = pool.find(m => m.recipeMaterialId === pick.recipeMaterialId &&
        f32(m.paintwear) === f32(pick.paintwear) && cheaperThan(m, pick) && !occupied.has(assetKey(m)));
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
    const totals = new Map();
    for (const m of picks) if (Number.isFinite(m.price)) {
      const currency = currencyOf(m);
      totals.set(currency, (totals.get(currency) || 0) + m.price);
    }
    const missingPrices = picks.filter(m => !Number.isFinite(m.price)).length;
    const costByCurrency = [...totals].map(([currencyId, total]) => ({ currencyId, total }));
    return { score, exact: score === 0, approximate: score !== 0, outputWear: calculatedWear, outputs,
      targetOutput: plan.targetOutput.name, cost: !missingPrices && totals.size === 1 && totals.has(23) ? totals.get(23) : null,
      costByCurrency, missingPrices,
      dataSource, statTrak, materials: dataSource === 'both' ? attachOffers(picks, offers) : picks };
  }).sort((a, b) => a.score - b.score || (a.cost ?? Infinity) - (b.cost ?? Infinity));
  if (!recipes.length) return { ok: false, error: 'no_recipe_solution', message: '在指定材料数量和搜索范围内未找到可用组合。', resume: resumeInfo() };
  return {
    ok: true, exteriors, dataSource, collectionName: plan.collection, materialGrade: plan.grade,
    outRange, targetOutput: plan.targetOutput.name, materialCount: materialBands.length,
    reachableRange: feasible.range,
    materialBands: plan.collectionSpecs ? [] : materialBands,
    collectionSpecs: plan.collectionSpecs,
    collectionBands: plan.collectionSpecs ? materialBands : [],
    requiredAvgNormalized: normalizedTarget, usableRanges: materialBands.map(m => m.range),
    skippedRanges: [], band: [Math.min(...materialBands.map(m => m.band[0])), Math.max(...materialBands.map(m => m.band[1]))],
    poolSize: pool.length,
    randomPages: steamRandomPages || null, exactFound: recipes.some(r => r.exact), bestScore: recipes[0].score,
    marketCounts: { buff: pool.filter(m => m.market === 'buff').length, steam: pool.filter(m => m.market === 'steam').length },
    statTrak, perItem, steamItems: usesSteam ? { perItem } : null,
    ieee754: { ...ieee754Info(targetWear), outputTarget: outputTargetInfo(targetWear, plan.totalCount, ...outRange) }, recipes,
    resume: resumeInfo(),
  };
}
