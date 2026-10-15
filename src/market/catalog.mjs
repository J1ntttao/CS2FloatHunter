import fs from 'node:fs';
import path from 'node:path';
import { BuffMarket, RARITY } from './buff.mjs';
import { skinName, skinIdentity } from '../cs2up/location.mjs';
import { nameFlags, GRADE_CN } from '../cs2up/materials.mjs';

const GRADES = ['consumer', 'industrial', 'milspec', 'restricted', 'classified', 'covert'];
const WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const TTL = 24 * 60 * 60 * 1000;
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const tagsFor = item => item.goods_info?.info?.tags || {};
const fail = message => { throw new Error(message); };
const buffFailure = kind => kind === 'login_required' ? 'BUFF 要求登录，请更新 BUFF Cookie 后重试。'
  : kind === 'throttled' ? 'BUFF 暂时限流，请稍后重试。' : `BUFF 信息读取失败（${kind || '网络异常'}），请重试。`;

/** 来自 BUFF 市场页面的收藏品目录，保留上游 ID 和分类。 */
export function parseBuffCollections(html) {
  const section = html.split('id="search-itemset"')[1]?.split('</ul>')[0];
  if (!section) return [];
  let category = '收藏品';
  const items = [], seen = new Set();
  for (const match of section.matchAll(/<h6[^>]*>([^<]+)<\/h6>|<p\s+value="([a-zA-Z0-9_-]+)"[^>]*>([^<]+)<\/p>/g)) {
    if (match[1]) { if (match[1] !== '不限') category = decode(match[1]); continue; }
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    items.push({ id: match[2], name: decode(match[3]).trim(), category });
  }
  return items;
}

