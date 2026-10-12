import { fetchShareRecipe, extractSid } from '../src/cs2up/recipe.mjs';

console.log('=== sid 解析测试 ===');
for (const s of [
  'https://cs2up.cn/share.html?sid=7928752d714f8e31',
  'https://cs2up.cn/share.html?sid=7928752d714f8e31&x=1',
  'cs2up.cn/share.html?sid=7928752d714f8e31',
  '7928752d714f8e31',
  '  https://cs2up.cn/share.html?sid=7928752d714f8e31  ',
  'https://cs2up.cn/tradeup.html#filters',
  '',
]) {
  console.log(`  ${JSON.stringify(s).slice(0, 56).padEnd(58)} -> ${extractSid(s)}`);
}

console.log('\n=== 拉取真实配方 ===');
const r = await fetchShareRecipe('https://cs2up.cn/share.html?sid=7928752d714f8e31');
if (!r.ok) { console.log('失败:', r.error, r.message); process.exit(1); }
console.log('标题     :', r.title, '|', r.subtitle);
console.log('配方     :', r.recipeLine, '| matchup', r.matchup);
console.log('稀有度   :', r.inputRarityLabel, '->', r.outputRarityLabel, `(${r.inputRarity} -> ${r.outputRarity})`);
console.log('StatTrak  :', r.statTrak);
console.log('收藏品   :', JSON.stringify(r.collections));
console.log('材料总数 :', r.totalCount);
console.log('目标磨损 :', r.targetWear);
console.log('\n需要采购的（按名称+磨损归并）:');
for (const m of r.materials) {
  console.log(`  ${m.count} 把  wear=${m.wear}  参考单价¥${m.unitPrice}  ${m.name}`);
  console.log(`         收藏品: ${m.collection}`);
}
console.log('\n产物:');
for (const o of r.outputs) {
  console.log(`  ${(o.probability * 100).toFixed(1)}%  磨损 ${o.expectedWear}  ¥${o.price}  ${o.name}`);
}
console.log('\n核对：材料 wear 加权平均 =',
  r.materials.reduce((a, m) => a + m.wear * m.count, 0) / r.totalCount);
