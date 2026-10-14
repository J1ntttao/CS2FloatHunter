import assert from 'node:assert/strict';
import { SteamMarket } from '../src/market/steam.mjs';
import { huntRecipe } from '../src/market/recipe-hunt.mjs';
import { f32 } from '../src/tradeup/float.mjs';

const name = 'MAC-10 | Poplar Thicket (Field-Tested)';
const adapter = new SteamMarket({ minIntervalMs: 0 });
const starts = [];
adapter.fetch = async url => {
  const start = Number(new URL(url).searchParams.get('start') || 0);
  starts.push(start);
  const listings = [200, 700, 701].map((price, i) => ({ listingid: `${start}:${i}`,
    description: { market_hash_name: name }, eCurrency: 23, unPrice: price, unFee: 0,
    asset: { assetid: `${start}:${i}`, asset_properties: [{ propertyid: 2, float_value: f32(0.2) }] } }));
  return { status: 200, finalUrl: url, body: `<script id="valve-ssr-data">${JSON.stringify({ listings, total_count: 1000 })}</script>` };
};
const state = {};
const options = { resumeState: state, randomPages: 20, minPaintwear: 0.15, maxPaintwear: 0.38 };
await adapter.listingsWithFloats(name, { ...options, onPage: () => false });
assert.equal(starts.length, 1);
assert.equal(state.listings.length, 3, '保留全部符合磨损区间的挂单，不按金额裁剪');
assert.equal(state.sampledPages.length, 20);
await adapter.listingsWithFloats(name, options);
assert.equal(starts.length, 20);
assert.equal(new Set(starts).size, 20);
assert.equal(state.sampleComplete, true);
await adapter.listingsWithFloats(name, options);
assert.equal(starts.length, 20, '完成随机页之后不再请求');
console.log('✓ 正式 Steam 抽 20 页不重复；中断保留页号，续搜补齐；不依赖人民币最低价');

// 聚合首页没有该档位人民币挂单时，仍应继续随机抓取后面的真实材料。
const noBaseline = new SteamMarket({ minIntervalMs: 0 });
const noBaselineStarts = [];
noBaseline.fetch = async url => {
  const start = Number(new URL(url).searchParams.get('start') || 0);
  noBaselineStarts.push(start);
  const listings = [{ listingid: `baseline:${start}`, eCurrency: start ? 23 : 1, unPrice: 20000, unFee: 0,
    description: { market_hash_name: start ? name : 'MAC-10 | Poplar Thicket (Factory New)' },
    asset: { assetid: `baseline:${start}`, asset_properties: [{ propertyid: 2, float_value: f32(start ? 0.2 : 0.05) }] } }];
  return { status: 200, finalUrl: url, body: `<script id="valve-ssr-data">${JSON.stringify({ listings, total_count: 40 })}</script>` };
};
const noBaselineResult = await noBaseline.listingsWithFloats(name, { randomPages: 2, minPaintwear: 0.15, maxPaintwear: 0.38 });
assert.equal(noBaselineResult.ok, true);
assert.deepEqual(noBaselineStarts, [0, 20]);
assert.equal(noBaselineResult.listings.length, 1);
assert.equal(noBaselineResult.listings[0].price, 200);
console.log('✓ 首页面缺少该档人民币最低价也继续抓取后续页，不裁剪高价挂单');

const plan = { ok: true, totalCount: 10, collection: 'test', grade: 'milspec',
  targetOutput: { name: 'target', range: [0, 1] }, outputSpecs: [{ name: 'target', range: [0, 1] }],
  materialSpecs: ['a', 'b'].map(id => ({ id, name: id, nameEn: `${id} | skin`, count: 5, range: [0, 1], collection: 'test' })) };
const skipAdapter = new SteamMarket({ minIntervalMs: 0 });
const fetched = [];
skipAdapter.fetch = async url => {
  const u = new URL(url), hash = decodeURIComponent(u.pathname.split('/').at(-1));
  const start = Number(u.searchParams.get('start') || 0);
  fetched.push([hash, start]);
  const listings = Array.from({ length: 10 }, (_, i) => ({ listingid: `${hash}:${start}:${i}`,
    description: { market_hash_name: hash }, eCurrency: 23, unPrice: 200, unFee: 0,
    asset: { assetid: `${hash}:${start}:${i}`, asset_properties: [{ propertyid: 2, float_value: f32(0.2) }] } }));
  return { status: 200, finalUrl: url, body: `<script id="valve-ssr-data">${JSON.stringify({ listings, total_count: 100 })}</script>` };
};
let current, requested = false;
const checkpoint = { id: 'skip', items: {} };
const cfg = { recipePlan: plan, dataSource: 'steam', steam: skipAdapter, targetWear: f32(0.2),
  exteriors: ['ft', 'bs'], steamRandomPages: 2, resumeState: checkpoint };
const result = await huntRecipe(cfg, { timeBudgetMs: 100, shouldSkip: () => { const value = requested; requested = false; return value; },
  onWork: event => {
    if (event.type === 'materialStart') current = event.id;
    if (event.type === 'pageDone' && current === 'a') requested = true;
  } });
assert.equal(result.ok, true, result.message);
assert.equal(fetched.filter(([n]) => n.startsWith('a |')).length, 1, '下一把不继续当前武器其它页或品质');
assert.ok(fetched.some(([n]) => n.startsWith('b |')));
assert.equal(checkpoint.items.a.complete, false);
assert.equal(checkpoint.items.a.candidates.length, 10);
assert.ok(result.recipes[0].materials.some(m => m.recipeMaterialId === 'a'));
const firstCount = fetched.length;
await huntRecipe(cfg, { timeBudgetMs: 100 });
assert.equal(fetched.length - firstCount, 3, '继续仅补抓当前武器剩余随机页和另一品质，不重复下一把');
assert.equal(new Set(fetched.map(([n, p]) => `${n}:${p}`)).size, fetched.length);
console.log('✓ 下一把保留当前页材料参与计算，跳过全部剩余档位；继续补抓未完成页且不重复');

