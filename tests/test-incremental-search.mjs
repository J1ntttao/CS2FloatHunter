import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchShareRecipe } from '../src/cs2up/recipe.mjs';
import { locateCollection } from '../src/cs2up/location.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';
import { exteriorRange, exteriorKey } from '../src/market/exteriors.mjs';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { f32, outputWear, requiredNormalizedSum } from '../src/tradeup/float.mjs';

const payload = JSON.parse(fs.readFileSync(new URL('../ref/cs2up/sample-payload-372cce2ca3253c7c.json', import.meta.url)));
const originalFetch = globalThis.fetch;
let plan;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, item: { payload } }));
  plan = locateCollection(await fetchShareRecipe('372cce2ca3253c7c'));
} finally { globalThis.fetch = originalFetch; }
assert.equal(plan.ok, true);
assert.deepEqual(plan.collectionSpecs.map(g => g.count), [1, 1, 8]);
const target = f32(0.20001016);
const specs = plan.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade).map(m => ({
  id: m.key, name: m.name, range: [m.min, m.max], collection: g.collection,
  nameEn: plan.materialSpecs.find(s => s.id === m.key)?.nameEn || `Test ${m.key}`,
})));
const selected = [plan.materialSpecs[0], plan.materialSpecs[1], ...Array(8).fill(plan.materialSpecs[2])];
const wears = [f32(0.85), f32(0.9), ...Array(7).fill(f32(0.065))];
const center = f32((requiredNormalizedSum(target, 0, 0.77, 10) - 0.85 - 0.9 - 0.7) * 0.65);
const bytes = new DataView(new ArrayBuffer(4));
bytes.setFloat32(0, center);
const bits = bytes.getUint32(0);
let lastWear;
for (let offset = -1000; offset <= 1000; offset++) {
  bytes.setUint32(0, bits + offset);
  const wear = bytes.getFloat32(0);
  if (outputWear([...wears, wear].map((w, i) => ({ wear: w,
    matMin: selected[i].range[0], matMax: selected[i].range[1] })), 0, 0.77) === target) {
    lastWear = wear; break;
  }
}
assert.ok(lastWear != null, '构造真实 float32 可复算的 1 / 1 / 8 互补组合');
wears.push(lastWear);
const exterior = w => w < f32(0.07) ? 'Factory New' : w < f32(0.15) ? 'Minimal Wear'
  : w < f32(0.38) ? 'Field-Tested' : w < f32(0.45) ? 'Well-Worn' : 'Battle-Scarred';
const rowsFor = material => selected.flatMap((s, i) => s.id === material.id ? [{
  listingId: `planted:${i}`, assetId: `planted:${i}`, floatvalue: wears[i], price: 1 + i / 100,
  currencyId: 23, marketHashName: `${material.nameEn} (${exterior(wears[i])})`,
}] : []);
const makeSteam = ({ emptySample = false, highOnlyFull = false, limited = false } = {}) => {
  const calls = [];
  return { calls,
    async search({ query }) {
      const m = specs.find(s => s.name === query);
      return { ok: true, results: [{ name: `${m.nameEn} (Field-Tested)`, localizedName: `${m.name} (久经沙场)` }] };
    },
    async listingsWithFloats(name, options) {
      calls.push({ name, ...options });
      const material = specs.find(s => name.startsWith(s.nameEn + ' ('));
      assert.ok(material);
      if (limited) return { ok: false, status: 500, rateLimited: true, error: 'Steam 返回 500（限流）', listings: [] };
      let listings = rowsFor(material);
      if (emptySample && options.pages === 1) listings = [];
      if (highOnlyFull && options.pages >= 8 && options.minPaintwear == null && material.id === selected[2].id) {
        listings = Array.from({ length: 8 }, (_, i) => ({ listingId: `high:${i}`, assetId: `high:${i}`,
          floatvalue: f32(0.4), price: 2, currencyId: 23,
          marketHashName: `${material.nameEn} (Well-Worn)` }));
      }
      if (options.minPaintwear != null) listings = listings.filter(l =>
        l.floatvalue >= options.minPaintwear && l.floatvalue <= options.maxPaintwear);
      await options.onPage?.(listings);
      return { ok: true, listings };
    },
  };
};
const verify = result => {
  assert.equal(result.ok, true, result.message);
  assert.equal(result.bestScore, 0);
  const recipe = result.recipes[0];
  assert.equal(recipe.outputWear, target);
  assert.deepEqual(plan.collectionSpecs.map(g => recipe.materials.filter(m => m.recipeGroupId === g.id).length), [1, 1, 8]);
  assert.equal(new Set(recipe.materials.map(m => m.assetId)).size, 10);
  assert.ok(recipe.materials.some(m => m.paintwear > 0.8));
  assert.ok(recipe.materials.some(m => m.paintwear < 0.07));
};
const hunter = new CollectionHunter({ intervalMs: 0 });
const progress = [];
const inventory = makeSteam();
verify(await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: ['fn', 'mw', 'ft', 'ww', 'bs'], steam: inventory },
  { timeBudgetMs: 500, onProgress: m => progress.push(m) }));
