import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { locateCollection, planWithQuality } from '../src/cs2up/location.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';
import { f32, outputWear, recommendedWearFor } from '../src/tradeup/float.mjs';

const plan = locateCollection({ inputRarity: 'milspec', totalCount: 10,
  materials: [{ name: '内格夫 | 飞羽', nameEn: 'Negev | Ultralight', count: 7 },
    { name: 'M249 | 博客积木', nameEn: 'M249 | Bock Blocks', count: 3 }],
  outputs: [{ name: 'M4A1消音版 | 翠珀金' }],
});
assert.equal(plan.ok, true);
const specs = plan.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade).map(m => ({
  ...m, english: plan.materialSpecs.find(s => s.id === m.key)?.nameEn || 'Test ' + m.key,
})));
const hunter = new CollectionHunter({ intervalMs: 0 });
function clients({ complementary = false, reference = false, failSteam = false, sharedAsset = false, statTrak = false } = {}) {
  const calls = { buff: [], steam: [] };
  const original = m => plan.materialSpecs.some(s => s.id === m.key);
  const limit = (m, market) => !original(m) ? 0 : complementary
    ? m.key === '内格夫_飞羽' ? market === 'buff' ? 3 : 4 : market === 'buff' ? 1 : 2 : 16;
  const price = (m, market) => (m.key === '内格夫_飞羽') === (market === 'buff') ? 1 : 2;
  const wear = (m, market) => f32(recommendedWearFor(m.min, m.max, f32(0.2)) + (reference && market === 'buff' ? 0.0003 : 0));
  const enExterior = m => wear(m, 'steam') < 0.15 ? 'Minimal Wear' : 'Field-Tested';
  const cnExterior = m => wear(m, 'steam') < 0.15 ? '略有磨损' : '久经沙场';
  const listing = (m, market, i, hashName) => ({
    market, listingId: `${m.key}:${i}`, orderId: `${m.key}:${i}`, // 两边 ID 相同，必须区分市场。
    assetId: `${sharedAsset && i === 0 ? 'shared' : market}:${m.key}:${i}`,
    marketHashName: hashName, name: `${statTrak ? 'StatTrak™ ' : ''}${m.name} (${cnExterior(m)})`,
    floatvalue: wear(m, market), paintwear: wear(m, market), price: price(m, market), currencyId: 23,
    goodsId: m.key, buyUrl: `https://buff.163.com/goods/${encodeURIComponent(m.key)}#sell_order`,
  });
  const steam = {
    async search({ query }) {
      const m = specs.find(s => s.name === query); assert.ok(m);
      return { ok: true, results: [{ name: m.english + ' (Field-Tested)', localizedName: m.name + ' (久经沙场)' }] };
    },
    async listingsWithFloats(name) {
      calls.steam.push(name);
      assert.equal(name.startsWith('StatTrak™ '), statTrak);
      const m = specs.find(s => name.replace(/^StatTrak™ /, '').startsWith(s.english + ' (')); assert.ok(m);
      if (failSteam) return { ok: false, error: 'offline', listings: [] };
      return { ok: true, listings: Array.from({ length: limit(m, 'steam') }, (_, i) => listing(m, 'steam', i, name))
        .concat(original(m) ? [{ ...listing(m, 'steam', 900, 'Wrong Skin (Field-Tested)'), price: 0.01 }] : []) };
    },
    priceOverview() { throw new Error('双市场不能用商品最低价冒充具体磨损挂单价格'); },
  };
  const buff = {
    async listGoods({ search }) {
      const m = specs.find(s => s.name === search); assert.ok(m);
      return { ok: true, items: [{ id: m.key, name: `${statTrak ? 'StatTrak™ ' : ''}${m.name} (${cnExterior(m)})`,
        market_hash_name: `${statTrak ? 'StatTrak™ ' : ''}${m.english} (${enExterior(m)})` },
        { id: 'wrong', name: '另一把枪皮 (久经沙场)', market_hash_name: 'Wrong Skin (Field-Tested)' }] };
    },
    async sellOrders(query) {
      const m = specs.find(s => s.key === query.goodsId); assert.ok(m);
      calls.buff.push(query.goodsId);
      assert.equal(query.sortBy, 'price.asc');
      const hashName = `${statTrak ? 'StatTrak™ ' : ''}${m.english} (${enExterior(m)})`;
      return { ok: true, totalPage: 1, listings: Array.from({ length: limit(m, 'buff') }, (_, i) => listing(m, 'buff', i, hashName)) };
    },
  };
  return { buff, steam, calls };
}
async function search(options = {}) {
  const { buff, steam, calls } = clients(options);
  hunter.buff = buff;
  const result = await hunter.hunt({ recipePlan: plan, dataSource: 'both', steam, statTrak: !!options.statTrak,
    targetWear: 0.2, band: 0.002 }, { timeBudgetMs: 1000, wants: 3 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.dataSource, 'both');
  assert.equal(calls.buff.length, 14); assert.equal(calls.steam.length, 14);
  for (const recipe of result.recipes) {
    assert.deepEqual(plan.collectionSpecs.map(g => recipe.materials.filter(m => m.collectionName === g.collection).length), [7, 3]);
    assert.equal(new Set(recipe.materials.map(m => m.assetId)).size, 10);
    assert.equal(recipe.cost, recipe.materials.reduce((n, m) => n + m.price, 0));
    const actual = outputWear(recipe.materials.map(m => ({ wear: m.paintwear, matMin: m.matRange[0], matMax: m.matRange[1] })), ...plan.targetOutput.range);
    assert.equal(recipe.outputWear, actual);
    assert.equal(recipe.score, Math.abs(actual - f32(0.2)));
    const displayedAssets = new Set();
    for (const m of recipe.materials) {
      const own = m.marketOffers[m.market];
      assert.equal(own.selected, true); assert.equal(own.price, m.price); assert.equal(own.paintwear, m.paintwear);
      const b = m.marketOffers.buff, s = m.marketOffers.steam;
      if (s) assert.equal(new URL(s.url).searchParams.get('detail'), s.listingId);
      if (b) assert.ok(b.url.startsWith('https://buff.163.com/goods/'));
      for (const offer of [b, s].filter(Boolean)) {
        // 同一资产两边同时挂牌可以出现在同一行，但不能填充另一材料位置。
        if (offer.assetId === own.assetId && !offer.selected) continue;
        assert.ok(!displayedAssets.has(offer.assetId)); displayedAssets.add(offer.assetId);
      }
      if (b && s) assert.equal(m.cheaperMarket, b.price < s.price ? 'buff' : b.price > s.price ? 'steam' : null);
    }
  }
  return result;
}
const complementary = await search({ complementary: true });
assert.equal(complementary.poolSize, 10);
assert.deepEqual(complementary.marketCounts, { buff: 4, steam: 6 });
assert.equal(new Set(complementary.recipes[0].materials.map(m => m.market)).size, 2);
console.log('✓ 单边都凑不齐时，两边候选共同求解；挂单 ID 碰撞不误去重，收藏品 7 / 3 不变');
const comparable = await search();
assert.ok(comparable.recipes[0].materials.every(m => m.marketOffers.buff && m.marketOffers.steam));
assert.ok(comparable.recipes[0].materials.some(m => m.cheaperMarket === 'buff'));
assert.ok(comparable.recipes[0].materials.some(m => m.cheaperMarket === 'steam'));
assert.equal(comparable.recipes[0].cost, 10);
console.log('✓ 两边真实磨损、挂单价格和购买链接完整；相同磨损优先便宜挂单，实际总价可复算');
const references = await search({ reference: true });
assert.ok(references.recipes[0].materials.some(m => Object.values(m.marketOffers).some(o => o && !o.sameWear && o.delta > 0)));
assert.ok(references.recipes[0].materials.every(m => m.market === 'steam'));
console.log('✓ 其它市场不同磨损的便宜挂单仅作参考，不污染入炉磨损、总价或购买清单');
const duplicate = await search({ sharedAsset: true });
assert.equal(duplicate.poolSize, 62);
console.log('✓ 两边同时挂牌的同一资产只算一把，仍保留两边报价');
const partial = await search({ failSteam: true });
assert.ok(partial.recipes[0].materials.every(m => m.market === 'buff' && m.marketOffers.steam === null));
assert.ok(partial.perItem.some(m => m.errors.some(e => e.includes('offline'))));
console.log('✓ Steam 抓取失败时明确记录，结果仅使用真实 BUFF 数据，不伪造 Steam 报价');
await search({ statTrak: true });
assert.ok(planWithQuality(plan, true).targetOutput.name.startsWith('StatTrak™ '));
assert.equal(planWithQuality(planWithQuality(plan, true), false).targetOutput.name, plan.targetOutput.name);
console.log('✓ 暗金开关同时约束两个市场，并同步目标产物名称');

// 执行实际页面渲染函数，验证价格加粗、逐笔链接和缺货展示。
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const render = vm.createContext({ esc: String, money: v => '¥' + v.toFixed(2), wearFmt: v => v.toFixed(10) });
vm.runInContext(script.slice(script.indexOf('function marketOfferCell'), script.indexOf('function renderResult')), render);
const card = render.recipeCard(comparable.recipes[0], 0);
assert.ok(card.includes('<strong>¥1.00</strong>'));
assert.ok(card.includes('BUFF 购买') && card.includes('Steam 购买'));
assert.ok(card.includes('选中挂单总价'));
assert.ok(!card.includes('Steam 最低价'));
assert.ok(render.recipeCard(references.recipes[0], 0).includes('参考 · 磨损差'));
assert.ok(render.recipeCard(partial.recipes[0], 0).includes('本次范围内未找到可用挂单'));
console.log('✓ 实际页面加粗便宜价格，并列真实磨损与链接，明确不同磨损参考和单边缺货');

// 执行暗金默认值的真实事件处理器，覆盖旧请求迟到和手动覆盖。
const elements = Object.fromEntries(['link', 'stattrak', 'qualityNote'].map(id => [id, {
  value: '', checked: false, addEventListener(type, fn) { this[type] = fn; },
}]));
const requests = [], timers = [];
const quality = vm.createContext({ $: id => elements[id], AbortController, URLSearchParams,
  setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  fetch: url => new Promise(resolve => requests.push({ url, resolve })),
});
vm.runInContext(script.slice(script.indexOf('let qualitySid'), script.indexOf("let MARKET = 'buff';")), quality);
const startQuality = sid => {
  elements.link.value = sid; elements.link.input();
  return timers.at(-1)();
};
const sidA = 'aaaaaaaaaaaaaaaa', sidB = 'bbbbbbbbbbbbbbbb';
let pending = startQuality(sidA);
requests.at(-1).resolve({ json: async () => ({ ok: true, statTrak: true }) }); await pending;
assert.equal(elements.stattrak.checked, true);
pending = startQuality(sidB);
requests.at(-1).resolve({ json: async () => ({ ok: true, statTrak: false }) }); await pending;
assert.equal(elements.stattrak.checked, false);
pending = startQuality(sidA);
elements.stattrak.checked = false; elements.stattrak.change();
requests.at(-1).resolve({ json: async () => ({ ok: true, statTrak: true }) }); await pending;
assert.equal(elements.stattrak.checked, false);
const old = startQuality(sidB), oldRequest = requests.at(-1);
pending = startQuality(sidA);
requests.at(-1).resolve({ json: async () => ({ ok: true, statTrak: true }) }); await pending;
oldRequest.resolve({ json: async () => ({ ok: true, statTrak: false }) }); await old;
assert.equal(elements.stattrak.checked, true);
console.log('✓ 暗金链接自动勾选、普通链接取消勾选，手动关闭不被覆盖，旧链接迟到不污染新链接');

// 页面搜索请求必须把明确取消也传给服务端，而不是让链接暗金标志重新打开。
for (const id of ['go', 'stop', 'wear', 'band', 'interval', 'insecure', 'proxy']) elements[id] = { value: '', style: {}, checked: true };
elements.wear.value = '0.2';
const searchUrls = [];
quality.crypto = { randomUUID: () => 'ui-test' };
quality.statusLine = quality.reset = quality.renderLocated = quality.renderResult = () => {};
quality.MARKET_LABEL = { buff: 'BUFF' };
quality.EventSource = class {
  constructor(url) { searchUrls.push(url); }
  addEventListener() {}
  close() {}
};
const stopCode = script.slice(script.indexOf("let MARKET = 'buff';"), script.indexOf("$('stop').onclick = stopSearch;"));
const goCode = script.slice(script.indexOf("$('go').onclick ="), script.indexOf('function openBuyPanel'));
vm.runInContext(stopCode + goCode, quality);
elements.stattrak.checked = false; elements.stattrak.change();
elements.go.onclick();
assert.equal(new URL(searchUrls.at(-1), 'http://localhost').searchParams.get('stattrak'), '0');
elements.stattrak.checked = true; elements.stattrak.change();
elements.go.onclick();
assert.equal(new URL(searchUrls.at(-1), 'http://localhost').searchParams.get('stattrak'), '1');
console.log('✓ 实际搜索按钮把暗金开启和关闭分别传为 stattrak=1/0');
