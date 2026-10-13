/**
 * BUFF163 市场适配器。
 *
 * 全部参数与字段均经实测验证（详见 docs/BUFF-API.md）：
 *  - 列表/搜索：GET /api/market/goods —— 需登录；rarity / exterior / quality / itemset / search 等参数有效
 *  - 单品挂单：GET /api/market/goods/sell_order —— 每笔挂单带 asset_info.paintwear（精确磨损）
 *  - 单品详情：GET /api/market/goods/info —— paintwear_range / containers / sort_by_fields
 *  - 失败表达：HTTP 200 + {"code":"Login Required"|"System Error"}，必须判 code 不能判状态码
 */

import { defaultHeaders } from '../auth/session.mjs';
import { HttpClient } from '../util/http.mjs';

const ORIGIN = 'https://buff.163.com';

/** 磨损类别 → buff 的 exterior 参数值 */
export const EXTERIOR = {
  fn: 'wearcategory0', // 崭新出厂 0.00-0.07
  mw: 'wearcategory1', // 略有磨损 0.07-0.15
  ft: 'wearcategory2', // 久经沙场 0.15-0.38
  ww: 'wearcategory3', // 破损不堪 0.38-0.45
  bs: 'wearcategory4', // 战痕累累 0.45-1.00
};

export const EXTERIOR_RANGE = {
  fn: [0, 0.07], mw: [0.07, 0.15], ft: [0.15, 0.38], ww: [0.38, 0.45], bs: [0.45, 1.0],
};

/** 稀有度（材料要比产物低一档：隐秘产物 ← 保密材料） */
export const RARITY = {
  consumer: 'common_weapon',      // 消费级
  industrial: 'uncommon_weapon',  // 工业级
  milspec: 'rare_weapon',         // 军规级
  restricted: 'mythical_weapon',  // 受限
  classified: 'legendary_weapon', // 保密
  covert: 'ancient_weapon',       // 隐秘
};

/** 材料的稀有度 = 产物的下一档 */
export const MATERIAL_RARITY_OF = {
  industrial: 'consumer',
  milspec: 'industrial',
  restricted: 'milspec',
  classified: 'restricted',
  covert: 'classified',
  // 隐秘材料只能用于 5 合 1 出刀/手套
  extraordinary: 'covert',
  remarkable: 'covert',
  exotic: 'covert',
  high: 'covert',
  base: 'covert',
};

/** 每种稀有度对应的武器箱/收藏品来源（用于发现同源材料） */
export function parseWearFromName(name) {
  const m = String(name).match(/\((崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累)\)\s*$/);
  const map = { 崭新出厂: 'fn', 略有磨损: 'mw', 久经沙场: 'ft', 破损不堪: 'ww', 战痕累累: 'bs' };
  return m ? map[m[1]] : null;
}

export class BuffMarket {
  /**
   * @param {object} opts
   * @param {number} opts.minIntervalMs 请求间隔（buff 风控严格，默认 3s）
   */
  constructor({ minIntervalMs = 3000, verbose = true, signal } = {}) {
    this.http = new HttpClient({ minIntervalMs, maxRetries: 4, label: 'buff', verbose, signal });
    this.verbose = verbose;
  }

  _headers(extra = {}) {
    return defaultHeaders('buff', { 'x-requested-with': 'XMLHttpRequest', ...extra });
  }

  _log(...a) { if (this.verbose) console.log('[buff]', ...a); }

  /** 判断响应是否可用；Login Required 在匿名/额度耗尽时出现，需与真错误区分 */
  static classify(res) {
    const code = res?.data?.code;
    if (code === 'OK') return 'ok';
    if (code === 'Login Required') return 'login_required';
    if (code === 'System Error') return 'throttled';
    if (code === 'Path Not Found') return 'not_found';
    return res?.ok ? 'unknown' : 'network_error';
  }

  /**
   * 搜索市场列表。
   * @param {object} q
   * @param {number} q.pageNum
   * @param {number} q.pageSize
   * @param {string} q.rarity    RARITY 里的值
   * @param {string} q.exterior  EXTERIOR 里的值
   * @param {string} q.quality   normal | strange | unusual | unusual_strange
   * @param {string} q.itemset   收藏品/箱子，如 set_community_2
   * @param {string} q.search    名称关键字
   * @param {string} q.sortBy
   */
  async listGoods(q = {}, requestOptions = {}) {
    const p = new URLSearchParams({ game: 'csgo', page_num: String(q.pageNum || 1), page_size: String(q.pageSize || 50) });
    if (q.rarity) p.set('rarity', q.rarity);
    if (q.exterior) p.set('exterior', q.exterior);
    if (q.quality) p.set('quality', q.quality);
    if (q.itemset) p.set('itemset', q.itemset);
    if (q.categoryGroup) p.set('category_group', q.categoryGroup);
    if (q.category) p.set('category', q.category);
    if (q.search) p.set('search', q.search);
    // 注意：列表接口不接受 sort_by=default（会返回 Invalid Argument / Not a valid choice），
    // 而 sell_order 接口却接受。所以这里只在显式给了非 default 值时才带 sort_by。
    if (q.sortBy && q.sortBy !== 'default') p.set('sort_by', q.sortBy);
    if (q.minPrice != null) p.set('min_price', String(q.minPrice));
    if (q.maxPrice != null) p.set('max_price', String(q.maxPrice));

    const res = await this.http.getJson(`${ORIGIN}/api/market/goods?${p}`, this._headers(), requestOptions);
    const kind = BuffMarket.classify(res);
    if (kind !== 'ok') return { ok: false, kind, items: [], total: 0, res };
    // 注意：HttpClient 返回的 res.data 已经是解析后的 JSON，不要再 .data.data
    const d = res.data.data || {};
    return {
      ok: true, kind,
      items: d.items || [],
      total: d.total_count || 0,
      totalPage: d.total_page || 0,
      res,
    };
  }

