// 外观档位的上界不属于该档（BS 的 1 除外），用相邻 float32 避免边界重复。
export const EXTERIORS = {
  fn: { name: 'Factory New', label: '崭新出厂', range: [0, 0.07] },
  mw: { name: 'Minimal Wear', label: '略有磨损', range: [0.07, 0.15] },
  ft: { name: 'Field-Tested', label: '久经沙场', range: [0.15, 0.38] },
  ww: { name: 'Well-Worn', label: '破损不堪', range: [0.38, 0.45] },
  bs: { name: 'Battle-Scarred', label: '战痕累累', range: [0.45, 1] },
};
export function normalizeExteriors(value = Object.keys(EXTERIORS)) {
  const values = Array.isArray(value) ? value : String(value).split(',');
  if (!values.length || values.some(k => !Object.hasOwn(EXTERIORS, k))) return null;
  return Object.keys(EXTERIORS).filter(k => values.includes(k));
}
export function exteriorRange(key, skinRange) {
  const tier = EXTERIORS[key];
  if (!tier) return null;
  const [low, high] = tier.range.map(Math.fround);
  const bits = new Uint32Array(new Float32Array([high]).buffer);
  if (key !== 'bs') bits[0]--;
  const upper = new Float32Array(bits.buffer)[0];
  const result = [Math.max(low, Math.fround(skinRange[0])), Math.min(upper, Math.fround(skinRange[1]))];
  return result[0] <= result[1] ? result : null;
}
export function exteriorKey(name) {
  return Object.keys(EXTERIORS).find(k => String(name).endsWith(`(${EXTERIORS[k].name})`)) ||
    Object.keys(EXTERIORS).find(k => String(name).endsWith(`(${EXTERIORS[k].label})`) ||
      String(name).endsWith(`（${EXTERIORS[k].label}）`));
}
