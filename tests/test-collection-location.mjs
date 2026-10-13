import assert from 'node:assert/strict';
import { findCollectionName, materialsInCollection } from '../src/cs2up/materials.mjs';
import { locateCollection } from '../src/cs2up/location.mjs';

for (const [input, expected] of [
  ['The Genesis Collection', '创世纪收藏品'],
  ['The Revolution Collection', '变革收藏品'],
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
