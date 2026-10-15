import assert from 'node:assert/strict';
import { cheapestCombination } from '../src/tradeup/cheapest.mjs';
import { f32, outputWearFromNormalizedSum } from '../src/tradeup/float.mjs';
import { huntRecipe } from '../src/market/recipe-hunt.mjs';

function oracle(norms, cfg) {
  let best = null;
  const selected = [];
  function visit(start) {
    if (selected.length === cfg.count) {
      if (Object.entries(cfg.groupCounts).some(([g, n]) => selected.filter(i => cfg.candidateGroups[i] === g).length !== n)) return;
      let sum = 0, cost = 0;
      for (const i of selected) { sum = f32(sum + norms[i]); cost += Math.round(cfg.prices[i] * 100); }
      const score = Math.abs(outputWearFromNormalizedSum(sum, cfg.count, cfg.outMin, cfg.outMax) - f32(cfg.targetOut));
      if (!best || score < best.score || (score === best.score && cost < best.cost)) best = { score, cost };
      return;
    }
    for (let i = start; i < norms.length; i++) { selected.push(i); visit(i + 1); selected.pop(); }
  }
  visit(0); return best;
}
const base = { count: 2, outMin: 0, outMax: 1, targetOut: 0.2,
  candidateGroups: ['A', 'B', 'A', 'B'], groupCounts: { A: 1, B: 1 },
  prices: [100, 100, 1, 1], timeBudgetMs: 2000 };
const simple = cheapestCombination(Array(4).fill(f32(0.2)), base);
assert.equal(simple.results[0].costUnits, 200);
assert.deepEqual(simple.results[0].indices, [2, 3]);
assert.equal(simple.optimization.proven, true);
assert.equal(simple.optimization.nodes, 0);
console.log('✓ 已命中磨损时仍选择最低价；达到价格下界无需枚举');

let state = 19283;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
for (let trial = 0; trial < 160; trial++) {
  const norms = Array.from({ length: 12 }, () => f32(trial % 3 ? random() : 0.2 + (random() - 0.5) * 1e-6));
  const cfg = { count: 6, outMin: trial % 2 ? 0.1 : 0, outMax: trial % 2 ? 0.77 : 1,
    targetOut: trial % 4 ? f32(random() * 0.7 + 0.1) : 0.20001016,
    candidateGroups: norms.map((_, i) => i % 3 + ''), groupCounts: { 0: 2, 1: 2, 2: 2 },
    prices: norms.map(() => Math.round(random() * 300) / 100), timeBudgetMs: 3000 };
  const expected = oracle(norms, cfg), got = cheapestCombination(norms, cfg);
  assert.equal(got.optimization.proven, true);
  assert.equal(got.results[0].score, expected.score, `trial ${trial}`);
  assert.equal(got.results[0].costUnits, expected.cost, `trial ${trial}`);
}
console.log('✓ 160 组固定种子穷举对照：混合配额、近似解、float32 边界的误差和最低价均一致');

const incomplete = cheapestCombination([0.1, 0.2, 0.3, 0.4].map(f32), { ...base, maxNodes: 0 });
assert.equal(incomplete.optimization.proven, false);
assert.equal(incomplete.optimization.reason, 'budget_exhausted');
const foreign = cheapestCombination(Array(4).fill(f32(0.2)), { ...base, prices: null });
assert.equal(foreign.optimization.proven, false);
assert.equal(foreign.optimization.reason, 'incomparable_prices');
console.log('✓ 预算耗尽和不可比价格不冒充最低价证明');

const many = cheapestCombination(Array(10000).fill(f32(0.2)), { count: 10, outMin: 0, outMax: 1,
  targetOut: 0.2, candidateGroups: Array(10000).fill('A'), groupCounts: { A: 10 },
  prices: Array.from({ length: 10000 }, (_, i) => 10000 - i), timeBudgetMs: 2000 });
assert.equal(many.optimization.proven, true);
assert.equal(many.results[0].costUnits, 5500);
assert.equal(many.optimization.nodes, 0);
console.log(`✓ 一万候选同磨损：${many.optimization.elapsedMs}ms 证明最低价，无组合枚举`);

const plan = { ok: true, totalCount: 10, collection: 'test', grade: 'milspec',
  targetOutput: { name: 'target', range: [0, 1] }, outputSpecs: [{ name: 'target', range: [0, 1] }],
  materialSpecs: [{ id: 'test', name: 'test', nameEn: 'test | skin', count: 10, range: [0, 1], collection: 'test' }] };
const wears = [...Array(6).fill(f32(0.16)), ...Array(6).fill(f32(0.24))];
const prices = [...Array(6).fill(0.1), 1, 2, 3, 4, 5, 6];
let targetSum = 0;
for (const i of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]) targetSum = f32(targetSum + wears[i]);
const targetOut = outputWearFromNormalizedSum(targetSum, 10, 0, 1);
const result = await huntRecipe({ recipePlan: plan, targetWear: targetOut, dataSource: 'steam', exteriors: ['ft'],
  steam: { async listingsWithFloats(hash) { return { ok: true, listings: wears.map((wear, i) => ({
    listingId: String(i), assetId: String(i), marketHashName: hash, floatvalue: wear, price: prices[i], currencyId: 23,
  })) }; } } }, { timeBudgetMs: 1000 });
assert.equal(result.ok, true);
assert.equal(result.optimization.proven, true);
const expected = oracle(wears, { count: 10, outMin: 0, outMax: 1, targetOut,
  candidateGroups: Array(12).fill('test'), groupCounts: { test: 10 }, prices });
assert.equal(result.bestScore, expected.score);
assert.equal(Math.round(result.recipes[0].cost * 100), expected.cost);
console.log('✓ 正式 huntRecipe 路径：最便宜十件不满足磨损时，输出穷举验证的最低价有效组合');