/** 缓存仅含公开商品资料，不保存请求头和登录凭证。 */
export class BuffCatalog {
  constructor({ directory = path.resolve(import.meta.dirname, '../../data/buff-catalog'), marketFactory } = {}) {
    this.directory = directory;
    this.marketFactory = marketFactory || (signal => new BuffMarket({ minIntervalMs: 2200, verbose: false, signal }));
    this.cache = new Map();
    this.file = path.join(directory, 'catalog.json');
    try { this.cache = new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))); } catch { /* 首次使用 */ }
  }
  cached(key, refresh) {
    const value = this.cache.get(key);
    return !refresh && value && Date.now() - value.fetchedAt < TTL ? structuredClone(value) : null;
  }
  save(key, value) {
    const entry = { ...value, fetchedAt: Date.now(), source: 'buff' };
    this.cache.set(key, entry);
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.cache)));
    fs.renameSync(temporary, this.file);
    return structuredClone(entry);
  }
  async collections({ refresh = false, signal } = {}) {
    const cached = this.cached('collections', refresh);
    if (cached) return cached;
    const market = this.marketFactory(signal);
    const response = await market.http.request('https://buff.163.com/market/csgo', {
      headers: market._headers(), expectJson: false, timeoutMs: 15000, maxRetries: 0,
    });
    signal?.throwIfAborted();
    const items = response.ok ? parseBuffCollections(response.raw) : [];
    if (!items.length) fail('无法读取 BUFF 收藏品目录，请确认登录态和网络后刷新。');
    return this.save('collections', { items });
  }
  async collection(id, statTrak = false, { refresh = false, signal } = {}) {
    const directory = await this.collections({ signal });
    const collection = directory.items.find(item => item.id === id);
    if (!collection) fail('收藏品选择无效，请刷新目录后重选。');
    const key = `items:${id}:${Number(statTrak)}`;
    const cached = this.cached(key, refresh);
    if (cached) return cached;
    const market = this.marketFactory(signal), groups = new Map();
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const result = await market.listGoods({ itemset: id, quality: statTrak ? 'strange' : 'normal', pageNum: page, pageSize: 80 },
        { timeoutMs: 15000, maxRetries: 0 });
      signal?.throwIfAborted();
      if (!result.ok) fail(buffFailure(result.kind));
      totalPages = Math.max(1, result.totalPage || Math.ceil(result.total / 80));
      if (totalPages > 100) fail('BUFF 返回的收藏品商品页数异常，请稍后重试。');
      if (!result.items.length && (result.total > 0 || totalPages > 1)) fail('BUFF 商品分页不完整，请刷新后重试。');
      for (const item of result.items) {
        const tags = tagsFor(item), flags = nameFlags(item.market_hash_name || item.name);
        const grade = Object.keys(RARITY).find(key => RARITY[key] === tags.rarity?.internal_name);
        if (!grade || !WEARS.some(w => item.market_hash_name?.endsWith(`(${w})`)) ||
            flags.souvenir || flags.knifeOrGlove || flags.statTrak !== statTrak) continue;
        if (tags.itemset?.internal_name && tags.itemset.internal_name !== id) continue;
        const nameEn = skinName(item.market_hash_name).replace(/^StatTrak™?\s*/i, '');
        const identity = skinIdentity(nameEn);
        if (!groups.has(identity)) groups.set(identity, { id: `${id}:${identity}`, name: skinName(item.name), nameEn,
          grade, collection: collection.name, variants: [] });
        const group = groups.get(identity);
        if (group.grade !== grade) fail('BUFF 返回的同皮肤稀有度不一致，请刷新后重试。');
        group.variants.push({ id: item.id, name: item.name, market_hash_name: item.market_hash_name,
          exterior: WEARS.findIndex(w => item.market_hash_name.endsWith(`(${w})`)) });
      }
    }
    const skins = [...groups.values()].sort((a, b) => a.nameEn.localeCompare(b.nameEn));
    const grades = GRADES.slice(1).filter((grade, index) => skins.some(s => s.grade === grade) && skins.some(s => s.grade === GRADES[index]))
      .map(grade => ({ key: grade, label: GRADE_CN[grade], materialGrade: GRADES[GRADES.indexOf(grade) - 1] }));
    return this.save(key, { collection, statTrak, skins, grades });
  }
  async fullSkin(skin, statTrak, { signal, refresh = false, market } = {}) {
    const key = `skin:${skin.id}:${Number(statTrak)}`;
    const cached = this.cached(key, refresh);
    if (cached) return cached.skin;
    const variants = skin.variants.slice().sort((a, b) => a.exterior - b.exterior);
    if (!variants.length) fail(`「${skin.name}」缺少外观商品，无法确认完整磨损区间。`);
    const details = new Map();
    const detail = async variant => {
      if (details.has(String(variant.id))) return details.get(String(variant.id));
      const result = await market.goodsInfo(variant.id, { timeoutMs: 15000, maxRetries: 0 });
      signal?.throwIfAborted();
      if (!result.ok) fail(buffFailure(result.kind));
      const info = result.info, flags = nameFlags(info.market_hash_name);
      const range = info.paintwear_range?.map(Number);
      if (skinIdentity(info.market_hash_name) !== skinIdentity(skin.nameEn) || flags.statTrak !== statTrak || flags.souvenir ||
          !range || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] > 1 || range[0] >= range[1]) {
        fail(`「${skin.name}」的 BUFF 商品身份或磨损区间异常，未采用该数据。`);
      }
      details.set(String(variant.id), info);
      return info;
    };
    const first = await detail(variants[0]);
    // 关联商品用于补齐无在售量等原因没有出现在列表中的外观。
    for (const related of first.relative_goods || []) {
      const exterior = WEARS.indexOf(related.tag);
      if (related.is_change || exterior < 0 || variants.some(v => String(v.id) === String(related.goods_id))) continue;
      variants.push({ id: related.goods_id, name: related.goods_name,
        market_hash_name: `${statTrak ? 'StatTrak™ ' : ''}${skin.nameEn} (${WEARS[exterior]})`, exterior });
    }
    variants.sort((a, b) => a.exterior - b.exterior);
    const low = await detail(variants[0]), high = await detail(variants.at(-1));
    const range = [Number(low.paintwear_range[0]), Number(high.paintwear_range[1])];
    if (range[0] >= range[1]) fail(`「${skin.name}」的完整磨损区间无效。`);
    const resolved = { ...skin, variants, range };
    // 使用 BUFF 详情中的来源标签校验等级，避免列表筛选参数被忽略。
    const rarity = tagsFor(first).rarity?.internal_name;
    if (rarity && rarity !== RARITY[skin.grade]) fail(`「${skin.name}」的 BUFF 稀有度不一致，请刷新。`);
    this.save(key, { skin: resolved });
    return resolved;
  }
  async plan(id, outputGrade, statTrak = false, { signal, refresh = false, onProgress = () => {} } = {}) {
    const list = await this.collection(id, statTrak, { signal, refresh });
    const grade = list.grades.find(g => g.key === outputGrade);
    if (!grade) fail('该收藏品没有所选等级的十合一配方，请重新选择产物等级。');
    const market = this.marketFactory(signal);
    const materials = [], outputs = [];
    const relevant = list.skins.filter(s => s.grade === outputGrade || s.grade === grade.materialGrade);
    for (const [index, skin] of relevant.entries()) {
      onProgress(`确认 BUFF 完整磨损区间 ${index + 1}/${relevant.length}：${skin.name}`);
      const full = await this.fullSkin(skin, statTrak, { signal, refresh, market });
      (skin.grade === outputGrade ? outputs : materials).push(full);
    }
    const collection = list.collection.name;
    const outputSpecs = outputs.map(s => ({ id: s.id, name: s.name, nameEn: s.nameEn, collection,
      range: s.range, probability: 1 / outputs.length }));
    return { ok: true, source: 'buff', materialSource: 'buff', collectionId: id, collection,
      fetchedAt: Date.now(), statTrak, grade: grade.materialGrade, outputGrade,
      inputRarityLabel: GRADE_CN[grade.materialGrade], outputRarityLabel: GRADE_CN[outputGrade],
      collections: [collection], totalCount: 10, materialCount: materials.length,
      materials: materials.map(m => m.name),
      materialSpecs: materials.map(m => ({ ...m, count: null, quotaGroupId: id })),
      collectionSpecs: [{ id, collection, grade: grade.materialGrade, count: 10, candidateCount: materials.length }],
      outputSpecs, targetOutput: outputSpecs[0], targetOutputIndex: 0 };
  }
}
