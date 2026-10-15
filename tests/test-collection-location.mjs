import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findCollectionName, materialsInCollection, findInDbByBuffName } from '../src/cs2up/materials.mjs';
import { fetchShareRecipe } from '../src/cs2up/recipe.mjs';
import { locateCollection, planWithQuality } from '../src/cs2up/location.mjs';

for (const [input, expected] of [
  ['The Genesis Collection', '创世纪收藏品'],
  ['The Revolution Collection', '变革收藏品'],
  ['The Achroma Collection', '墨彩收藏品'],
  ['The Fracture Collection', '裂空武器箱收藏品'],
  ['The Shattered Web Collection', '“裂网大行动”收藏品'],
  ['The Dead Hand Collection', '毁灭之手终端机'],
]) {
  assert.equal(findCollectionName(input), expected);
  console.log(`✓ ${input} -> ${expected}`);
}

// sid=f28f55f768110fd2 的真实输入字段，覆盖 Web 使用的同一个定位函数。
const mixedRecipe = {
  inputRarity: 'milspec',
  collections: ['The Fracture Collection', 'The Dead Hand Collection'],
  materials: [
    { name: '内格夫（StatTrak™） | 飞羽 (略有磨损)', collection: 'The Fracture Collection', count: 6 },
    { name: 'M249（StatTrak™） | 博客积木 (久经沙场)', collection: 'The Dead Hand Collection', count: 3 },
    { name: '截短霰弹枪（StatTrak™） | 融合 (久经沙场)', collection: 'The Dead Hand Collection', count: 1 },
  ],
  outputs: [{ name: materialsInCollection('裂空武器箱收藏品', 'restricted')[0].name,
    collection: 'The Fracture Collection' }],
};
const result = locateCollection(mixedRecipe);
assert.equal(result.ok, true);
assert.equal(result.collection, '裂空武器箱收藏品 + 毁灭之手终端机');
assert.deepEqual(result.collections, ['裂空武器箱收藏品', '毁灭之手终端机']);
assert.equal(result.grade, 'milspec');
assert.equal(result.materialCount, 3);
assert.deepEqual(result.materialSpecs.map(m => m.count), [6, 3, 1]);
assert.deepEqual(result.collectionSpecs.map(m => [m.collection, m.count, m.candidateCount]), [
  ['裂空武器箱收藏品', 6, 7], ['毁灭之手终端机', 4, 7],
]);
assert.ok(result.materials.includes('内格夫 | 飞羽 × 6'));
console.log('✓ 混合配方把 6 / 3 / 1 枪皮数量汇总为收藏品 6 / 4，各展开 7 种同等级材料');

const restricted = materialsInCollection('裂空武器箱收藏品', 'restricted');
const multiOutput = locateCollection({ ...mixedRecipe, outputs: [
  { name: restricted[0].name, collection: 'The Fracture Collection', probability: 0.5 },
  { name: restricted[1].name, collection: 'The Fracture Collection', probability: 0.5 },
] });
assert.equal(multiOutput.outputSpecs.length, 2);
assert.deepEqual(multiOutput.targetOutput, multiOutput.outputSpecs[0]);
assert.deepEqual(planWithQuality(multiOutput, true, 1).targetOutput, planWithQuality(multiOutput, true).outputSpecs[1]);
assert.equal(planWithQuality(multiOutput, true, 99).targetOutputIndex, 0);
console.log('✓ 多产物可按索引选择目标，品质切换保留概率并对越界索引回退第一项');

const deadHand = locateCollection({ ...mixedRecipe, collections: ['The Dead Hand Collection'] });
assert.equal(deadHand.collection, result.collection);
assert.ok(deadHand.materials.includes('M249 | 博客积木 × 3'));
console.log('✓ 顶层收藏品提示不能覆盖具体材料，也不能扩大搜索清单');