assert.ok(inventory.calls.every(c => {
  const m = specs.find(s => c.name.startsWith(s.nameEn + ' ('));
  const range = exteriorRange(exteriorKey(c.name), m.range);
  return c.minPaintwear === range[0] && c.maxPaintwear === range[1] && !c.allowOtherExteriors;
}));
assert.ok(progress.some(m => m.includes('增量拟合')));
assert.deepEqual([...new Set(inventory.calls.map(c => specs.find(s => c.name.startsWith(s.nameEn + ' (')).collection))],
  plan.collectionSpecs.map(g => g.collection));
console.log('✓ 真实分享配方 372cce2ca3253c7c / 0.20001016：按各档位完整区间抓取并增量拟合，FN 与 BS 互补精确命中，保留 1 / 1 / 8');

const excluded = await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: ['ft'], steam: makeSteam() }, { timeBudgetMs: 500 });
assert.equal(excluded.poolSize, 0, '未选档位的低高磨损不得进入候选');
console.log('✓ 取消 FN/BS 勾选后不能使用这些档位材料，也不能偷偷扩大搜索');

const legacyState = { id: 'legacy-empty', items: Object.fromEntries(specs.map(m => [m.id, {
  complete: true, candidates: [], searchBand: [0, 1], nameEn: m.nameEn,
  perItem: { name: m.name, group: m.collection, available: 0, errors: [] },
}])), requests: Object.fromEntries(specs.map(m => [`steam:listings:${m.nameEn} (Field-Tested)`, { ok: true, listings: [] }])) };
const upgraded = makeSteam();
verify(await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: ['fn', 'mw', 'ft', 'ww', 'bs'],
  steam: upgraded, resumeState: legacyState }, { timeBudgetMs: 500 }));
assert.ok(upgraded.calls.length);
const recovered = makeSteam();
verify(await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: ['fn', 'mw', 'ft', 'ww', 'bs'],
  steam: recovered, resumeState: legacyState }, { timeBudgetMs: 500 }));
assert.equal(recovered.calls.length, 0);
console.log('✓ 旧半径空断点重搜各所选档位；新断点保留高低磨损候选，继续不重抓');

const limited = makeSteam({ limited: true });
const limitedState = { id: 'limited', items: {} };
const result = await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: ['fn', 'mw', 'ft', 'ww', 'bs'],
  steam: limited, resumeState: limitedState });
assert.equal(result.error, 'steam_rate_limited');
assert.equal(limited.calls.length, 1);
assert.equal(result.resume.canContinue, true);
console.log('✓ Steam 限流后停止本轮挂单请求并保留继续入口，不误报市场缺货');
