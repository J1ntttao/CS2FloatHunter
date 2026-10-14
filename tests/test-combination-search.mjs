import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchShareRecipe } from '../src/cs2up/recipe.mjs';
import { locateCollection } from '../src/cs2up/location.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { combinationBands, feasibleCandidates } from '../src/market/combination-search.mjs';
import { f32, outputWear, outputTargetInfo, solveCombinations } from '../src/tradeup/float.mjs';
import { SteamMarket, steamWearFilter, parseValveSsrListings } from '../src/market/steam.mjs';

const payload = JSON.parse(fs.readFileSync(new URL('../ref/cs2up/sample-payload-d5427705d5d65b88.json', import.meta.url)));
const originalFetch = globalThis.fetch;
let recipe;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, item: { payload } }));
  recipe = await fetchShareRecipe('d5427705d5d65b88');
} finally { globalThis.fetch = originalFetch; }
const plan = locateCollection(recipe);
assert.equal(plan.ok, true);
assert.deepEqual(plan.collectionSpecs.map(g => g.count), [6, 1, 3]);
const target = f32(0.20001016);
const targetInfo = outputTargetInfo(target, 10, 0, 1);
assert.equal(targetInfo.exact, false);
assert.deepEqual(targetInfo.nearestOutputs, [0.20001015067100525, 0.20001018047332764]);
assert.equal(outputTargetInfo(0.2, 10, 0, 1).exact, true);
console.log('✓ 区分 float32 可表示性与产物公式可达性，识别目标被除以 10 的量化跳过');

const specs = plan.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade).map(m => ({
  id: m.key, name: m.name, range: [m.min, m.max], collection: g.collection,
  nameEn: plan.materialSpecs.find(s => s.id === m.key)?.nameEn || `Test ${m.key}`,
})));
const bands = combinationBands(specs, target, [0, 1], 10, 0.5);
assert.ok(bands.every(m => m.band[0] === f32(m.range[0]) && m.band[1] <= f32(m.range[1])));
assert.ok(bands[0].band[1] < 0.71 && bands[0].band[1] > 0.69);
const mixed = combinationBands([{ range: [0, 1] }, { range: [0.21, 0.79] }], 0.2, [0, 1], 10, 0.01);
assert.ok(Math.abs(mixed[0].band[0] - 0.19) < 1e-7);
assert.ok(Math.abs(mixed[1].band[0] - 0.3202) < 1e-7);
assert.ok(Math.abs(mixed[1].band[1] - 0.3318) < 1e-7);
console.log('✓ 半径 0.5 保留低高磨损互补区间；较小半径优先目标附近，避免退化为全区间');

const planted = Array(6).fill(f32(0.02)).concat(f32(0.65), f32(0.4), f32(0.4));
let sum = 0;
for (const norm of planted) sum = f32(sum + norm);
planted.push(f32(f32(target * 10) - sum));
const exterior = wear => wear < f32(0.07) ? 'Factory New' : wear < f32(0.15) ? 'Minimal Wear'
  : wear < f32(0.38) ? 'Field-Tested' : wear < f32(0.45) ? 'Well-Worn' : 'Battle-Scarred';
