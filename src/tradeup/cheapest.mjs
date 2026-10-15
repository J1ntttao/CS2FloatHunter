import { f32, f32Spacing, outputTargetInfo, outputWearFromNormalizedSum } from './float.mjs';

/** 固定入炉顺序的确定性搜索。只裁掉有保守下界证明无法改善的分支。 */
export function cheapestCombination(norms, { count, outMin, outMax, targetOut,
  candidateGroups, groupCounts, prices = null, initialResults = [], timeBudgetMs = 8000,
  maxResults = 5, maxNodes = Infinity }) {
  const started = performance.now(), deadline = started + Math.max(0, timeBudgetMs);
  const groups = Object.keys(groupCounts), remaining = groups.map(g => groupCounts[g]);
  const groupIndex = new Map(groups.map((g, i) => [g, i]));
  const groupOf = candidateGroups.map(g => groupIndex.get(g));
  const comparable = prices?.length === norms.length && prices.every(p => Number.isFinite(p) && p >= 0 &&
    Math.abs(p * 100 - Math.round(p * 100)) < 1e-7 && Number.isSafeInteger(Math.round(p * 100)) && Math.round(p * 100) <= Number.MAX_SAFE_INTEGER / count);
  const costs = comparable ? prices.map(p => Math.round(p * 100)) : norms.map(() => 0);
  const want = f32(targetOut), theoretical = outputTargetInfo(want, count, outMin, outMax).minimumScore;
  const scoreOf = sum => Math.abs(outputWearFromNormalizedSum(sum, count, outMin, outMax) - want);
  const rank = (a, b) => a.score - b.score || a.costUnits - b.costUnits;
  const found = new Map();
  let best = null, nodes = 0, pruned = 0, stopped = false;
  function record(indices) {
    const sorted = [...indices].sort((a, b) => a - b);
    if (sorted.length !== count || new Set(sorted).size !== count || sorted.some(i => !Number.isInteger(i) || i < 0 || i >= norms.length) ||
      groups.some((g, j) => sorted.filter(i => groupOf[i] === j).length !== groupCounts[g])) return;
    let sum = 0, costUnits = 0;
    for (const i of sorted) { sum = f32(sum + f32(norms[i])); costUnits += costs[i]; }
    const entry = { indices: sorted, score: scoreOf(sum), costUnits };
    found.set(sorted.join(','), entry);
    if (!best || rank(entry, best) < 0) best = entry;
    if (found.size > maxResults * 4) {
      const keep = [...found.values()].sort(rank).slice(0, maxResults);
      found.clear(); for (const r of keep) found.set(r.indices.join(','), r);
    }
  }
  for (const r of initialResults) record(r.indices);
  const members = groups.map((_, g) => groupOf.flatMap((v, i) => v === g ? [i] : []));
  if (remaining.reduce((s, n) => s + n, 0) !== count || remaining.some((n, g) => !Number.isInteger(n) || n <= 0 || members[g].length < n)) {
    return { results: [], optimization: { proven: false, reason: 'invalid_quotas' } };
  }
  // 最便宜的配额组合给出全局价格下界；若已经达到理论误差下限，可立即证明最优。
  const cheapest = members.flatMap((list, g) => [...list].sort((a, b) => costs[a] - costs[b] || a - b).slice(0, remaining[g]));
  record(cheapest);
  const absoluteCost = cheapest.reduce((s, i) => s + costs[i], 0);
  const uniform = norms.every(n => f32(n) === f32(norms[0]));
  const immediate = uniform || (comparable && best.costUnits === absoluteCost && best.score === theoretical);
  // 每个组的后缀 DP 同时给出剩余 k 件的价格下界和归一化和上下界，空间 O(N * count)。
  const tables = immediate || timeBudgetMs <= 0 ? [] : members.map((list, g) => {
    const width = remaining[g] + 1, size = (list.length + 1) * width;
    const low = new Float64Array(size).fill(Infinity), high = new Float64Array(size).fill(-Infinity), price = new Float64Array(size).fill(Infinity);
    low[list.length * width] = high[list.length * width] = price[list.length * width] = 0;
    for (let p = list.length - 1; p >= 0; p--) {
      const at = p * width, next = at + width, i = list[p];
      low[at] = high[at] = price[at] = 0;
      for (let k = 1; k < width; k++) {
        low[at + k] = Math.min(low[next + k], norms[i] + low[next + k - 1]);
        high[at + k] = Math.max(high[next + k], norms[i] + high[next + k - 1]);
        price[at + k] = Math.min(price[next + k], costs[i] + price[next + k - 1]);
      }
    }
    return { list, width, low, high, price };
  });
  const chosen = [];
  // 非负且 <=1 的归一化值，count 次 float32 累加误差不超过 count 个此处的 ULP。
  const slack = (count + 2) * f32Spacing(Math.max(1, count));
  function visit(start, doubleSum, cost, needed) {
    if (++nodes > maxNodes || performance.now() >= deadline) { stopped = true; return; }
    if (!needed) { record(chosen); return; }
    let lo = doubleSum, hi = doubleSum, lowerCost = cost;
    for (let g = 0; g < groups.length; g++) {
      const k = remaining[g]; if (!k) continue;
      const t = tables[g];
      let l = 0, r = t.list.length;
      while (l < r) { const m = (l + r) >>> 1; if (t.list[m] < start) l = m + 1; else r = m; }
      const at = l * t.width + k;
      if (!Number.isFinite(t.low[at])) { pruned++; return; }
      lo += t.low[at]; hi += t.high[at]; lowerCost += t.price[at];
    }
    const lowWear = outputWearFromNormalizedSum(f32(Math.max(0, lo - slack)), count, outMin, outMax);
    const highWear = outputWearFromNormalizedSum(f32(Math.min(count, hi + slack)), count, outMin, outMax);
    const lowerScore = want < lowWear ? lowWear - want : want > highWear ? want - highWear : theoretical;
    if (best && (lowerScore > best.score || (comparable && lowerCost >= best.costUnits &&
      (lowerScore >= best.score || best.score === theoretical)))) { pruned++; return; }
    for (let i = start; i <= norms.length - needed; i++) {
      const g = groupOf[i]; if (g === undefined || !remaining[g]) continue;
      chosen.push(i); remaining[g]--;
      visit(i + 1, doubleSum + norms[i], cost + costs[i], needed - 1);
      remaining[g]++; chosen.pop();
      if (stopped) return;
    }
  }
  if (!immediate) {
    if (!tables.length) stopped = true;
    else visit(0, 0, 0, count);
  }
  const wearProven = immediate || !stopped;
  return { results: [...found.values()].sort(rank).slice(0, maxResults), optimization: {
    proven: comparable && wearProven, wearProven, comparable: !!comparable,
    reason: !comparable ? 'incomparable_prices' : stopped ? 'budget_exhausted' : 'complete',
    nodes, pruned, elapsedMs: Math.round(performance.now() - started),
    costLowerBound: comparable ? absoluteCost / 100 : null,
    objective: 'wear_error_then_price', scope: 'fetched_candidates',
  } };
}
