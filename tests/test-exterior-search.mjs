import assert from 'node:assert/strict';
import { locateCollection } from '../src/cs2up/location.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';
import { huntRecipe } from '../src/market/recipe-hunt.mjs';
import { EXTERIORS, exteriorRange, exteriorKey } from '../src/market/exteriors.mjs';
import { f32, outputWear } from '../src/tradeup/float.mjs';
import { SearchEta } from '../src/web/search-eta.mjs';
import { SteamMarket, parseValveSsrListings, steamWearFilter } from '../src/market/steam.mjs';
import { samplePages } from '../src/market/page-sampling.mjs';

const plan = locateCollection({ inputRarity: 'milspec', totalCount: 10,
  materials: [{ name: 'MAC-10 | 白杨丛', nameEn: 'MAC-10 | Poplar Thicket', count: 10 }],
  outputs: [{ name: 'M4A4 | 轰天闪' }] });
assert.equal(plan.ok, true, plan.message);
assert.deepEqual(plan.collectionSpecs.map(g => [g.collection, g.count]), [['寒带收藏品', 10]]);
const specs = materialsInCollection('寒带收藏品', 'milspec');
assert.equal(specs.length, 5);
const english = { 'MAC-10 | 白杨丛': 'MAC-10 | Poplar Thicket', 'XM1014 | 铜斑迷彩': 'XM1014 | Copperflage',
  'AK-47 | 寒翠': 'AK-47 | Wintergreen', 'MP5-SD | 黄金榕': 'MP5-SD | Gold Leaf', 'USP消音版 | 椰风花语': 'USP-S | Tropical Breeze' };
const first = specs.find(m => m.name === 'MAC-10 | 白杨丛');
const lows = Array(5).fill(f32(0.05)), highs = Array(5).fill(f32(0.55));
const target = outputWear([...lows, ...highs].map(wear => ({ wear, matMin: first.min, matMax: first.max })), ...plan.targetOutput.range);
const calls = [], checkpoint = { id: 'boreal', items: {} };
const rows = (name, wears, start) => wears.map((floatvalue, i) => ({ marketHashName: name, floatvalue, price: 1,
  currencyId: 23, listingId: `${name}:${start + i}`, assetId: `${name}:${start + i}` }));
const steam = {
  async search({ query }) { return { ok: true, results: [{ name: `${english[query]} (Field-Tested)`, localizedName: `${query} (久经沙场)` }] }; },
  async listingsWithFloats(name, options) {
    const material = specs.find(m => name.startsWith(english[m.name] + ' ('));
    const key = exteriorKey(name), range = exteriorRange(key, [material.min, material.max]);
    assert.deepEqual([options.minPaintwear, options.maxPaintwear], range);
    assert.equal(options.allowOtherExteriors, false);
    assert.equal(options.retainOutOfBand, false);
    const state = options.resumeState;
    const start = state.nextPage || 0;
    calls.push([name, start]);
    // 非首个枪皮没有挂单；首个枪皮在第五页才出现真实候选，不能四页后判空。
    state.listings ||= [];
    const last = material.key === first.key ? 6 : 1;
    for (let page = start; page < options.pages && page < last; page++) {
      options.onWork({ type: 'pageStart' });
      if (page === 4) state.listings.push(...rows(name, key === 'fn' ? lows : highs, page));
      // 插入未选档位及错词条的诱饵，即使价格低也不能采用。
      state.listings.push(...rows(`${english[material.name]} (Field-Tested)`, [f32(0.2)], page));
      state.listings.push(...rows(name, [key === 'fn' ? f32(0.55) : f32(0.05)], 100 + page));
      state.nextPage = page + 1;
      options.onWork({ type: 'pageDone', totalPages: last });
      await options.onPage(state.listings);
      if (state.nextPage === last) state.exhausted = true;
    }
    return { ok: true, listings: state.listings };
  },
};
const config = { recipePlan: plan, targetWear: target, exteriors: ['fn', 'bs'], dataSource: 'steam', steam, resumeState: checkpoint };
const result = await huntRecipe(config, { timeBudgetMs: 500 });
assert.equal(result.ok, true, result.message);
assert.equal(result.bestScore, 0);
assert.equal(result.recipes[0].materials.length, 10);
assert.ok(result.recipes[0].materials.every(m => ['fn', 'bs'].includes(exteriorKey(m.marketHashName))));
assert.ok(calls.some(([, page]) => page === 4));
assert.equal(new Set(calls.map(([name]) => name)).size, 10);
const before = calls.length;
assert.equal((await huntRecipe(config, { timeBudgetMs: 500 })).ok, true);
assert.equal(calls.length, before, '完成档位（包括缺货档位）不重复抓取');
assert.equal((await huntRecipe({ ...config, exteriors: [] }, {})).error, 'invalid_exteriors');
console.log('✓ 寒带五把枪皮按 FN / BS 独立全区间分页，第五页候选参与高低互补，错档拒绝，完成断点不重抓');