function steamClient({ poorOnly = false } = {}) {
  const queried = [];
  return { queried,
    async search({ query }) {
      const m = specs.find(s => s.name === query);
      return { ok: true, results: [{ name: `${m.nameEn} (Field-Tested)`, localizedName: `${m.name} (久经沙场)` }] };
    },
    async listingsWithFloats(name) {
      queried.push(name);
      const m = plan.materialSpecs.find(s => name.startsWith(s.nameEn + ' ('));
      if (!m) return { ok: true, listings: [] };
      const group = plan.materialSpecs.indexOf(m);
      const wears = group === 0 ? planted.slice(0, 6) : group === 1 ? planted.slice(6, 7) : planted.slice(7);
      const rows = (poorOnly ? [] : wears).map((wear, i) => ({ wear, id: `${m.id}:planted:${i}`, price: 1 + group + i / 100 }));
      for (let i = 0; i < 12; i++) rows.push({ wear: f32(0.2872408628), id: `${m.id}:poor:${i}`, price: 0.1 });
      return { ok: true, listings: rows.filter(r => name.endsWith(`(${exterior(r.wear)})`))
        .map(r => ({ listingId: r.id, assetId: r.id, marketHashName: name, floatvalue: r.wear, price: r.price, currencyId: 23 })) };
    },
  };
}
const hunter = new CollectionHunter({ intervalMs: 0 });
hunter.buff = { listGoods() { throw new Error('仅 Steam 不得查询 BUFF'); } };
const steam = steamClient();
const result = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.20001016, band: 0.5, steam },
  { timeBudgetMs: 1500, wants: 3 });
assert.equal(result.ok, true, result.message);
assert.equal(result.bestScore, targetInfo.minimumScore);
assert.equal(result.exactFound, false);
assert.ok(steam.queried.some(n => n.endsWith('(Factory New)')));
assert.ok(steam.queried.some(n => n.endsWith('(Battle-Scarred)')));
for (const r of result.recipes) {
  assert.deepEqual(plan.collectionSpecs.map(g => r.materials.filter(m => m.recipeGroupId === g.id).length), [6, 1, 3]);
  assert.equal(new Set(r.materials.map(m => m.assetId)).size, 10);
  assert.equal(r.outputWear, outputWear(r.materials.map(m => ({ wear: m.paintwear, matMin: m.matRange[0], matMax: m.matRange[1] })), 0, 1));
  assert.ok(r.materials.some(m => m.paintwear < 0.05));
  assert.ok(r.materials.some(m => m.paintwear > 0.35));
}
console.log(`✓ 用户分享配方仅 Steam / 半径 0.5：低高磨损互补，固定 6 / 1 / 3，产物 ${result.recipes[0].outputWear} 达到理论最小误差`);

const poor = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.20001016, band: 0.5, steam: steamClient({ poorOnly: true }) });
assert.equal(poor.error, 'target_not_reachable');
assert.ok(poor.reachableRange[0] > target);
assert.equal(poor.recipes, undefined);
assert.match(poor.message, /不会将偏离目标的组合作为推荐配方/);
console.log('✓ 当前候选只能产出 0.28724 时明确报目标不可达，不返回推荐配方');

const members = [0, 0.1, 0.3, 0.95, 0.05, 0.4, 0.8].map((norm, i) => ({ norm: f32(norm), recipeGroupId: i < 4 ? 'A' : 'B' }));
const filtered = feasibleCandidates(members, { A: 2, B: 1 }, 0.45, [0, 1], 3);
assert.equal(filtered.reachable, true);
assert.ok(filtered.pruned > 0);
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) for (let c = 4; c < 7; c++) {
  const chosen = [members[a], members[b], members[c]];
  if (Math.abs(chosen.reduce((s, m) => s + m.norm, 0) - 0.45) < 1e-7) {
    assert.ok(chosen.every(m => filtered.pool.includes(m)), '不能删掉满足配额的精确解材料');
  }
}
console.log('✓ 穷举复核剩余配额剪枝，保留所有满足目标的组合材料');

const norms = [0.18, 0.125, 0.21, 0.275].map(f32);
const compensated = solveCombinations(norms, { count: 2, outMin: 0, outMax: 1, targetOut: 0.2,
  candidateGroups: ['A', 'A', 'B', 'B'], groupCounts: { A: 1, B: 1 }, tries: 1, timeBudgetMs: 200 });
assert.equal(compensated.exactFound, true);
assert.deepEqual(compensated.results[0].indices, [1, 3]);
console.log('✓ 单点替换卡住时，通过剩余总和的二元补偿找到精确解');

