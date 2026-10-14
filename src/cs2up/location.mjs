import { findInDbByBuffName, findCollectionName, materialsInCollection } from './materials.mjs';

/** 商品比较使用枪皮身份，外观档位随用户输入的目标磨损重新计算。 */
export function skinIdentity(name) {
  return skinName(name)
    .replace(/[（(]\s*stattrak™?\s*[)）]|stattrak™?/gi, '')
    .replace(/\s+/g, '').toLowerCase();
}

export function skinName(name) {
  return String(name ?? '').replace(/\s*[（(](?:崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累|Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)[)）]\s*$/i, '').trim();
}

/** 改变搜索品质时同步产物展示名称，避免暗金链接关闭后仍显示暗金产物。 */
export function withStatTrakName(name, statTrak) {
  const plain = String(name).replace(/[（(]\s*stattrak™?\s*[)）]|stattrak™?/gi, '').replace(/\s+/g, ' ').trim();
  return statTrak ? `StatTrak™ ${plain}` : plain;
}

export function planWithQuality(plan, statTrak, outputIndex = 0) {
  const outputSpecs = plan.outputSpecs.map(o => ({ ...o, name: withStatTrakName(o.name, statTrak) }));
  const index = Number.isInteger(outputIndex) && outputIndex >= 0 && outputIndex < outputSpecs.length ? outputIndex : 0;
  return { ...plan, outputSpecs, targetOutput: outputSpecs[index], targetOutputIndex: index };
}

/** 按分享链接中的产物索引选择本次反推目标。 */
export function selectTargetOutput(plan, outputIndex = 0) {
  if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= plan.outputSpecs.length) return null;
  return { ...plan, targetOutput: plan.outputSpecs[outputIndex], targetOutputIndex: outputIndex };
}

/** 从分享配方汇总各收藏品投入数量，并确定同等级候选范围。 */
export function locateCollection(recipe) {
  const groups = new Map();
  for (const input of recipe.materials || []) {
    const db = findInDbByBuffName(input.name);
    if (!db || (recipe.inputRarity && db.grade !== recipe.inputRarity)) {
      return { ok: false, error: 'recipe_material_not_found', message: `无法确认配方材料「${input.name}」的身份或稀有度，已停止搜索。` };
    }
    if (!Number.isInteger(input.count) || input.count <= 0) {
      return { ok: false, error: 'invalid_material_count', message: `配方材料「${input.name}」的数量无效。` };
    }
    const collection = findCollectionName(input.collection) || db.collections[0];
    if (!collection || !db.collections.includes(collection)) {
      return { ok: false, error: 'recipe_collection_mismatch', message: `配方材料「${input.name}」与声明的收藏品不匹配。` };
    }
    if (!groups.has(db.key)) groups.set(db.key, {
      id: db.key, name: db.name, nameEn: input.nameEn ? skinName(input.nameEn) : null,
      collection, range: [db.min, db.max], count: 0,
    });
    const group = groups.get(db.key);
    if (group.collection !== collection) {
      return { ok: false, error: 'recipe_collection_mismatch', message: `配方中「${input.name}」存在冲突的收藏品。` };
    }
    group.count += input.count;
    if (!group.nameEn && input.nameEn) group.nameEn = skinName(input.nameEn);
  }
  const materialSpecs = [...groups.values()];
  const totalCount = materialSpecs.reduce((n, m) => n + m.count, 0);
  if (totalCount !== 10 || (recipe.totalCount != null && totalCount !== recipe.totalCount)) {
    return { ok: false, error: 'invalid_recipe_count', message: `配方材料共 ${totalCount} 把，当前搜索需要链接提供完整的 10 把材料。` };
  }

  const outputSpecs = [];
  for (const output of recipe.outputs || []) {
    const db = findInDbByBuffName(output.name);
    if (!db) return { ok: false, error: 'recipe_output_not_found', message: `无法确认产物「${output.name}」的完整磨损区间，已停止搜索。` };
    const collection = findCollectionName(output.collection) || db.collections[0];
    if (!db.collections.includes(collection) || !materialSpecs.some(m => m.collection === collection)) {
      return { ok: false, error: 'recipe_output_mismatch', message: `产物「${output.name}」不属于配方材料的收藏品。` };
    }
    outputSpecs.push({ name: skinName(output.name), collection, range: [db.min, db.max], probability: output.probability });
  }
  if (!outputSpecs.length) return { ok: false, error: 'no_recipe_outputs', message: '分享配方缺少产物信息，无法按目标产物磨损反推材料磨损。' };
  const collections = [...new Set(materialSpecs.map(m => m.collection))];
  const collectionSpecs = collections.map(collection => ({
    id: collection,
    collection,
    grade: recipe.inputRarity,
    count: materialSpecs.filter(m => m.collection === collection).reduce((n, m) => n + m.count, 0),
    candidateCount: materialsInCollection(collection, recipe.inputRarity).length,
  }));
  return {
    ok: true, collection: collections.join(' + '), collections, grade: recipe.inputRarity,
    materialCount: materialSpecs.length, materials: materialSpecs.map(m => `${m.name} × ${m.count}`),
    materialSpecs, collectionSpecs, totalCount, outputSpecs, targetOutput: outputSpecs[0],
  };
}
