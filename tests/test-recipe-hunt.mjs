import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fetchShareRecipe } from '../src/cs2up/recipe.mjs';
import { locateCollection } from '../src/cs2up/location.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { f32, normalizeWear, outputWear, recommendedWearFor, solveCombinations } from '../src/tradeup/float.mjs';

const payload = JSON.parse(fs.readFileSync(new URL('../ref/cs2up/sample-payload-099784dbf1e1240d.json', import.meta.url)));
const originalFetch = globalThis.fetch;
let recipe;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, item: { payload } }));
  recipe = await fetchShareRecipe('099784dbf1e1240d');
} finally { globalThis.fetch = originalFetch; }
assert.equal(recipe.ok, true);
const collectionPlan = locateCollection(recipe);
// 兼容直接调用的旧枪皮配额计划；分享链接默认使用收藏品配额。
const plan = { ...collectionPlan, collectionSpecs: undefined };
assert.equal(plan.ok, true);
assert.equal(recipe.materials.length, 4); // 原配方的 MAC-10 有两种磨损，但必须合成一种数量约束。
assert.deepEqual(plan.materialSpecs.map(m => [m.name, m.count]), [
  ['R8左轮手枪 | 蕉农炮', 6], ['MAC-10 | 错觉', 3], ['UMP-45 | 连续体', 1],
]);
assert.deepEqual(plan.materialSpecs.map(m => m.range), [[0, 1], [0.21, 0.79], [0, 1]]);
assert.deepEqual(plan.collections, ['变革收藏品', '创世纪收藏品']);
assert.equal(plan.targetOutput.name, 'AWP | 可燃冰');
assert.deepEqual(collectionPlan.collectionSpecs.map(m => m.count), [9, 1]);
console.log('✓ 真实分享配方只生成 3 种材料，合并 MAC-10 数量，保留 6 / 3 / 1 和两个收藏品');

const invalid = locateCollection({ ...recipe, materials: [{ ...recipe.materials[0], name: '不存在的枪皮', count: 10 }] });
assert.equal(invalid.error, 'recipe_material_not_found');
assert.equal(locateCollection({ ...recipe, materials: [{ ...recipe.materials[0], count: -1 }] }).error, 'invalid_material_count');
console.log('✓ 未识别材料、无效数量直接报错，不扩大搜索范围');

const exteriors = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const cnExteriors = ['崭新出厂', '略有磨损', '久经沙场', '破损不堪', '战痕累累'];
const expectedWear = (m, target) => recommendedWearFor(...m.range, f32(target));
function candidates(m, target, limit = 12) {
  const wear = expectedWear(m, target);
  return Array.from({ length: limit }, (_, index) => ({
    listingId: `${m.id}:${index}`, orderId: `${m.id}:${index}`, assetId: `${m.id}:asset:${index}`,
    floatvalue: wear, paintwear: wear, price: 1 + index / 100, currencyId: 23,
  }));
}
function verifyResult(result, target) {
  assert.equal(result.ok, true, result.message);
  assert.ok(result.recipes.length);
  for (const rec of result.recipes) {
    assert.deepEqual(plan.materialSpecs.map(m => rec.materials.filter(p => p.recipeMaterialId === m.id).length), [6, 3, 1]);
    assert.equal(new Set(rec.materials.map(m => m.assetId)).size, 10);
    const math = rec.materials.map(m => ({ wear: m.paintwear, matMin: m.matRange[0], matMax: m.matRange[1] }));
    assert.equal(rec.outputWear, outputWear(math, ...plan.targetOutput.range));
    assert.equal(rec.score, Math.abs(rec.outputWear - f32(target)));
    assert.ok(rec.score < 1e-6);
    assert.equal(rec.outputs.length, 6);
    assert.equal(rec.outputs.find(o => o.name === 'AWP | 金粉肆蛇').wear, outputWear(math, 0, 0.8));
    assert.equal(rec.cost, rec.materials.every(m => m.currencyId === 23) ? rec.materials.reduce((n, m) => n + m.price, 0) : null);
  }
}