const filter = Buffer.from(steamWearFilter(0.1, 0.3), 'base64');
assert.deepEqual([filter[0], filter[1], filter[2], filter[7]], [8, 2, 21, 29]);
assert.equal(filter.readFloatLE(3), f32(0.1));
assert.equal(filter.readFloatLE(8), f32(0.3));
const emptySsr = `<script id="valve-ssr-data">${JSON.stringify({ listings: [], total_count: 0 })}</script>`;
assert.equal(parseValveSsrListings(emptySsr).ok, true);
const market = new SteamMarket({ minIntervalMs: 0 });
const urls = [];
market.fetch = async url => {
  urls.push(url);
  return { status: 200, body: emptySsr,
    finalUrl: urls.length === 1 ? 'https://steamcommunity.com/market/listings/730/G123' : url };
};
const pageState = {};
const filteredSteam = await market.listingsWithFloats('MAC-10 | Light Box (Field-Tested)', {
  minPaintwear: 0.1, maxPaintwear: 0.3, sortBy: 'wear.asc', pages: 8, resumeState: pageState,
});
assert.equal(filteredSteam.ok, true);
assert.equal(urls.length, 2, '重定向丢参数后仅补请求聚合页一次，空结果立即停止');
const url = new URL(urls[1]);
assert.equal(url.pathname, '/market/listings/730/G123');
assert.equal(url.searchParams.get('assetproperty'), steamWearFilter(0.1, 0.3));
assert.equal(url.searchParams.get('category_Exterior'), 'WearCategory2');
assert.equal(url.searchParams.get('category_Quality'), 'normal');
assert.equal(url.searchParams.get('sort'), '1');
assert.equal(url.searchParams.get('dir'), '0');
assert.equal(url.searchParams.get('propertyid'), '2');
await market.listingsWithFloats('MAC-10 | Light Box (Field-Tested)', {
  minPaintwear: 0.1, maxPaintwear: 0.3, sortBy: 'wear.asc', pages: 16, resumeState: pageState,
});
assert.equal(urls.length, 2, '已确认空结果，不因增加页数请求不存在的后续页面');
console.log('✓ Steam 真实磨损过滤序列化、按磨损排序、跳转参数恢复及空结果解析');

const secondPayload = JSON.parse(fs.readFileSync(new URL('../ref/cs2up/sample-payload-4e16c950a29fd2e4.json', import.meta.url)));
let secondRecipe;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, item: { payload: secondPayload } }));
  secondRecipe = await fetchShareRecipe('4e16c950a29fd2e4');
} finally { globalThis.fetch = originalFetch; }
const secondPlan = locateCollection(secondRecipe);
assert.deepEqual(secondPlan.collectionSpecs.map(g => g.count), [4, 3, 3]);
const secondSpecs = secondPlan.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade)
  .map(m => ({ ...m, english: secondPlan.materialSpecs.find(s => s.id === m.key)?.nameEn || `Test ${m.key}` })));
const calls = [];
let lowSum = 0;
for (let i = 0; i < 4; i++) lowSum = f32(lowSum + f32(0.08));
for (let i = 0; i < 5; i++) lowSum = f32(lowSum + f32(0.28));
const lastWear = f32(f32(target * 10) - lowSum);
const state = { id: 'adaptive-resume', items: {} };
const adaptiveSteam = {
  async search({ query }) {
    const m = secondSpecs.find(s => s.name === query);
    return { ok: true, results: [{ name: `${m.english} (Field-Tested)`, localizedName: `${m.name} (久经沙场)` }] };
  },
  async listingsWithFloats(name, options) {
    calls.push({ name, ...options });
    const m = secondPlan.materialSpecs.find(s => name.startsWith(s.nameEn + ' ('));
    if (!m) return { ok: true, listings: [] };
    const gi = secondPlan.materialSpecs.indexOf(m);
    const initial = Array.from({ length: m.count }, (_, i) => gi === 2 && i === 2 ? lastWear : f32(0.28));
    const wears = options.sortBy === 'wear.asc' && gi === 0 && options.pages >= 16
      ? Array(4).fill(f32(0.08)) : initial;
    return { ok: true, listings: wears.map((wear, i) => ({
      listingId: `${m.id}:${wear}:${i}`, assetId: `${m.id}:${wear}:${i}`, floatvalue: wear,
      marketHashName: `${m.nameEn} (${exterior(wear)})`, currencyId: 23, price: 1,
    })).filter(l => l.marketHashName === name && l.floatvalue >= options.minPaintwear && l.floatvalue <= options.maxPaintwear) };
  },
};
const progress = [];
const adaptive = await hunter.huntFromSteam({ recipePlan: secondPlan, targetWear: target, band: 0.1,
  steam: adaptiveSteam, resumeState: state }, { timeBudgetMs: 500, onProgress: m => progress.push(m) });
