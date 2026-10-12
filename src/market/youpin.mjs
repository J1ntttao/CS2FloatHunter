/**
 * 悠悠有品（youpin898）市场适配器。
 *
 * 实测结论（详见 docs/YOUPIN-API.md）：
 *  - 用移动端 ES 接口：POST /api/homepage/es/commodity/GetCsGoPagedList
 *    **匿名可用、无需任何鉴权头、没有 sign/HMAC**，且每笔挂单带精确磨损 Abrade（字符串）。
 *  - 榜单/模板列表：POST /api/homepage/es/template/GetCsGoPagedList —— 匿名可用，
 *    返回 Id(=templateId)、CommodityName、Rarity(中文)、Exterior(中文)、Price、OnSaleCount。
 *  - 匿名限制：pageIndex 只能为 1（翻页会返回 84103 登录门槛），pageSize 被忽略固定 20 条。
 *    所以每个模板最多只能拿到 20 笔挂单，且必须客户端过滤磨损。
 *  - 磨损区间过滤（minAbrade/maxAbrade）匿名不可用 → 只能按 exterior 选模板再客户端筛。
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultHeaders } from '../auth/session.mjs';
import { HttpClient } from '../util/http.mjs';

const API = 'https://api.youpin898.com';
const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 中文外饰 → 内部代号 + 磨损区间 */
export const EXTERIOR_BY_CN = {
  崭新出厂: { key: 'fn', range: [0, 0.07], hash: 'WearCategory0' },
  略有磨损: { key: 'mw', range: [0.07, 0.15], hash: 'WearCategory1' },
  久经沙场: { key: 'ft', range: [0.15, 0.38], hash: 'WearCategory2' },
  破损不堪: { key: 'ww', range: [0.38, 0.45], hash: 'WearCategory3' },
  战痕累累: { key: 'bs', range: [0.45, 1.0], hash: 'WearCategory4' },
};

/** 中文稀有度 → 内部代号（与 buff 的 RARITY 对齐） */
export const RARITY_BY_CN = {
  消费级: 'consumer', 工业级: 'industrial', 军规级: 'milspec',
  受限: 'restricted', 保密: 'classified', 隐秘: 'covert',
  非凡: 'extraordinary', 卓越: 'remarkable', 奇异: 'exotic',
};

export class YoupinMarket {
  constructor({ minIntervalMs = 2500, verbose = true } = {}) {
    this.http = new HttpClient({ minIntervalMs, maxRetries: 4, label: 'youpin', verbose });
    this.verbose = verbose;
    this._templateCache = null;
  }

  _log(...a) { if (this.verbose) console.log('[youpin]', ...a); }

  /** 统一判错：84103=登录门槛，84104=参数错误，-1=请求格式错误 */
  static classify(res) {
    const code = res?.data?.Code;
    if (code === 0) return 'ok';
    if (code === 84103) return 'login_required';
    if (code === 84104) return 'bad_params';
    if (code === 85100) return 'client_too_old';
    if (code === -1) return 'malformed';
    return res?.ok ? 'unknown' : 'network_error';
  }

  async _post(pathname, body) {
    const res = await this.http.postJson(`${API}${pathname}`, body, {
      'content-type': 'application/json',
      accept: 'application/json',
      ...defaultHeaders('youpin'),
      ...this.authHeaders(),
    });
    return { res, kind: YoupinMarket.classify(res) };
  }

  /** 登录态：悠悠用的是 authorization: <token>（token 存在网页 localStorage 的 uu_token） */
  authHeaders() {
    try {
      const cookiePath = path.join(ROOT, 'data', 'cookies.manual.youpin.json');
      if (fs.existsSync(cookiePath)) {
        const j = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        const tok = (j.cookies || []).find(c => c.name === 'token' || c.name === 'Authorization' || c.name === 'authorization');
        if (tok?.value) return { authorization: tok.value, ...(tok.value.startsWith('Bearer') ? {} : {}) };
      }
    } catch { /* 忽略 */ }
    return {};
  }

  /** 是否带上了登录态 */
  get hasAuth() { return Object.keys(this.authHeaders()).length > 0; }