function mockSteam(target, { shortage = false, wrongOnly = false } = {}) {
  const queried = [];
  return { queried, async listingsWithFloats(name) {
    queried.push(name);
    const material = plan.materialSpecs.find(m => name.startsWith(m.nameEn + ' ('));
    assert.ok(material, `查了链接之外的商品：${name}`);
    const items = candidates(material, target, shortage && material.count === 6 ? 5 : 12)
      .map(l => ({ ...l, marketHashName: wrongOnly ? 'P90 | Neoqueen (Field-Tested)' : name }));
    return { ok: true, pagesFetched: 1, listings: [...items, items[0], { ...items[0], listingId: 'duplicate-asset' },
      { ...items[0], listingId: 'wrong-skin', assetId: 'wrong-skin', marketHashName: 'P90 | Neoqueen (Field-Tested)', price: 0.01 },
      ...(!shortage ? [{ ...items[0], listingId: 'usd', assetId: 'usd', currencyId: 1 }] : []),
    ] };
  } };
}
const hunter = new CollectionHunter({ intervalMs: 0 });
hunter._materialsInCollection = () => { throw new Error('严格模式不能枚举收藏品'); };
hunter.buff = { listGoods: () => { throw new Error('分享链接已有英文名，不应查 BUFF'); } };
for (const target of [0.2, 0.7]) {
  const steam = mockSteam(target);
  const result = await hunter.huntFromSteam({ recipePlan: plan, targetWear: target, exteriors: [target === 0.2 ? 'ft' : 'bs'], steam }, { timeBudgetMs: 1000, wants: 3 });
  verifyResult(result, target);
  assert.equal(result.poolSize, 37, '外币挂单的真实 float 也保留，不混入人民币总价');
  assert.ok(steam.queried.every(n => n.endsWith(`(${target === 0.2 ? 'Field-Tested' : 'Battle-Scarred'})`)));
  for (const m of result.recipes[0].materials) {
    assert.equal(new URL(m.url).searchParams.get('detail'), m.listingId);
    assert.notEqual(m.paintwear, recipe.materials.find(r => r.nameEn.startsWith(plan.materialSpecs.find(s => s.id === m.recipeMaterialId).nameEn)).wear);
  }
  console.log(`✓ 仅 Steam 目标 ${target}：只查询指定枪皮，重新计算磨损及外观，固定 6 / 3 / 1，去重与购买定位有效`);
}
const tooFew = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'],
  steam: mockSteam(0.2, { shortage: true }) });
assert.equal(tooFew.error, 'not_enough_recipe_materials');
assert.ok(tooFew.poolSize >= 10);
assert.match(tooFew.message, /需要 6 把，只找到 5 把/);
console.log('✓ 总候选超过 10 把但某种缺 1 把时仍拒绝，不用其它枪皮补数');

// 失败材料写入检查点；继续时只重抓失败项，并复用成功材料。
const resumeState = { id: 'resume-test', items: {} };
const flakyCalls = [];
let failOnce = true;
const flakySteam = {
  async listingsWithFloats(name) {
    flakyCalls.push(name);
    const material = plan.materialSpecs.find(m => name.startsWith(m.nameEn + ' ('));
    if (failOnce && material.id === 'UMP_45_连续体') {
      failOnce = false;
      throw new Error('代理连接超时');
    }
    return { ok: true, pagesFetched: 1, listings: candidates(material, 0.2).map(l => ({ ...l, marketHashName: name })) };
  },
};
const interrupted = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'],
  steam: flakySteam, resumeState });
assert.equal(interrupted.error, 'not_enough_recipe_materials');
assert.equal(resumeState.items.R8左轮手枪_蕉农炮.complete, true);
assert.equal(resumeState.items.MAC_10_错觉.complete, true);
assert.equal(resumeState.items.UMP_45_连续体.complete, false);
const callsBeforeResume = flakyCalls.length;
const resumed = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'],
  steam: flakySteam, resumeState }, { timeBudgetMs: 1000 });
verifyResult(resumed, 0.2);
assert.equal(flakyCalls.length - callsBeforeResume, 1);
console.log('✓ 继续抓取只重试失败材料并复用已成功候选');