assert.equal(adaptive.ok, true, adaptive.message);
assert.equal(adaptive.bestScore, targetInfo.minimumScore);
assert.deepEqual(secondPlan.collectionSpecs.map(g => adaptive.recipes[0].materials.filter(m => m.recipeGroupId === g.id).length), [4, 3, 3]);
assert.ok(calls.filter(c => !c.sortBy).every(c => c.maxPaintwear <= 0.301));
assert.ok(calls.some(c => c.sortBy === 'wear.asc' && c.pages === 8));
assert.ok(calls.some(c => c.sortBy === 'wear.asc' && c.pages === 16));
assert.ok(progress.some(m => m.includes('定向补抓低磨损')));
const resumeCalls = calls.length;
const resumed = await hunter.huntFromSteam({ recipePlan: secondPlan, targetWear: target, band: 0.1,
  steam: adaptiveSteam, resumeState: state }, { timeBudgetMs: 500 });
assert.equal(resumed.ok, true, resumed.message);
assert.equal(resumed.bestScore, targetInfo.minimumScore);
assert.equal(calls.length, resumeCalls, '补抓的低磨损材料在恢复时也必须保留，不重复请求');
console.log(`✓ 新分享配方 4 / 3 / 3：半径 0.1 首轮上限约 0.3，自动补抓 8→16 页低磨损材料，产物 ${adaptive.recipes[0].outputWear}，恢复不重抓`);

const partialState = { id: 'partial-supplement', items: {} };
const partialController = new AbortController();
const partialSteam = { ...adaptiveSteam, async listingsWithFloats(name, options) {
  if (options.sortBy === 'wear.asc' && options.pages === 16 &&
      name === `${secondPlan.materialSpecs[0].nameEn} (Field-Tested)`) {
    partialController.abort(new DOMException('补抓超时', 'TimeoutError'));
    throw partialController.signal.reason;
  }
  return adaptiveSteam.listingsWithFloats(name, options);
} };
await assert.rejects(new CollectionHunter({ intervalMs: 0, signal: partialController.signal }).huntFromSteam({
  recipePlan: secondPlan, targetWear: target, band: 0.1, steam: partialSteam, resumeState: partialState,
}), e => e.name === 'TimeoutError');
assert.ok(partialState.items[secondPlan.materialSpecs[0].id].candidates.some(m => m.paintwear < 0.1));
const partialCalls = calls.length;
const recovered = await hunter.huntFromSteam({ recipePlan: secondPlan, targetWear: target, band: 0.1,
  steam: adaptiveSteam, resumeState: partialState }, { timeBudgetMs: 500 });
assert.equal(recovered.ok, true, recovered.message);
assert.equal(recovered.bestScore, targetInfo.minimumScore);
assert.equal(calls.length, partialCalls, '已抓到足够的补偿材料，中断后复用候选与首轮请求即可求解');
console.log('✓ 定向补抓中途超时也保存已到手的低磨损材料，恢复后不丢候选、不重扫');
