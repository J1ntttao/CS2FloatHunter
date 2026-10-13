/**
 * 把 CS2UP 配方解析成本平台上真实可买的挂单。
 *
 * 配方给的是「需要 9 把 wear≈0.174 的双持贝瑞塔 | 天矢之眼」这种**目标**。
 * 本模块负责：
 *   1. 用 BUFF 搜索接口把中文名解析成 goods_id
 *   2. 拿该商品的磨损区间 paintwear_range
 *   3. 抓取磨损最接近目标值的在售挂单，按「离目标磨损的距离」排序
 *   4. 顺带解析产物（高一档）的区间，用于独立核对目标产物磨损
 *
 * 注意 BUFF 的搜索接口需要登录态（见 docs/BUFF-API.md）。
 */

import { BuffMarket } from './buff.mjs';
import { normalizeWear } from '../tradeup/float.mjs';

export class RecipeResolver {
  constructor({ intervalMs = 2200, verbose = true, maxPerMaterial = 40, signal } = {}) {
    this.buff = new BuffMarket({ minIntervalMs: intervalMs, verbose, signal });
    this.verbose = verbose;
    this.maxPerMaterial = maxPerMaterial;
    this.http = this.buff.http;
    this._rangeCache = new Map();
  }

  _log(...a) { if (this.verbose) console.log('[resolver]', ...a); }

  /** 搜索里去掉中文的磨损后缀，命中率更高 */
  static nameWithoutWear(name) {
    return String(name).replace(/\s*[（(](崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累)[)）]\s*$/, '').trim();
  }

  /**
   * 按名称找 goods_id。优先用完整名精确匹配，退化为去后缀搜索。
   * @returns {Promise<{goodsId:number, name:string, marketHashName:string, sellNum:number}|null>}
   */
  async resolveGoods(name) {
    const tries = [name, RecipeResolver.nameWithoutWear(name)];
    for (const q of tries) {
      const list = await this.buff.listGoods({ search: q, pageSize: 50 });
      if (!list.ok) {
        if (list.kind === 'login_required') throw new Error('BUFF 登录态失效，请重新运行 scripts/set-cookies.ps1 -Site buff');
        continue;
      }
      // 精确同名优先
      const exact = list.items.find(it => it.name === name);
      const hit = exact || list.items.find(it => RecipeResolver.nameWithoutWear(it.name) === RecipeResolver.nameWithoutWear(name));
      if (hit) {
        return { goodsId: hit.id, name: hit.name, marketHashName: hit.market_hash_name, sellNum: hit.sell_num, minPrice: hit.sell_min_price };
      }
      // 退而求其次：取第一个结果
      if (list.items.length && q === tries[tries.length - 1]) {
        const it = list.items[0];
        return { goodsId: it.id, name: it.name, marketHashName: it.market_hash_name, sellNum: it.sell_num, minPrice: it.sell_min_price, fuzzy: true };
      }
    }
    return null;
  }

  /** 取磨损区间（带缓存） */
  async wearRange(goodsId) {
    if (this._rangeCache.has(goodsId)) return this._rangeCache.get(goodsId);
    const g = await this.buff.goodsInfo(goodsId);
    const range = g.ok && g.info?.paintwear_range ? g.info.paintwear_range.map(Number) : null;
    this._rangeCache.set(goodsId, range);
    return range;
  }