const buffCalls = [];
const buffCfg = { ...cfg, recipePlan: { ...plan, materialSpecs: [ { ...plan.materialSpecs[0], count: 10 } ] },
  dataSource: 'buff', exteriors: ['ft'], steamRandomPages: 3, resumeState: { id: 'buff', items: {} } };
const buff = {
  listGoods: async () => ({ ok: true, items: [{ id: 1, name: 'a (久经沙场)', market_hash_name: 'a | skin (Field-Tested)' }] }),
  sellOrders: async ({ pageNum }) => { buffCalls.push(pageNum); return { ok: true, totalPage: 10, total: 600,
    listings: Array.from({ length: 10 }, (_, i) => ({ goodsId: 1, orderId: `${pageNum}:${i}`, price: i === 9 ? 7.01 : 2,
      paintwear: f32(0.2), marketHashName: 'a | skin (Field-Tested)' })) }; },
};
const buffResult = await huntRecipe(buffCfg, { buff, timeBudgetMs: 100 });
assert.equal(buffResult.ok, true, buffResult.message);
assert.equal(buffCalls.length, 3);
assert.equal(new Set(buffCalls).size, 3);
assert.equal(buffResult.poolSize, 30);
await huntRecipe(buffCfg, { buff, timeBudgetMs: 100 });
assert.equal(buffCalls.length, 3);
console.log('✓ BUFF 按品质随机抽页，保留全部价格候选，完成断点不重抓');

// 用户日志回归：抓取层保留几百笔，不能因为外币或缺少 assetid 而在求解层变成 0 笔。
const p90 = new SteamMarket({ minIntervalMs: 0 });
const p90Name = 'P90 | Neoqueen (Field-Tested)';
const logs = [];
p90.fetch = async url => {
  const start = Number(new URL(url).searchParams.get('start') || 0);
  const listings = Array.from({ length: 20 }, (_, i) => ({ listingid: `p90:${start + i}`,
    description: { market_hash_name: p90Name }, eCurrency: '1', unPrice: 100, unFee: 15,
    asset: { asset_properties: [{ propertyid: 2, float_value: f32(0.25) }] } }));
  return { status: 200, finalUrl: url, body: `<script id="valve-ssr-data">${JSON.stringify({ listings, total_count: 400 })}</script>` };
};
const p90Plan = { ...plan, materialSpecs: [{ id: 'p90', name: 'P90 | 元女王', nameEn: 'P90 | Neoqueen',
  count: 10, range: [0, 1], collection: 'test' }] };
const p90Result = await huntRecipe({ recipePlan: p90Plan, dataSource: 'steam', steam: p90, targetWear: 0.2,
  exteriors: ['ft'], steamRandomPages: 20, resumeState: { id: 'p90', items: {} } },
{ timeBudgetMs: 100, onProgress: message => logs.push(message) });
assert.equal(p90Result.ok, true, p90Result.message);
assert.equal(p90Result.perItem[0].available, 400);
assert.equal(p90Result.poolSize, 400);
assert.ok(logs.some(m => m.includes('求解池保留 400 件真实材料')));
assert.ok(logs.some(m => m.includes('找到 400 件不同的真实材料')));
assert.equal(p90Result.recipes[0].approximate, true);
assert.equal(p90Result.recipes[0].cost, null);
assert.equal(p90Result.recipes[0].costByCurrency[0].currencyId, 1);
assert.equal(new Set(p90Result.recipes[0].materials.map(m => m.listingId)).size, 10);
assert.ok(p90Result.bestScore > 0);
console.log('✓ P90 外币 400 笔、缺少 assetid 仍保留真实挂单；日志与求解池一致，返回近似十件且不把外币当人民币');

// 小候选池穷举对照：无精确解时，最近均值起点必须经过替换改善，并返回最小实际误差。
const nearestWears = { a: [0.16, 0.18, 0.2, 0.23, 0.28, 0.36], b: [0.17, 0.19, 0.22, 0.27, 0.31, 0.37] };
const nearestSteam = { async listingsWithFloats(hash) {
  const id = hash.startsWith('a |') ? 'a' : 'b';
  return { ok: true, listings: nearestWears[id].map((w, i) => ({ marketHashName: hash,
    listingId: `nearest:${id}:${i}`, assetId: `nearest:${id}:${i}`, currencyId: 23, price: 1, floatvalue: f32(w) })) };
} };
const nearestTarget = f32(0.23765432);
const nearest = await huntRecipe({ recipePlan: plan, dataSource: 'steam', steam: nearestSteam,
  exteriors: ['ft'], targetWear: nearestTarget }, { timeBudgetMs: 500 });
let oracle = Infinity;
for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
  let sum = 0;
  for (const [id, omit] of [['a', a], ['b', b]]) for (let i = 0; i < 6; i++) if (i !== omit) sum = f32(sum + f32(nearestWears[id][i]));
  oracle = Math.min(oracle, Math.abs(f32(sum / 10) - nearestTarget));
}
assert.equal(nearest.ok, true, nearest.message);
assert.equal(nearest.exactFound, false);
assert.equal(nearest.bestScore, oracle);
assert.equal(nearest.recipes[0].materials.filter(m => m.recipeMaterialId === 'a').length, 5);
console.log('✓ 无精确解的小候选池按 5/5 配额替换拟合，结果与全部 36 种真实组合的最小误差一致');
