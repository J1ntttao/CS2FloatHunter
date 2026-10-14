import { f32, f32Spacing, recommendedWearFor, outputWearFromNormalizedSum } from '../tradeup/float.mjs';

/** 半径控制首轮目标附近的检索宽度；不能乘材料数量后退化为全区间。 */
export function combinationBands(specs, normalizedTarget, outRange, count, radius) {
  const span = f32(outRange[1]) - f32(outRange[0]);
  const delta = radius / span;
  const lo = Math.max(0, normalizedTarget - delta);
  const hi = Math.min(1, normalizedTarget + delta);
  const targetSum = count * normalizedTarget;
  // 其它 count-1 把必须能够补足剩余总和，才值得检索这个贡献区间。
  const slack = count * f32Spacing(Math.max(1, targetSum));
  const min = Math.max(lo, targetSum - (count - 1) * hi - slack);
  const max = Math.min(hi, targetSum - (count - 1) * lo + slack);
  return specs.map(m => ({ ...m,
    band: [min === 0 ? f32(m.range[0]) : Math.max(f32(m.range[0]), recommendedWearFor(...m.range, min)),
      max === 1 ? f32(m.range[1]) : Math.min(f32(m.range[1]), recommendedWearFor(...m.range, max))],
  }));
}

/** 用已抓挂单的固定配额上下界检查可达性，并排除无法被其它材料补偿的挂单。 */
export function feasibleCandidates(pool, quotas, targetSum, outRange, count) {
  const groups = new Map();
  for (const m of pool) {
    if (!groups.has(m.recipeGroupId)) groups.set(m.recipeGroupId, []);
    groups.get(m.recipeGroupId).push(m);
  }
  const bounds = new Map();
  let minSum = 0, maxSum = 0;
  for (const [group, needed] of Object.entries(quotas)) {
    const members = (groups.get(group) || []).slice().sort((a, b) => a.norm - b.norm);
    if (members.length < needed) return { pool, reachable: false, shortage: true };
    const low = members.slice(0, needed), high = members.slice(-needed);
    const min = low.reduce((s, m) => s + m.norm, 0), max = high.reduce((s, m) => s + m.norm, 0);
    bounds.set(group, { needed, low: new Set(low), high: new Set(high), min, max,
      lowEdge: low.at(-1).norm, highEdge: high[0].norm });
    minSum += min; maxSum += max;
  }
  // 上下界用 double 求和；保留逐项 float32 舍入误差，不能误删最后几个 ULP 的精确解。
  const slack = count * f32Spacing(Math.max(1, maxSum, targetSum));
  const reachable = targetSum >= minSum - slack && targetSum <= maxSum + slack;
  const candidates = reachable ? pool.filter(m => {
    const b = bounds.get(m.recipeGroupId);
    const restMin = b.needed === 1 ? 0 : b.min -
      (b.low.has(m) ? m.norm : b.lowEdge);
    const restMax = b.needed === 1 ? 0 : b.max -
      (b.high.has(m) ? m.norm : b.highEdge);
    // 从本组配额中留出一个位置给 m，剩余配额仍使用真实且不重复的挂单。
    const min = minSum - b.min + restMin + m.norm;
    const max = maxSum - b.max + restMax + m.norm;
    return targetSum >= min - slack && targetSum <= max + slack;
  }) : pool;
  return { pool: candidates, reachable,
    range: [outputWearFromNormalizedSum(Math.max(0, minSum - slack), count, ...outRange),
      outputWearFromNormalizedSum(Math.min(count, maxSum + slack), count, ...outRange)],
    pruned: pool.length - candidates.length };
}