const fallback = locateCollection({
  inputRarity: 'milspec', collections: ['Unmapped Collection'],
  materials: [{ ...mixedRecipe.materials[0], collection: 'Unmapped Collection', count: 10 }],
  outputs: mixedRecipe.outputs,
});
assert.equal(fallback.collection, '裂空武器箱收藏品');
console.log('✓ 收藏品名未映射时，可通过带 StatTrak 括号的皮肤名反查');

assert.equal(locateCollection({ collections: ['Unknown Collection'] }).error, 'invalid_recipe_count');
assert.equal(locateCollection({ ...mixedRecipe, inputRarity: 'consumer' }).error, 'recipe_material_not_found');
console.log('✓ 缺少材料及身份/稀有度不匹配时明确停止，不枚举收藏品补足');

// CS2UP 对 M4A1-S 的译名为“ M4A1 消音型”，材料库使用“ M4A1消音版”。
// 该别名必须能定位到完整磨损区间，否则整个分享链接会在读取产物阶段失败。
const fixture = JSON.parse(fs.readFileSync(new URL('../ref/cs2up/sample-payload-6cc935885d8238ab.json', import.meta.url)));
const originalFetch = globalThis.fetch;
let currentShare;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, item: { payload: fixture } }));
  currentShare = await fetchShareRecipe('https://cs2up.cn/share.html?sid=6cc935885d8238ab\u00a0');
} finally { globalThis.fetch = originalFetch; }
assert.equal(currentShare.ok, true);
const currentPlan = locateCollection(currentShare);
assert.equal(currentPlan.ok, true);
assert.equal(currentPlan.outputSpecs.length, 7);
assert.deepEqual(currentPlan.collectionSpecs.map(c => c.count), [1, 9]);
assert.deepEqual(currentPlan.outputSpecs.find(o => o.name.includes('隐伏帝王龙'))?.range, [0, 0.8]);
assert.equal(planWithQuality(currentPlan, currentShare.statTrak).targetOutputIndex, 0);
console.log('✓ CS2UP M4A1-S 中文别名可读取，分享链接产物区间与链接默认品质正常');

for (const name of ['M4A1-S | 隐伏帝王龙', 'M4A1 消音型（StatTrak™） | 隐伏帝王龙', 'StatTrak™ M4A1 消音型 | 隐伏帝王龙']) {
  assert.equal(findInDbByBuffName(name)?.paintIndex, '1223');
}
assert.equal(findInDbByBuffName('USP 消音型 | 黑莲花')?.paintIndex, '1102');
assert.equal(findInDbByBuffName('USP-S | 黑莲花')?.paintIndex, '1102');
assert.equal(findInDbByBuffName('M4A4 | 隐伏帝王龙'), null);
assert.equal(findInDbByBuffName('M4A1 消音型 | 不存在的皮肤'), null);
console.log('✓ 武器别名兼容暗金和 USP-S，保留不同枪皮的身份校验');

const unknownOutput = { name: '未知产物', collection: 'The Revolution Collection', probability: 0.01 };
const partialRecipe = { ...currentShare, outputs: [unknownOutput, ...currentShare.outputs] };
assert.equal(locateCollection(partialRecipe).error, 'recipe_output_not_found');
const partialPlan = locateCollection(partialRecipe, { allowUnresolvedOutputs: true });
assert.equal(partialPlan.ok, true);
assert.equal(partialPlan.outputSpecs.length, 8);
assert.equal(partialPlan.outputSpecs[0].range, null);
assert.match(partialPlan.outputSpecs[0].unavailableReason, /完整磨损区间/);
assert.deepEqual(partialPlan.outputSpecs[1].range, currentPlan.outputSpecs[0].range);
assert.equal(locateCollection({ ...partialRecipe, outputs: [{ ...unknownOutput, collection: 'The Genesis Collection' }] },
  { allowUnresolvedOutputs: true }).error, 'recipe_output_mismatch');
console.log('✓ 部分产物区间缺失可保留原顺序和概率，仍校验收藏品身份');