  /**
   * 模板列表（= 单品目录）。拿到 templateId 才能查挂单。
   * 注意匿名只能 pageIndex=1，且每页固定 20 条，所以要靠多次不同 listType 扩大覆盖。
   */
  async listTemplates({ pageIndex = 1, listType = 10, rarity, exteriorCn } = {}) {
    const body = {
      filterMap: {}, gameId: 730, listSortType: 0, listType,
      pageIndex, pageSize: 20, sortType: 0, stickerAbrade: 0, stickersIsSort: false,
    };
    const { res, kind } = await this._post('/api/homepage/es/template/GetCsGoPagedList', body);
    if (kind !== 'ok') return { ok: false, kind, templates: [], total: 0 };
    let items = Array.isArray(res.data.Data) ? res.data.Data : [];
    if (rarity) items = items.filter(t => RARITY_BY_CN[t.Rarity] === rarity);
    if (exteriorCn) items = items.filter(t => t.Exterior === exteriorCn);
    return {
      ok: true, kind, templates: items.map(t => this._toTemplate(t)),
      total: res.data.TotalCount || 0,
    };
  }

  _toTemplate(t) {
    const ext = EXTERIOR_BY_CN[t.Exterior] || null;
    return {
      market: 'youpin',
      templateId: t.Id,
      name: t.CommodityName,
      marketHashName: t.CommodityHashName,
      rarity: RARITY_BY_CN[t.Rarity] || t.Rarity,
      exteriorCn: t.Exterior,
      exterior: ext?.key || null,
      range: ext?.range || null,
      price: t.Price != null ? parseFloat(t.Price) : null,
      onSaleCount: t.OnSaleCount ?? null,
      iconUrl: t.IconUrl,
      steamPrice: t.SteamPrice != null ? parseFloat(t.SteamPrice) : null,
    };
  }

  /**
   * 某个模板的在售挂单（含精确磨损 Abrade）。
   * 匿名只能 pageIndex=1 / 20 条，超出会返回 84103。
   */
  async commodityList({ templateId, pageIndex = 1, minAbrade, maxAbrade } = {}) {
    const body = {
      listSortType: '1', listType: 10, pageIndex, pageSize: 20,
      sortType: '1', templateId: String(templateId), status: '20', userId: '',
    };
    if (minAbrade != null) body.minAbrade = String(minAbrade);
    if (maxAbrade != null) body.maxAbrade = String(maxAbrade);
    const { res, kind } = await this._post('/api/homepage/es/commodity/GetCsGoPagedList', body);
    if (kind !== 'ok') return { ok: false, kind, listings: [], total: 0 };
    const list = res.data.Data?.CommodityList || [];
    const tpl = res.data.Data?.TemplateInfo || {};
    return {
      ok: true, kind,
      listings: list.map(c => this._toListing(c, tpl)),
      total: res.data.TotalCount || 0,
    };
  }

  _toListing(c, tpl = {}) {
    // 悠悠的挂单页用 commodity id：https://www.youpin898.com/goodInfo?id=<Id>
    const id = c.Id;
    return {
      market: 'youpin',
      templateId: c.TemplateId,
      orderId: id,
      commodityNo: c.CommodityNo,
      paintwear: c.Abrade != null ? parseFloat(c.Abrade) : null,
      paintwearRaw: c.Abrade,
      price: c.Price != null ? parseFloat(c.Price) : null,
      currency: 'CNY',
      name: c.CommodityName,
      marketHashName: tpl.commodityHashName || tpl.CommodityHashName || null,
      rarity: RARITY_BY_CN[tpl.rarityName] || null,
      exterior: EXTERIOR_BY_CN[tpl.exteriorName]?.key || null,
      warehousingTime: c.WarehousingTime || null,
      seller: c.UserNickName || null,
      iconUrl: c.IconUrl,
      url: id ? `https://www.youpin898.com/goodInfo?id=${id}` : null,
      buyUrl: id ? `https://www.youpin898.com/goodInfo?id=${id}` : null,
      inspectUrl: null,
    };
  }
}