  /** 单品详情：拿 paintwear_range（材料可用的磨损区间）与来源 */
  async goodsInfo(goodsId, requestOptions = {}) {
    const res = await this.http.getJson(
      `${ORIGIN}/api/market/goods/info?game=csgo&goods_id=${goodsId}`, this._headers(), requestOptions);
    const kind = BuffMarket.classify(res);
    if (kind !== 'ok') return { ok: false, kind, info: null };
    return { ok: true, kind, info: res.data.data };
  }

  /**
   * 单品挂单（带每笔精确磨损）。
   * @param {object} q
   * @param {number} q.goodsId
   * @param {number} q.pageNum
   * @param {string} q.sortBy   default | price.asc | paintwear.asc | paintwear.desc ...
   * @param {number} q.minPaintwear
   * @param {number} q.maxPaintwear
   */
  async sellOrders(q) {
    const p = new URLSearchParams({
      game: 'csgo', goods_id: String(q.goodsId), page_num: String(q.pageNum || 1),
      sort_by: q.sortBy || 'default', allow_tradable_cooldown: '1',
    });
    if (q.minPaintwear != null) p.set('min_paintwear', String(q.minPaintwear));
    if (q.maxPaintwear != null) p.set('max_paintwear', String(q.maxPaintwear));
    if (q.pageSize) p.set('page_size', String(q.pageSize));

    const res = await this.http.getJson(`${ORIGIN}/api/market/goods/sell_order?${p}`, this._headers());
    const kind = BuffMarket.classify(res);
    if (kind !== 'ok') return { ok: false, kind, listings: [], total: 0, res };
    const d = res.data.data || {};
    const items = d.items || [];
    const goodsInfos = d.goods_infos || {};
    const listings = items.map(it => this._toListing(it, goodsInfos));
    return {
      ok: true, kind, listings,
      total: d.total_count || 0,
      totalPage: d.total_page || 0,
      goodsInfo: goodsInfos[String(q.goodsId)] || null,
      res,
    };
  }

  /** 把 buff 挂单对象规整成内部结构 */
  _toListing(it, goodsInfos = {}) {
    const ai = it.asset_info || {};
    const gi = goodsInfos[String(it.goods_id)] || {};
    const tags = gi.tags || {};
    // 购买/查看链接：商品页是该 goods_id 的挂单列表；action_link 是该笔饰品的检视接口
    const goodsId = it.goods_id;
    const assetId = ai.assetid;
    const inspectPath = ai.action_link || (assetId ? `/api/market/cs2_inspect/?assetid=${assetId}` : null);
    return {
      market: 'buff',
      goodsId,
      orderId: it.id,
      assetId,
      paintwear: ai.paintwear != null ? parseFloat(ai.paintwear) : null,
      paintwearRaw: ai.paintwear,
      paintseed: ai.info?.paintseed ?? null,
      price: it.price != null ? parseFloat(it.price) : null,
      currency: 'CNY',
      tradable: !ai.has_tradable_cooldown,
      tradableUnfrozenTime: ai.tradable_unfrozen_time || null,
      name: gi.name || null,
      marketHashName: gi.market_hash_name || null,
      rarity: tags.rarity?.internal_name || null,
      exterior: tags.exterior?.internal_name || null,
      quality: tags.quality?.internal_name || null,
      itemset: tags.itemset?.internal_name || null,
      collectionName: tags.itemset?.localized_name || null,
      weapon: tags.weapon?.internal_name || null,
      iconUrl: ai.info?.icon_url || null,
      // url = 商品页（能直接下单）；inspectUrl = 该笔饰品检视
      url: goodsId ? `${ORIGIN}/goods/${goodsId}` : null,
      buyUrl: goodsId ? `${ORIGIN}/goods/${goodsId}#sell_order` : null,
      inspectUrl: inspectPath ? `${ORIGIN}${inspectPath}` : null,
    };
  }
}