for (const [i, key] of Object.keys(EXTERIORS).entries()) {
  const r = exteriorRange(key, [0, 1]);
  assert.equal(r[0], f32(EXTERIORS[key].range[0]));
  if (i < 4) assert.ok(r[1] < f32(EXTERIORS[key].range[1]));
}
assert.deepEqual(exteriorRange('bs', [0, 0.55]), [f32(0.45), f32(0.55)]);
assert.equal(exteriorRange('bs', [0, 0.4]), null);
const html = `<script id="valve-ssr-data">${JSON.stringify({ listings: [], total_count: 121 })}</script>`;
assert.equal(parseValveSsrListings(html).rawTotal, 121);
const sampled = samplePages(50, 20, () => 0.42);
assert.equal(sampled.length, 20);
assert.equal(sampled[0], 0);
assert.equal(new Set(sampled).size, 20);
assert.ok(sampled.every(p => p >= 0 && p < 50));
console.log('✓ 随机抽页固定包含首页、无重复且不越界');
console.log('✓ 档位边界无重复，取皮肤上下限交集；Steam 总挂单数用于实际分页与时间估算');

// 正式 Steam 分页适配器集成：六页库存跨过四页批次，直到 total_count 确认到底。
const adapter = new SteamMarket({ minIntervalMs: 0 });
const adapterStarts = [];
adapter.fetch = async url => {
  const u = new URL(url), start = Number(u.searchParams.get('start') || 0);
  adapterStarts.push(start);
  const key = u.pathname.includes('Factory%20New') ? 'fn' : 'bs';
  const name = `${english[first.name]} (${EXTERIORS[key].name})`;
  assert.equal(u.searchParams.get('category_Exterior'), key === 'fn' ? 'WearCategory0' : 'WearCategory4');
  const range = exteriorRange(key, [first.min, first.max]);
  assert.equal(u.searchParams.get('assetproperty'), steamWearFilter(...range));
  const wear = key === 'fn' ? f32(0.05) : f32(0.55);
  const listings = Array.from({ length: Math.min(20, 101 - start) }, (_, i) => ({ listingid: `${key}:${start + i}`,
    description: { market_hash_name: name }, asset: { assetid: `${key}:${start + i}`, asset_properties: [{ propertyid: 2, float_value: wear }] },
    eCurrency: 23, unPrice: 100, unFee: 15 }));
  return { status: 200, finalUrl: url, body: `<script id="valve-ssr-data">${JSON.stringify({ listings, total_count: 101 })}</script>` };
};
const strictPlan = { ...plan, collectionSpecs: undefined, materialSpecs: [{ id: first.key, name: first.name,
  nameEn: english[first.name], count: 10, range: [first.min, first.max], collection: '寒带收藏品' }] };
const actual = await huntRecipe({ ...config, recipePlan: strictPlan, steam: adapter, resumeState: { id: 'adapter', items: {} } }, { timeBudgetMs: 500 });
assert.equal(actual.ok, true, actual.message);
assert.equal(adapterStarts.length, 12);
assert.deepEqual(adapterStarts.slice(0, 6), [0, 20, 40, 60, 80, 100]);
assert.equal(actual.perItem[0].available, 202);
console.log('✓ 正式 Steam 适配器逐档连续读取六页 101 笔，跨四页批次直到到底，并保留两档全部 202 笔候选');

let now = 0;
const eta = new SearchEta({ now: () => now });
assert.equal(eta.snapshot().etaMs, null);
eta.update({ type: 'plan', total: 25 });
eta.update({ type: 'tierStart' });
eta.update({ type: 'pageStart' });
now = 20000;
eta.update({ type: 'pageDone', totalPages: 8 });
assert.ok(eta.snapshot().etaMs > 120000, '全任务页数成本必须包含全部档位，不固定为两分钟');
now += 900000;
assert.equal(eta.snapshot().etaMs, null);
assert.equal(eta.snapshot().etaState, 'reestimating');
eta.update({ type: 'pageDone', totalPages: 16 });
assert.ok(eta.snapshot().etaMs > 120000);
eta.update({ type: 'solver' });
now += 45000;
assert.equal(eta.snapshot().etaMs, null, '预算过期不显示即将完成');
eta.update({ type: 'done' });
assert.equal(eta.snapshot().etaMs, 0);
console.log('✓ 整任务 ETA 根据页数与实测耗时增长，长等待重新估算，只有完成事件归零');