// 超时发生在某个材料请求中时，也要保存当前材料为未完成，重试只补抓它。
const timeoutState = { id: 'timeout-resume-test', items: {} };
const timeoutController = new AbortController();
const timeoutCalls = [];
let timeoutTriggered = false;
const timeoutSteam = {
  async listingsWithFloats(name) {
    timeoutCalls.push(name);
    const material = plan.materialSpecs.find(m => name.startsWith(m.nameEn + ' ('));
    assert.ok(material);
    if (material.id === 'UMP_45_连续体' && !timeoutTriggered) {
      timeoutTriggered = true;
      setTimeout(() => timeoutController.abort(new DOMException('搜索超时', 'TimeoutError')), 5);
      await new Promise((resolve, reject) => {
        timeoutController.signal.addEventListener('abort', () => reject(timeoutController.signal.reason), { once: true });
      });
    }
    return { ok: true, pagesFetched: 1, listings: candidates(material, 0.2).map(l => ({ ...l, marketHashName: name })) };
  },
};
await assert.rejects(
  new CollectionHunter({ intervalMs: 0, signal: timeoutController.signal }).huntFromSteam({
    recipePlan: plan, targetWear: 0.2, exteriors: ['ft'], steam: timeoutSteam, resumeState: timeoutState,
  }),
  e => e.name === 'TimeoutError',
);
assert.equal(timeoutState.items.R8左轮手枪_蕉农炮.complete, true);
assert.equal(timeoutState.items.MAC_10_错觉.complete, true);
assert.equal(timeoutState.items.UMP_45_连续体.complete, false);
assert.ok(timeoutState.pendingMaterials.some(item => item.id === 'UMP_45_连续体'));
const timeoutCallsBeforeRetry = timeoutCalls.length;
const retrySteam = mockSteam(0.2);
const retried = await new CollectionHunter({ intervalMs: 0 }).huntFromSteam({
  recipePlan: plan, targetWear: 0.2, exteriors: ['ft'], steam: retrySteam, resumeState: timeoutState,
}, { timeBudgetMs: 1000 });
verifyResult(retried, 0.2);
assert.equal(timeoutCalls.length, timeoutCallsBeforeRetry);
assert.equal(retrySteam.queried.length, 1);
console.log('✓ 搜索超时后保存未完成材料，重试只补抓该材料并复用已完成请求');

// 成功的空结果也是已完成项，重试其它失败材料时必须复用。
const emptyState = { id: 'empty-resume', items: {} };
const emptyRetryCalls = [];
await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'], resumeState: emptyState,
  steam: { async listingsWithFloats(name) {
    if (name.startsWith(plan.materialSpecs[2].nameEn)) return { ok: false, error: 'HTTP 429', listings: [] };
    return { ok: true, listings: [] };
  } } });
assert.equal(emptyState.items[plan.materialSpecs[0].id].complete, true);
assert.equal(emptyState.items[plan.materialSpecs[1].id].complete, true);
await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'], resumeState: emptyState,
  steam: { async listingsWithFloats(name) { emptyRetryCalls.push(name); return { ok: true, listings: [] }; } } });
assert.equal(emptyRetryCalls.length, 1);
assert.ok(emptyRetryCalls[0].startsWith(plan.materialSpecs[2].nameEn));
console.log('✓ 成功的空结果也会复用，重试不重复搜索已完成的缺货材料');

const wrongOnly = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, exteriors: ['ft'],
  steam: mockSteam(0.2, { wrongOnly: true }) });
assert.equal(wrongOnly.poolSize, 0);
assert.equal(wrongOnly.error, 'not_enough_recipe_materials');
console.log('✓ Steam 聚合页混入其它枪皮时严格拒绝');

for (const target of [0.2, 0.7]) {
  const searches = [], orders = [];
  hunter.buff = {
    async listGoods({ search }) {
      searches.push(search);
      const m = plan.materialSpecs.find(m => m.name === search);
      assert.ok(m);
      return { ok: true, items: cnExteriors.map((ext, index) => ({ id: `${m.id}:${index}`,
        name: `${m.name} (${ext})`, market_hash_name: `${m.nameEn} (${exteriors[index]})`,
      })).concat([{ id: 'other', name: 'P90 | 新兵 (久经沙场)', market_hash_name: 'P90 | Neoqueen (Field-Tested)' },
        { id: 'stattrak', name: `StatTrak™ ${m.name} (久经沙场)` }]) };
    },
    async sellOrders(query) {
      orders.push(query);
      const m = plan.materialSpecs.find(m => query.goodsId.startsWith(m.id + ':'));
      assert.ok(m);
      const wear = expectedWear(m, target);
      assert.ok(query.minPaintwear < wear && wear < query.maxPaintwear);
      assert.equal(query.goodsId, `${m.id}:${target === 0.2 ? 2 : 4}`);
      const items = candidates(m, target).map(l => ({ ...l, goodsId: query.goodsId,
        name: `${m.name} (${cnExteriors[target === 0.2 ? 2 : 4]})`,
        marketHashName: `${m.nameEn} (${exteriors[target === 0.2 ? 2 : 4]})`,
        buyUrl: `https://buff.163.com/goods/${query.goodsId}#sell_order`,
      }));
      return { ok: true, total: items.length, totalPage: 1, listings: [...items, items[0],
        { ...items[0], orderId: 'wrong-goods', assetId: 'wrong-goods', goodsId: 'other' },
        { ...items[0], orderId: 'wrong-name', assetId: 'wrong-name', name: 'P90 | 新兵 (久经沙场)' },
      ] };
    },
  };
  const result = await hunter.hunt({ recipePlan: plan, targetWear: target, exteriors: [target === 0.2 ? 'ft' : 'bs'] }, { timeBudgetMs: 1000 });
  verifyResult(result, target);
  assert.deepEqual(searches, plan.materialSpecs.map(m => m.name));
  assert.equal(orders.length, 3);
  assert.equal(result.poolSize, 36);
  assert.equal(result.recipes[0].materials.find(m => m.recipeMaterialId === 'MAC_10_错觉').norm,
    normalizeWear(expectedWear(plan.materialSpecs[1], target), 0.21, 0.79));
  console.log(`✓ BUFF/比价共用的目标 ${target} 路径：只查指定 3 种，按完整区间计算，拒绝模糊结果`);
}