  /**
   * 为一个「目标磨损」找真实挂单。
   * @param {{name:string, wear:number, count:number, collection:string}} mat
   */
  async resolveMaterial(mat, { band = 0.02 } = {}) {
    const goods = await this.resolveGoods(mat.name);
    if (!goods) {
      return { ...mat, ok: false, error: 'not_found', message: `BUFF 上找不到「${mat.name}」` };
    }
    const range = await this.wearRange(goods.goodsId);
    if (!range) {
      return { ...mat, goods, ok: false, error: 'no_range', message: `「${goods.name}」没有磨损区间数据` };
    }
    const [lo, hi] = range;
    const want = Number(mat.wear);
    const covLo = Math.max(lo, want - band);
    const covHi = Math.min(hi, want + band);

    let listings = [];
    let note = null;
    if (covHi <= covLo) {
      // 目标磨损落在该商品区间之外 —— 只能说清楚，不能假装能买
      note = `目标磨损 ${want} 不在该商品区间 [${lo}, ${hi}] 内`;
      const so = await this.buff.sellOrders({ goodsId: goods.goodsId, sortBy: 'paintwear.asc', pageSize: this.maxPerMaterial });
      if (so.ok) listings = so.listings.filter(l => l.paintwear != null);
    } else {
      const so = await this.buff.sellOrders({
        goodsId: goods.goodsId, minPaintwear: covLo, maxPaintwear: covHi,
        sortBy: 'paintwear.asc', pageSize: this.maxPerMaterial,
      });
      if (!so.ok) {
        return { ...mat, goods, range, ok: false, error: so.kind, message: `抓取「${goods.name}」挂单失败：${so.kind}` };
      }
      listings = so.listings.filter(l => l.paintwear != null);
    }

    // 先按“离目标磨损的距离”筛出最接近的若干个，再按价格从低到高排——
    // 用户真正要做的是挑便宜的买，磨损偏差已经单独列出来了。
    listings.sort((a, b) => Math.abs(a.paintwear - want) - Math.abs(b.paintwear - want));
    const picked = listings.slice(0, Math.max(mat.count, 1) * 6);
    picked.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

    return {
      ...mat, goods, range, ok: true, note,
      targetWear: want,
      candidates: picked.map(l => ({
        ...l,
        wearDelta: Math.abs(l.paintwear - want),
        norm: (range[1] - range[0]) > 0 ? normalizeWear(l.paintwear, range[0], range[1]) : null,
      })),
      totalListings: listings.length,
    };
  }

  /**
   * 解析整个配方。
   * @param {object} recipe fetchShareRecipe 的返回
   * @param {(msg:string)=>void} onProgress
   */
  async resolveRecipe(recipe, { band = 0.02, onProgress = () => {} } = {}) {
    const result = { materials: [], outputs: [], warnings: [] };

    for (let i = 0; i < recipe.materials.length; i++) {
      const m = recipe.materials[i];
      onProgress(`[${i + 1}/${recipe.materials.length}] 查找「${m.name}」目标磨损 ${m.wear} ...`);
      try {
        const r = await this.resolveMaterial(m, { band });
        result.materials.push(r);
        if (!r.ok) result.warnings.push(r.message);
        else if (r.note) result.warnings.push(`「${r.goods?.name || m.name}」：${r.note}`);
      } catch (e) {
        result.materials.push({ ...m, ok: false, error: 'exception', message: e.message });
        result.warnings.push(e.message);
      }
    }

    // 产物区间（用于独立核对目标磨损）
    for (const o of recipe.outputs) {
      const goods = await this.resolveGoods(o.name);
      if (!goods) { result.outputs.push({ ...o, ok: false }); continue; }
      const range = await this.wearRange(goods.goodsId);
      result.outputs.push({ ...o, ok: !!range, goodsId: goods.goodsId, range, url: goods.goodsId ? `https://buff.163.com/goods/${goods.goodsId}` : null });
    }

    // 用产物区间反算「这 10 把材料会炼出什么磨损」，与 CS2UP 的值对照。
    // 注意：recipe.materials 是**归并后**的（例：9 把天矢之眼 + 1 把纸老虎 共 2 条），
    // 必须按 count 展开成完整的 10 把再算，否则会算成“2 把材料的平均”而得出错误结论。
    const withRange = result.outputs.find(o => o.range);
    if (withRange && recipe.materials.length) {
      const mats = [];
      for (const m of recipe.materials) {
        const r = result.materials.find(x => x.name === m.name);
        const rg = r?.range;
        if (!rg) { mats.length = 0; break; }
        for (let i = 0; i < m.count; i++) mats.push({ wear: m.wear, matMin: rg[0], matMax: rg[1] });
      }
      if (mats.length === recipe.totalCount) {
        const { outputWear } = await import('../tradeup/float.mjs');
        const computed = outputWear(mats, withRange.range[0], withRange.range[1]);
        result.crossCheck = {
          computed,
          fromCs2up: recipe.targetWear,
          materialCount: mats.length,
          match: recipe.targetWear != null && Math.abs(computed - recipe.targetWear) < 1e-6,
        };
      } else {
        result.crossCheck = { skipped: 'material_count_mismatch', got: mats.length, want: recipe.totalCount };
      }
    }

    return result;
  }
}