// 所有重启及替换阶段都必须保持数量，即使最接近目标的候选全部属于另一种材料。
const labels = Array(15).fill('A').concat(Array(6).fill('B'), Array(4).fill('C'));
const norms = Array(15).fill(0.2).concat(Array(6).fill(0.9), Array(4).fill(0.01));
const constrained = solveCombinations(norms, { count: 10, outMin: 0, outMax: 1, targetOut: 0.35,
  candidateGroups: labels, groupCounts: { A: 6, B: 3, C: 1 }, tries: 40, timeBudgetMs: 150, maxResults: 3 });
assert.ok(constrained.results.length);
for (const r of constrained.results) assert.deepEqual(['A', 'B', 'C'].map(g => r.indices.filter(i => labels[i] === g).length), [6, 3, 1]);
assert.equal(solveCombinations(norms, { count: 10, outMin: 0, outMax: 1, targetOut: 0.2,
  candidateGroups: labels, groupCounts: { A: 6, B: 3, D: 1 } }).reason, 'not_enough_group_candidates');
console.log('✓ 数量约束覆盖求解器的贪心/随机起点、局部搜索及抛光，缺组时不能输出');

function expandedSpecs(p) {
  return p.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade).map((m, i) => ({
    id: m.key, name: m.name, range: [m.min, m.max], collection: g.collection,
    nameEn: (p.materialSpecs.find(s => s.id === m.key)?.nameEn || `Test ${g.id} ${i}`).replace(/^StatTrak™?\s*/i, ''),
  })));
}
function verifyCollectionResult(result, p, target) {
  assert.equal(result.ok, true, result.message);
  assert.ok(result.recipes.length);
  const specs = expandedSpecs(p);
  assert.equal(result.collectionBands.length, specs.length);
  for (const r of result.recipes) {
    assert.equal(r.materials.length, 10);
    assert.equal(new Set(r.materials.map(m => m.assetId)).size, 10);
    assert.deepEqual(p.collectionSpecs.map(g => r.materials.filter(m => m.collectionName === g.collection).length),
      p.collectionSpecs.map(g => g.count));
    for (const m of r.materials) {
      const spec = specs.find(s => s.id === m.recipeMaterialId);
      assert.ok(spec, `不允许跨收藏品或等级：${m.name}`);
      assert.deepEqual(m.matRange, spec.range);
      assert.equal(m.norm, normalizeWear(m.paintwear, ...spec.range));
      assert.ok(!p.materialSpecs.some(s => s.id === m.recipeMaterialId), '原枪皮缺货，应使用同收藏品替代材料');
    }
    assert.equal(r.outputWear, outputWear(r.materials.map(m => ({ wear: m.paintwear,
      matMin: m.matRange[0], matMax: m.matRange[1] })), ...p.targetOutput.range));
    assert.equal(r.score, Math.abs(r.outputWear - f32(target)));
    assert.ok(r.score < 1e-6);
  }
}
function collectionSteam(p, target, { shortage = false, discoveryWrongOnly = false, statTrak = false } = {}) {
  const specs = expandedSpecs(p), searched = [], queried = [];
  return { searched, queried,
    async search({ query, language }) {
      assert.equal(language, 'schinese');
      const s = specs.find(m => m.name === query);
      assert.ok(s, `查询了收藏品/等级外的皮肤：${query}`);
      searched.push(s.id);
      return { ok: true, results: [
        { name: 'Wrong Skin (Field-Tested)', localizedName: '错误枪皮 (久经沙场)' },
        ...discoveryWrongOnly ? [] : [{ name: `${s.nameEn} (Field-Tested)`, localizedName: `${s.name} (久经沙场)` }],
      ] };
    },
    async listingsWithFloats(name) {
      const s = specs.find(m => name.startsWith(`${statTrak ? 'StatTrak™ ' : ''}${m.nameEn} (`));
      assert.ok(s, `抓取了未确认身份的商品：${name}`);
      queried.push(s.id);
      const original = p.materialSpecs.some(m => m.id === s.id);
      const groupIndex = p.collectionSpecs.findIndex(g => g.collection === s.collection);
      // 原配方皮肤全部缺货，只有同收藏品同等级替代材料在售。
      const limit = original ? 0 : shortage && groupIndex === 1 ? 0 : 12;
      const items = candidates(s, target, limit).map(m => ({ ...m, marketHashName: name }));
      return { ok: true, listings: items.concat(items.length ? [items[0],
        { ...items[0], listingId: 'duplicate-asset' },
        { ...items[0], listingId: 'wrong-hash', assetId: 'wrong-hash', marketHashName: 'Wrong Skin (Field-Tested)' }] : []) };
    },
  };
}
const sevenThree = locateCollection({
  inputRarity: 'milspec', totalCount: 10,
  materials: [
    { name: '内格夫（StatTrak™） | 飞羽', count: 7, nameEn: 'StatTrak™ Negev | Ultralight' },
    { name: '截短霰弹枪（StatTrak™） | 融合', count: 1, nameEn: 'StatTrak™ Sawed-Off | Fusion' },
    { name: 'M249（StatTrak™） | 博客积木', count: 2, nameEn: 'StatTrak™ M249 | Bock Blocks' },
  ],
  outputs: [{ name: 'M4A1消音版（StatTrak™） | 翠珀金' }],
});
assert.equal(sevenThree.ok, true);
assert.deepEqual(sevenThree.collectionSpecs.map(m => m.count), [7, 3]);
for (const [p, target, statTrak] of [[collectionPlan, 0.2, false], [sevenThree, 0.2000101601, true]]) {
  const steam = collectionSteam(p, target, { statTrak });
  const result = await hunter.huntFromSteam({ recipePlan: p, targetWear: target, band: 0.002, steam, statTrak },
    { timeBudgetMs: 1000, wants: 3 });
  verifyCollectionResult(result, p, target);
  assert.equal(new Set(steam.queried).size, expandedSpecs(p).length);
  assert.equal(steam.searched.length, expandedSpecs(p).length - p.materialSpecs.filter(m => m.nameEn).length);
  console.log(`✓ 仅 Steam 全部同等级候选，原枪皮均缺货仍可替代，固定收藏品 ${p.collectionSpecs.map(m => m.count).join(' / ')}，目标磨损正确`);
}
const groupShort = await hunter.huntFromSteam({ recipePlan: sevenThree, targetWear: 0.2, band: 0.002,
  statTrak: true, steam: collectionSteam(sevenThree, 0.2, { shortage: true, statTrak: true }) });
assert.ok(groupShort.poolSize > 10);
assert.match(groupShort.message, /毁灭之手终端机.*需要 3 把，只找到 0 把/);
assert.equal(groupShort.error, 'not_enough_recipe_materials');
const wrongDiscovery = await hunter.huntFromSteam({ recipePlan: collectionPlan, targetWear: 0.2, band: 0.002,
  steam: collectionSteam(collectionPlan, 0.2, { discoveryWrongOnly: true }) });
assert.equal(wrongDiscovery.poolSize, 0);
assert.equal(wrongDiscovery.error, 'not_enough_recipe_materials');
console.log('✓ 总挂单充足也不能改变收藏品比例；Steam 名称搜索的模糊结果不纳入候选');

const specs = expandedSpecs(collectionPlan);
hunter.buff = {
  async listGoods({ search }) {
    const s = specs.find(m => m.name === search);
    assert.ok(s);
    return { ok: true, items: cnExteriors.map((ext, i) => ({ id: `${s.id}:${i}`,
      name: `${s.name} (${ext})`, market_hash_name: `${s.nameEn} (${exteriors[i]})` })) };
  },
  async sellOrders({ goodsId }) {
    const s = specs.find(m => goodsId.startsWith(m.id + ':'));
    const i = Number(goodsId.split(':').at(-1));
    const items = candidates(s, 0.2, collectionPlan.materialSpecs.some(m => m.id === s.id) ? 0 : 12)
      .map(m => ({ ...m, goodsId, name: `${s.name} (${cnExteriors[i]})`, marketHashName: `${s.nameEn} (${exteriors[i]})` }));
    return { ok: true, totalPage: 1, listings: items };
  },
};
verifyCollectionResult(await hunter.hunt({ recipePlan: collectionPlan, targetWear: 0.2, band: 0.002 },
  { timeBudgetMs: 1000 }), collectionPlan, 0.2);
console.log('✓ BUFF 同样展开全部同等级枪皮，保持收藏品 9 / 1 和各自完整磨损区间');

// 真实 /api/hunt 端点：收藏品配额必须传到实际求解路径；市场调用完全离线。
const probe = http.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const root = new URL('../', import.meta.url);
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  import fs from 'node:fs';
  let retryScenario = false, timeoutOnce = true, retryRecipeReads = 0;
  const completedRequests = new Set();
  const payload = JSON.parse(fs.readFileSync(${JSON.stringify(new URL('ref/cs2up/sample-payload-099784dbf1e1240d.json', root).pathname.replace(/^\/(\w:)/, '$1'))}));
  globalThis.fetch = async url => {
    if (String(url).includes('2222222222222222')) {
      retryScenario = true;
      if (++retryRecipeReads > 1) throw new Error('重试不应重新读取成功的 CS2UP 配方');
    }
    return new Response(JSON.stringify({ok:true,item:{payload:{...payload,
      stattrak:String(url).includes('1111111111111111')
    }}}));
  };
  // 子进程中只模拟 Cookie 文件的读取，不写入或改变用户登录态。
  const readFile = fs.readFileSync.bind(fs);
  fs.readFileSync = (file,...args) => String(file).replaceAll('\\\\','/').endsWith('/data/cookies.manual.buff.json')
    ? JSON.stringify({cookies:[{name:'session',value:'offline-test-session',domain:'.buff.163.com'}]}) : readFile(file,...args);
  const {SteamMarket} = await import(${JSON.stringify(new URL('src/market/steam.mjs', root).href)});
  const {CollectionHunter} = await import(${JSON.stringify(new URL('src/market/hunter.mjs', root).href)});
  const {BuffMarket} = await import(${JSON.stringify(new URL('src/market/buff.mjs', root).href)});
  const {locateCollection} = await import(${JSON.stringify(new URL('src/cs2up/location.mjs', root).href)});
  const {fetchShareRecipe} = await import(${JSON.stringify(new URL('src/cs2up/recipe.mjs', root).href)});
  const {materialsInCollection} = await import(${JSON.stringify(new URL('src/cs2up/materials.mjs', root).href)});
  const {recommendedWearFor} = await import(${JSON.stringify(new URL('src/tradeup/float.mjs', root).href)});
  const {SearchTasks} = await import(${JSON.stringify(new URL('src/web/search-tasks.mjs', root).href)});
  const run = SearchTasks.prototype.start;
  SearchTasks.prototype.start = function(...args) {
    const task = run.apply(this, args);
    if (task) {
      const execute = task.run;
      task.run = (work, timeoutMs) => execute(work, args[1] === 'timeout-integration' ? 50 : timeoutMs);
    }
    return task;
  };
  const plan = locateCollection(await fetchShareRecipe('099784dbf1e1240d'));
  const specs = plan.collectionSpecs.flatMap(g => materialsInCollection(g.collection, g.grade).map((m,i)=>({
    ...m, nameEn: plan.materialSpecs.find(s=>s.id===m.key)?.nameEn || 'Test '+g.id+' '+i
  })));
  CollectionHunter.prototype._materialsInCollection = () => {throw new Error('不能枚举收藏品');};
  SteamMarket.prototype.health = async () => ({ok:true});
  SteamMarket.prototype.priceOverview = () => {throw new Error('双市场不得使用商品最低价');};
  SteamMarket.prototype.search = async ({query}) => {
    const s=specs.find(m=>m.name===query);
    return {ok:true,results:[{name:s.nameEn+' (Field-Tested)',localizedName:s.name+' (久经沙场)'}]};
  };
  SteamMarket.prototype.listingsWithFloats = async function(name) {
    const stem = name.replace(/^StatTrak™ /, '').replace(/ \\([^)]*\\)$/, '');
    const s=specs.find(m=>m.nameEn===stem);
    if (retryScenario) {
      if (completedRequests.has(name)) throw new Error('重复抓取已完成商品：'+name);
      if (s.key === specs[Math.floor(specs.length / 2)].key && timeoutOnce) {
        timeoutOnce = false;
        await new Promise((resolve, reject) => {
          this.signal.addEventListener('abort', () => reject(this.signal.reason), {once:true});
        });
      }
      completedRequests.add(name);
    }
    const wear = recommendedWearFor(s.min,s.max,Math.fround(0.2));
    const limit=plan.materialSpecs.some(m=>m.id===s.key)?0:12;
    return {ok:true,listings:Array.from({length:limit},(_,i)=>({listingId:stem+i,assetId:'steam:'+stem+i,marketHashName:name,floatvalue:wear,price:2,currencyId:23}))};
  };
  BuffMarket.prototype.listGoods = async ({search}) => {
    const s=specs.find(m=>m.name===search);
    const wear=recommendedWearFor(s.min,s.max,Math.fround(0.2));
    const cn=wear<0.15?'略有磨损':'久经沙场', en=wear<0.15?'Minimal Wear':'Field-Tested';
    return {ok:true,items:[false,true].map(st=>({id:s.key+':'+st,name:(st?'StatTrak™ ':'')+s.name+' ('+cn+')',
      market_hash_name:(st?'StatTrak™ ':'')+s.nameEn+' ('+en+')'}))};
  };
  BuffMarket.prototype.sellOrders = async ({goodsId}) => {
    const s=specs.find(m=>goodsId.startsWith(m.key+':'));
    const wear=recommendedWearFor(s.min,s.max,Math.fround(0.2));
    const limit=plan.materialSpecs.some(m=>m.id===s.key)?0:12;
    return {ok:true,totalPage:1,listings:Array.from({length:limit},(_,i)=>({goodsId,orderId:s.key+i,
      assetId:'buff:'+s.key+i,paintwear:wear,price:1,buyUrl:'https://buff.163.com/goods/'+encodeURIComponent(goodsId)}))};
  };
  await import(${JSON.stringify(new URL('src/web/server.mjs', root).href)});
`], { env: { ...process.env, CS2_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let childOutput = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Web 测试启动超时：' + childOutput)), 10000);
  child.stdout.on('data', data => { childOutput += data; if (childOutput.includes('已启动')) { clearTimeout(timer); resolve(); } });
  child.stderr.on('data', data => { childOutput += data; });
  child.once('error', e => { clearTimeout(timer); reject(e); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}: ${childOutput}`)); });
});
try {
  await ready;
  const res = await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=ft,mw&market=steam`);
  const stream = await res.text();
  assert.ok(!stream.includes('event: error'), stream);
  const event = name => {
    const match = stream.match(new RegExp('event: ' + name + '\\ndata: ([^\\n]+)'));
    assert.ok(match, stream);
    return JSON.parse(match[1]);
  };
  const located = event('located'), result = event('result');
  assert.equal(located.materialCount, 3);
  assert.match(located.materials.join(';'), /蕉农炮 × 6/);
  assert.equal(located.targetOutput, 'AWP | 可燃冰');
  assert.deepEqual(located.collectionSpecs.map(m => m.count), [9, 1]);
  verifyCollectionResult({ ...result, ok: true }, collectionPlan, 0.2);
  assert.equal(result.materialBands.length, 0);
  assert.deepEqual(result.collectionSpecs.map(m => m.count), [9, 1]);
  console.log('✓ 真实 Web SSE 端点传递收藏品比例与同等级候选，并使用替代枪皮产出正确结果');
  const wideStream = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=fn,mw,ft,ww,bs&market=steam`)).text();
  assert.ok(!wideStream.includes('event: error'), wideStream);
  assert.match(wideStream, /搜索已勾选档位的完整区间/);
  const wideResult = JSON.parse(wideStream.match(/event: result\ndata: ([^\n]+)/)[1]);
  assert.ok(wideResult.collectionBands.every(m => m.band[0] === f32(m.range[0]) && m.band[1] > (m.range[0] + m.range[1]) / 2));
  const invalidRadius = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=unknown&market=steam`)).text();
  assert.match(invalidRadius, /invalid_exteriors/);
  console.log('✓ 真实 Web SSE 多选档位覆盖完整区间；无效档位明确报错');
  for (const [sid, choice, expected] of [
    ['1111111111111111', '', true], ['1111111111111111', '&stattrak=0', false],
    ['099784dbf1e1240d', '&stattrak=1', true],
  ]) {
    const metadata = await (await fetch(`http://127.0.0.1:${port}/api/recipe?url=${sid}`)).json();
    assert.equal(metadata.ok, true);
    assert.ok(metadata.outputs.length > 1);
    assert.equal(metadata.outputs[0].index, 0);
    assert.ok(Number.isFinite(metadata.outputs[0].probability));
    assert.equal(metadata.statTrak, sid === '1111111111111111');
    const stream = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=${sid}&wear=0.2&exteriors=ft,mw&market=steam${choice}`)).text();
    assert.ok(!stream.includes('event: error'), stream);
    const result = JSON.parse(stream.match(/event: result\ndata: ([^\n]+)/)[1]);
    assert.equal(result.statTrak, expected);
    assert.equal(result.targetOutput.startsWith('StatTrak™ '), expected);
    assert.ok(result.recipes.every(r => r.materials.every(m => m.marketHashName.startsWith('StatTrak™ ') === expected)));
  }
  console.log('✓ 真实 API 默认跟随暗金链接，明确 stattrak=0 可关闭暗金，普通链接 stattrak=1 可开启');
  const selectedMetadata = await (await fetch(`http://127.0.0.1:${port}/api/recipe?url=099784dbf1e1240d`)).json();
  const selectedStream = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=ft,mw&market=steam&output_index=1`)).text();
  assert.ok(!selectedStream.includes('event: error'), selectedStream);
  const selectedResult = JSON.parse(selectedStream.match(/event: result\ndata: ([^\n]+)/)[1]);
  assert.equal(selectedResult.targetOutputIndex, 1);
  assert.equal(selectedResult.targetOutput, selectedMetadata.outputs[1].name);
  assert.equal(selectedResult.targetOutputProbability, selectedMetadata.outputs[1].probability);
  const invalidOutput = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=ft&market=steam&output_index=999`)).text();
  assert.match(invalidOutput, /invalid_output_index/);
  console.log('✓ Web 下拉目标索引按所选产物求解并透传概率，越界索引明确报错');
  const bothStream = await (await fetch(`http://127.0.0.1:${port}/api/hunt?url=099784dbf1e1240d&wear=0.2&exteriors=ft,mw&market=both`)).text();
  assert.ok(!bothStream.includes('event: error'), bothStream);
  const bothResult = JSON.parse(bothStream.match(/event: result\ndata: ([^\n]+)/)[1]);
  assert.equal(bothResult.dataSource, 'both');
  assert.ok(bothResult.marketCounts.buff > 0 && bothResult.marketCounts.steam > 0);
  verifyCollectionResult({ ...bothResult, ok: true }, collectionPlan, 0.2);
  assert.ok(bothResult.recipes[0].materials.every(m => m.marketOffers.buff && m.marketOffers.steam && m.cheaperMarket === 'buff'));
  console.log('✓ 真实双市场 SSE 搜索两边真实挂单，输出逐笔磨损、价格、链接和便宜市场');
  const retryUrl = `http://127.0.0.1:${port}/api/hunt?url=2222222222222222&wear=0.2&exteriors=ft,mw&market=steam`;
  const timedOutStream = await (await fetch(retryUrl + '&task_id=timeout-integration')).text();
  const timeoutError = JSON.parse(timedOutStream.match(/event: error\ndata: ([^\n]+)/)[1]);
  assert.match(timeoutError.message, /搜索超时/);
  assert.equal(timeoutError.resume.canContinue, true);
  assert.ok(timeoutError.resume.pending.length > 0);
  const retryStream = await (await fetch(retryUrl + '&task_id=retry-integration&resume_id=' + timeoutError.resume.id)).text();
  assert.ok(!retryStream.includes('event: error'), retryStream);
  assert.match(retryStream, /复用已读取的 CS2UP 配方/);
  assert.match(retryStream, /复用已完成搜索/);
  const retryResult = JSON.parse(retryStream.match(/event: result\ndata: ([^\n]+)/)[1]);
  assert.ok(retryResult.perItem.every(item => item.errors.length === 0), retryStream);
  assert.equal(retryResult.resume.canContinue, false);
  verifyCollectionResult({ ...retryResult, ok: true }, collectionPlan, 0.2);
  console.log('✓ 真实 SSE 超时后可重试，复用配方、成功挂单和空结果，只补抓未完成商品');
} finally {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}
