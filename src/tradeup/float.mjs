/**
 * CS2 炼金（汰换合同）磨损数学。
 *
 * 本文件是 https://68688888.github.io/ （西林磨损计算器）核心算法的忠实移植，
 * 不是自己推导的公式。对应源码见 ref/script.js：
 *
 *   归一化每把材料（Utils.normalizeWearForCalculation, script.js:1151）
 *     normalized = IEEE754( (wear − 材料min) / (材料max − 材料min) )  再 clamp 到 [0,1]
 *
 *   汇总（script.js:1238-1243，以及 1319-1324 的批量版本）
 *     normalizedSum = IEEE754(normalizedSum + normalized)       // 逐项单精度累加
 *     avgNormalized = IEEE754(normalizedSum / IEEE754(count))
 *     wear          = IEEE754(min_wear + IEEE754(avgNormalized * IEEE754(max_wear − min_wear)))
 *
 * 关键点（也是我第一版写错的地方）：
 *   **每把材料要按它自己的磨损区间归一化**，然后再平均。
 *   只有当所有材料共用同一个区间时，(材料磨损的平均) 才等于 (归一化值的平均)。
 *   不同收藏品的材料区间不同，必须走归一化这条路。
 *
 * 全程用 Math.fround 强制 IEEE754 单精度 —— 与站点 Utils.getIEEE754
 * （Float32Array(1) 写入再读出）完全等价。
 */

/** 强制 IEEE754 单精度，等价于站点 Utils.getIEEE754 */
export const f32 = Math.fround;

/** 解析磨损字符串/数字为 float32 */
export function parseWear(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return f32(n);
}

/**
 * 站点 Utils.normalizeWearForCalculation 的移植（script.js:1151-1165）。
 *
 * 逐字对应站点：
 *   const materialMinWear = G(parseFloat(minStr) || 0);
 *   const materialMaxWear = G(parseFloat(maxStr) || 1);
 *   if (materialMaxWear - materialMinWear <= 0) return 0;
 *   const normalized = G((wearValue - materialMinWear) / (materialMaxWear - materialMinWear));
 *   return Math.max(0, Math.min(1, normalized));
 *
 * 注意两个易错点（都会引入 1 个 ULP 的偏差，实测对照才发现）：
 *  1. `wear` 要用**原始双精度值**参与减法，不能先 f32 —— 站点从 DOM 读到的就是双精度字符串。
 *  2. `(mx - mn)` 这类减法本身就是 IEEE754 双精度运算，**不要**再套 f32。
 *     只有最后的结果才落到单精度。
 */
export function normalizeWear(wear, matMin, matMax) {
  const mn = f32(matMin);
  const mx = f32(matMax);
  if (mx - mn <= 0) return 0;
  const normalized = f32((Number(wear) - mn) / (mx - mn));
  return Math.max(0, Math.min(1, normalized));
}

/** float32 在给定值处的可表示间距 */
export function f32Spacing(value) {
  const v = f32(value);
  const b = new Float32Array(1);
  const i = new Int32Array(b.buffer);
  b[0] = v;
  if (v === 0) return f32(1.401298464324817e-45);
  i[0] += 1;
  return Math.abs(b[0] - v) || Number.EPSILON;
}

/** IEEE754 可表示性：判断目标磨损是否真的能炼出来 */
export function ieee754Info(target) {
  const orig = Number(target);
  const asF32 = f32(orig);
  const sp = f32Spacing(asF32);
  return {
    input: orig,
    asFloat32: asF32,
    delta: Math.abs(asF32 - orig),
    exact: asF32 === orig,
    spacing: sp,
    nearestBelow: f32(asF32 - sp),
    nearestAbove: f32(asF32 + sp),
  };
}

/**
 * 计算产物磨损（站点主流程 script.js:1238-1243）。
 *
 * @param {{wear:number, matMin:number, matMax:number}[]} materials 每把材料 + 它自己的区间
 * @param {number} outMin 产物最小磨损
 * @param {number} outMax 产物最大磨损
 * @returns {number} 产物磨损（float32）
 */
export function outputWear(materials, outMin, outMax) {
  const n = materials.length;
  if (!n) return NaN;
  let sum = 0;
  for (const m of materials) sum = f32(sum + normalizeWear(m.wear, m.matMin, m.matMax));
  return outputWearFromNormalizedSum(sum, n, outMin, outMax);
}

/**
 * 已知归一化值总和时的产物磨损（求解器热路径）。
 * 逐字对应 script.js:1323-1324。
 * 产物区间先落到 f32：站点 script.js:1201-1202 读取时就是
 *   max_wear = G(Number(input)), min_wear = G(Number(input))
 * 漏掉这一步时，0.1~0.7 这类区间约七成结果会差 1 个 ULP。
 */
export function outputWearFromNormalizedSum(normSum, count, outMin, outMax) {
  const mn = f32(outMin);
  const mx = f32(outMax);
  const avgNormalized = f32(f32(normSum) / f32(count));
  return f32(mn + f32(avgNormalized * f32(mx - mn)));
}

/** 可表示的 float32 目标仍可能被 sum/count 的量化跳过，计算产物公式的理论误差下限。 */
export function outputTargetInfo(targetOut, count, outMin, outMax) {
  const want = f32(targetOut);
  const buffer = new ArrayBuffer(4), floats = new Float32Array(buffer), bits = new Uint32Array(buffer);
  floats[0] = f32(count);
  const end = bits[0];
  const outputAt = bit => { bits[0] = bit; return outputWearFromNormalizedSum(floats[0], count, outMin, outMax); };
  let lo = 0, hi = end;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (outputAt(mid) < want) lo = mid + 1; else hi = mid;
  }
  const nearestOutputs = [...new Set([outputAt(Math.max(0, lo - 1)), outputAt(lo)])].sort((a, b) => a - b);
  const minimumScore = Math.min(...nearestOutputs.map(v => Math.abs(v - want)));
  return { exact: minimumScore === 0, minimumScore, nearestOutputs };
}

/**
 * 反推：要得到 targetOut，材料的平均归一化值必须是多少。
 * 逐字对应站点 script.js:2085：
 *   const targetNormalized = Utils.getIEEE754((targetWear - targetMin) / (targetMax - targetMin));
 * 同样注意：减法和除法用双精度，只有最终结果落到 f32。
 */
export function requiredAvgNormalized(targetOut, outMin, outMax) {
  if (outMax - outMin <= 0) return NaN;
  return f32((Number(targetOut) - outMin) / (outMax - outMin));
}

/** 求解器用的目标归一化总和：avgNorm = sum/count → sum = avgNorm*count */
export function requiredNormalizedSum(targetOut, outMin, outMax, count) {
  return requiredAvgNormalized(targetOut, outMin, outMax) * count;
}

/**
 * 反推单把材料需要的磨损（站点“自动配材” script.js:2103 的同一个式子）：
 *   recommendedWear = G(materialMin + G(targetNormalized * (materialMax - materialMin)))
 */
export function recommendedWearFor(materialMin, materialMax, normalizedValue) {
  return f32(materialMin + f32(normalizedValue * (materialMax - materialMin)));
}

/** 校验一组材料的产物是否命中目标（float32 精确比较，同站点 isExactMatch） */
export function verifyCombination(materials, outMin, outMax, targetOut) {
  const got = outputWear(materials, outMin, outMax);
  const want = f32(targetOut);
  return { got, want, exact: got === want, delta: Math.abs(got - want) };
}

/**
 * 相遇中点（meet-in-the-middle）精确子集和。
 *
 * 用途：当 K = count/2 的组合数在可枚举范围内时，这是**确定性**的精确解法，
 * 比“随机重启 + 局部搜索”可靠得多（后者在几百个候选的池子上有明显失败率）。
 *
 * 做法：枚举左半边的 K 元组合、求其 float32 求和；对每个左半和 s，
 * 直接查表找右半边是否存在和为 (目标 - s) 的 K 元组合。
 * 因为是按 float32 值精确查表，命中即 float32 精确相等。
 *
 * @returns {{pairs: Array<{indices:number[], sum:number}>, leftCount:number, rightCount:number}|null}
 *   返回若干组命中；null 表示组合数超出可枚举上限（调用方应退回启发式搜索）
 */
export function meetInTheMiddle(normPool, count, wantSum, cfg = {}) {
  const { maxPerSide = 3_000_000, maxResults = 20 } = cfg;
  const N = normPool.length;
  if (N < count) return null;

  const K = Math.floor(count / 2);
  const K2 = count - K;

  const combos = n => (n * (n - 1)) / 2;
  // 粗略估算组合数，超限就放弃
  const est = (n, k) => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  };
  if (est(N, K) > maxPerSide || est(N, K2) > maxPerSide) return null;

  /** 枚举所有 k 元组合的 float32 求和 */
  function enumerate(k) {
    const sums = [];
    const idxs = [];
    const cur = new Array(k);
    const rec = (start, depth) => {
      if (depth === k) {
        let s = 0;
        for (let t = 0; t < k; t++) s = f32(s + f32(normPool[cur[t]]));
        sums.push(s);
        idxs.push(cur.slice());
        return;
      }
      for (let i = start; i < N; i++) { cur[depth] = i; rec(i + 1, depth + 1); }
    };
    rec(0, 0);
    return { sums, idxs };
  }

  const left = enumerate(K);
  const right = enumerate(K2);

  // 右半按 float32 求和建表
  const table = new Map();
  for (let i = 0; i < right.sums.length; i++) {
    const k = right.sums[i];
    if (!table.has(k)) table.set(k, []);
    table.get(k).push(i);
  }

  const target = f32(wantSum);
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < left.sums.length && pairs.length < maxResults; i++) {
    const need = f32(target - left.sums[i]);
    const hits = table.get(need);
    if (!hits) continue;
    for (const h of hits) {
      const indices = [...left.idxs[i], ...right.idxs[h]];
      // 两边下标天然不重叠（各自从全池枚举），但要排除同一候选被用两次
      const uniq = new Set(indices);
      if (uniq.size !== count) continue;
      const key = indices.slice().sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      let s = 0;
      for (const ix of indices) s = f32(s + f32(normPool[ix]));
      pairs.push({ indices: indices.slice().sort((a, b) => a - b), sum: s });
      if (pairs.length >= maxResults) break;
    }
  }
  return { pairs, leftCount: left.sums.length, rightCount: right.sums.length };
}

/**
 * 求解 count 把材料，使 float32 产物磨损 = 目标。
 *
 * 在**归一化空间**里做子集和：每个候选的贡献值是 normalizeWear(...)，
 * 目标是 requiredNormalizedSum(...)。
 *
 * 策略：随机重启 + 局部搜索（单点替换，真实 float32 评分），
 * 再用「2 换 2」的剩余总和查找把最后 1~2 个 ULP 磨平。
 *
 * @param {number[]} normPool 每个候选的归一化值（float32）
 * @param {object} cfg
 *   count, outMin, outMax, targetOut   —— 同前
 *   tries, maxResults, timeBudgetMs    —— 求解预算
 *   collections?: (string|null)[]      —— 与 normPool 等长的收藏品标识。
 *       给了就启用**混收藏品模式**：单点替换只在同一收藏品内进行，
 *       这样一开始选定的收藏品组合会被保留，搜索仍然只在归一化空间求和。
 *   maxCollections?: number            —— 混收藏品模式下最多涉及几个收藏品，
 *       在**搜索阶段**就强制（而不是事后过滤，避免结果被全部丢掉）。
 *   seedIndices?: number[]             —— 指定初始组合（用于“固定已有材料”）
 *   candidateGroups?: string[] / groupCounts?: object —— 每种材料的严格数量约束。
 *       起点、单点替换及 2 换 2 都保持每组数量，不以其它枪皮补足。
 */
export function solveCombinations(normPool, cfg) {
  const {
    count = 10, outMin, outMax, targetOut,
    tries = 4000, maxResults = 40, timeBudgetMs = 8000,
    collections = null, maxCollections = null, seedIndices = null,
    candidateGroups = null, groupCounts = null,
  } = cfg;

  const N = normPool.length;
  const wantSum = requiredNormalizedSum(targetOut, outMin, outMax, count);
  if (N < count) {
    return { results: [], reason: 'not_enough_candidates', poolSize: N, exactFound: false, bestScore: null, elapsedMs: 0, wantSum };
  }

  // 混收藏品模式下，预先把同收藏品的候选下标分组，替换时只在自己的组里找
  const groupOf = candidateGroups || (collections ? collections.map(c => c ?? '__none__') : null);
  const quotas = groupCounts ? new Map(Object.entries(groupCounts)) : null;
  const noResults = reason => ({ results: [], reason, poolSize: N, exactFound: false, bestScore: null, elapsedMs: 0, wantSum });
  if (quotas && (!candidateGroups || candidateGroups.length !== N ||
      [...quotas.values()].some(n => !Number.isInteger(n) || n <= 0) ||
      [...quotas.values()].reduce((a, n) => a + n, 0) !== count)) {
    return noResults('invalid_group_counts');
  }
  const groupMembers = new Map();
  if (groupOf) {
    for (let i = 0; i < N; i++) {
      const g = groupOf[i];
      if (!groupMembers.has(g)) groupMembers.set(g, []);
      groupMembers.get(g).push(i);
    }
  }
  if (quotas && [...quotas].some(([g, n]) => (groupMembers.get(g)?.length || 0) < n)) {
    return noResults('not_enough_group_candidates');
  }
  // 参与搜索的收藏品组：受 maxCollections 限制，按候选数从多到少取
  const allGroups = groupOf
    ? [...groupMembers.keys()].sort((a, b) => groupMembers.get(b).length - groupMembers.get(a).length)
    : null;
  const allowedGroups = quotas ? new Set(quotas.keys()) : (allGroups && maxCollections && maxCollections > 0)
    ? new Set(allGroups.slice(0, maxCollections))
    : (allGroups ? new Set(allGroups) : null);
  // 允许参与的候选下标（混收藏品模式下会剔除超限收藏品）
  const allowedIdx = groupOf
    ? [...Array(N).keys()].filter(i => allowedGroups.has(groupOf[i]))
    : [...Array(N).keys()];

  const wantF32 = f32(targetOut);
  const targetInfo = outputTargetInfo(targetOut, count, outMin, outMax);
  const deadline = Date.now() + timeBudgetMs;

  const scoreFromSum = sum => Math.abs(outputWearFromNormalizedSum(f32(sum), count, outMin, outMax) - wantF32);
  // 评分与返回材料保持同一顺序；float32 累加不能用减旧加新的估算代替。
  const sumOf = idx => { let s = 0; for (const i of [...idx].sort((a, b) => a - b)) s = f32(s + f32(normPool[i])); return s; };

  const results = [];
  const seen = new Set();
  const keyOf = idx => [...idx].sort((a, b) => a - b).join(',');
  const pushIfNew = idx => {
    if (quotas && (idx.length !== count || new Set(idx).size !== count ||
        [...quotas].some(([g, n]) => idx.filter(i => groupOf[i] === g).length !== n))) return false;
    const k = keyOf(idx);
    if (seen.has(k)) return false;
    seen.add(k);
    results.push({ indices: [...idx].sort((a, b) => a - b), score: scoreFromSum(sumOf(idx)) });
    return true;
  };

  const targetAvg = wantSum / count;
  const byDistToAvg = allowedIdx.slice().sort(
    (a, b) => Math.abs(normPool[a] - targetAvg) - Math.abs(normPool[b] - targetAvg)
  );

  const quotaSeed = random => {
    const idx = [];
    for (const [group, needed] of quotas) {
      const members = groupMembers.get(group).slice();
      if (random) {
        for (let i = members.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [members[i], members[j]] = [members[j], members[i]];
        }
      } else members.sort((a, b) => Math.abs(normPool[a] - targetAvg) - Math.abs(normPool[b] - targetAvg));
      idx.push(...members.slice(0, needed));
    }
    return idx;
  };

  const greedySeed = () => {
    if (quotas) return quotaSeed(false);
    if (seedIndices && seedIndices.length) {
      // 固定种子：保留已指定的材料，其余按“离目标均值最近”补足
      const fixed = new Set(seedIndices);
      const idx = [...seedIndices];
      if (idx.length >= count) return idx.slice(0, count);
      for (const c of byDistToAvg) {
        if (idx.length >= count) break;
        if (!fixed.has(c)) { idx.push(c); fixed.add(c); }
      }
      return idx;
    }
    const idx = byDistToAvg.slice(0, count);
    if (groupOf) {
      // 混收藏品模式下不要清一色：从不同收藏品里各取一部分做起点
      const groups = [...allowedGroups];
      for (let k = 0; k < Math.min(groups.length, count); k++) {
        const mem = groupMembers.get(groups[k])
          .slice().sort((a, b) => Math.abs(normPool[a] - targetAvg) - Math.abs(normPool[b] - targetAvg));
        if (mem.length) idx[k] = mem[0];
      }
    }
    const j = count + Math.floor(Math.random() * Math.max(1, Math.min(N - count, 12)));
    const k2 = Math.floor(Math.random() * count);
    if (j < N && !groupOf) idx[k2] = byDistToAvg[j];
    return idx;
  };

  const randomSeed = () => {
    if (quotas) return quotaSeed(true);
    const idx = []; const used = new Set();
    if (seedIndices && seedIndices.length) {
      for (const s of seedIndices.slice(0, count)) { idx.push(s); used.add(s); }
    }
    if (groupOf) {
      // 随机挑几个允许的收藏品，再从各自里面随机取
      const groups = [...allowedGroups];
      let guard = 0;
      while (idx.length < count && guard++ < 1000) {
        const g = groups[Math.floor(Math.random() * groups.length)];
        const mem = groupMembers.get(g);
        const pick = mem[Math.floor(Math.random() * mem.length)];
        if (!used.has(pick)) { used.add(pick); idx.push(pick); }
      }
      return idx;
    }
    while (idx.length < count) {
      const r = allowedIdx[Math.floor(Math.random() * allowedIdx.length)];
      if (!used.has(r)) { used.add(r); idx.push(r); }
    }
    return idx;
  };

  /** 某个位置可以被哪些下标替换（混收藏品模式下限定同收藏品） */
  const candidatesFor = (currentIdx) => {
    if (!groupOf) return null; // null 表示全池
    return (groupMembers.get(groupOf[currentIdx]) || []).filter(i => allowedGroups.has(groupOf[i]));
  };

  const localSearch = (start) => {
    const cur = [...start];
    const inSet = new Set(cur);
    let sum = sumOf(cur);
    let curScore = scoreFromSum(sum);
    if (curScore <= targetInfo.minimumScore) return { idx: cur, sum, score: curScore };
    let improved = true, iter = 0;

    while (improved && iter < 40 && Date.now() < deadline) {
      improved = false; iter++;
      for (let pos = 0; pos < cur.length; pos++) {
        const oldIdx = cur[pos];
        const oldVal = normPool[cur[pos]];
        let bestIdx = cur[pos], bestScore = curScore;
        const cands = candidatesFor(cur[pos]);
        const list = cands || Array.from({ length: N }, (_, i) => i);
        for (const c of list) {
          if (inSet.has(c)) continue;
          const nv = normPool[c];
          if (nv === oldVal) continue;
          cur[pos] = c;
          const s = scoreFromSum(sumOf(cur));
          cur[pos] = oldIdx;
          if (s < bestScore) { bestScore = s; bestIdx = c; }
          if (s === 0) { bestIdx = c; bestScore = 0; break; }
        }
        if (bestIdx !== cur[pos]) {
          inSet.delete(cur[pos]); inSet.add(bestIdx);
          cur[pos] = bestIdx;
          sum = sumOf(cur); curScore = bestScore; improved = true;
        }
        if (curScore <= targetInfo.minimumScore) return { idx: cur, sum, score: curScore };
      }
    }
    return { idx: cur, sum, score: curScore };
  };

  let exactFound = false;
  const startTime = Date.now();
  const searchDeadline = deadline - Math.min(2000, Math.max(0, timeBudgetMs * 0.2));
  for (let t = 0; t < tries; t++) {
    if (t > 0 && Date.now() > searchDeadline) break;
    const seed = t % 3 === 0 ? greedySeed() : (t % 3 === 1 ? randomSeed() : greedySeed().slice().reverse());
    let { idx, sum, score: s } = localSearch(seed);
    // 单换可能卡在局部最优；在重启早期就尝试剩余预算的二元补偿。
    if (s > targetInfo.minimumScore && t < 8 && Date.now() < searchDeadline) {
      const improved = polish({ indices: idx, score: s }, Math.min(50, searchDeadline - Date.now()));
      if (improved.score < s) ({ idx, sum, score: s } = localSearch(improved.indices));
    }
    pushIfNew(idx);
    if (s <= targetInfo.minimumScore) { exactFound = s === 0; break; }
  }

  // 若启发式搜索没能精确命中，且不涉及收藏品约束，就用相遇中点做**确定性**精确求解。
  // 注意：可行性完全取决于“有效候选数”——C(300,5)≈195 亿，枚举不动；
  // 所以调用方应该先用 --band / --limit 把候选压到几十个（站点也是这么建议的）。
  // 这里用 maxPerSide 严格把关，超限时 MEET-IN-THE-MIDDLE 会返回 null，不影响其他路径。
  let mitmInfo = null;
  if (!exactFound && !groupOf && count % 2 === 0 && Date.now() < deadline &&
      !results.some(r => r.score <= targetInfo.minimumScore)) {
    const mitm = meetInTheMiddle(normPool, count, wantSum, {
      maxPerSide: 200_000, maxResults: Math.max(maxResults * 2, 20),
    });
    if (mitm) {
      mitmInfo = { leftCount: mitm.leftCount, rightCount: mitm.rightCount, hits: mitm.pairs.length };
      for (const p of mitm.pairs) {
        if (pushIfNew(p.indices)) {
          if (scoreFromSum(p.sum) === 0) { exactFound = true; break; }
        }
      }
    } else {
      mitmInfo = { skipped: 'too_many_candidates', poolSize: N };
    }
  }

  /** 2 换 2 抛光：单点替换会卡在需要同时换两个才更好的局部最优上。
   *  混收藏品模式下，替换项必须与被打掉的位置同属一个收藏品。
   *
   *  关键正确性细节：不能用 `f32(f32(sum - va) - vb)` 这类增量减法来算替换后的和。
   *  float32 加法不满足结合律，`f32(f32(sum−va)−vb)` 与「真正把那两项换掉后逐项累加」
   *  的结果可能差 1 个 ULP，于是候选会被一个**并非它真实得分**的分数评分并写进结果
   *  （表现为 bestScore=0 但复核却不命中）。所以这里老老实实重新累加。 */
  function polish(entry, budgetMs = 2000) {
    if (!entry || entry.score <= targetInfo.minimumScore) return entry;
    const pDeadline = Math.min(deadline, Date.now() + budgetMs);
    const cur = [...entry.indices];
    const inSet = new Set(cur);
    let bestScore = entry.score, bestPair = null;

    const sorted = new Map();
    const candsFor = i => {
      const key = groupOf ? groupOf[i] : '__all__';
      if (!sorted.has(key)) sorted.set(key, (groupOf ? groupMembers.get(key) : allowedIdx)
        .filter(c => !inSet.has(c)).sort((a, b) => normPool[a] - normPool[b] || a - b));
      return sorted.get(key);
    };
    const lowerBound = (list, value) => {
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1;
        if (normPool[list[mid]] < value) lo = mid + 1; else hi = mid;
      }
      return lo;
    };

    /** 把 cur 的第 a、b 项换成 x、y 后，逐项累加得到的真实 float32 和 */
    const sumWith = (a, b, x, y) => {
      const next = [...cur]; next[a] = x; next[b] = y;
      return sumOf(next);
    };

    for (let a = 0; a < cur.length && Date.now() < pDeadline; a++) {
      const listA = candsFor(cur[a]);
      for (let b = a + 1; b < cur.length && Date.now() < pDeadline; b++) {
        const listB = candsFor(cur[b]);
        const remaining = cur.reduce((s, i, pos) => s + (pos === a || pos === b ? 0 : normPool[i]), 0);
        for (const x of listA) {
          if (Date.now() >= pDeadline) break;
          // 第一个替换确定后，只查剩余目标总和附近的第二个候选。
          const center = lowerBound(listB, wantSum - remaining - normPool[x]);
          for (let j = Math.max(0, center - 4); j < Math.min(listB.length, center + 5); j++) {
            const y = listB[j];
            if (y === x) continue;
            const s = scoreFromSum(sumWith(a, b, x, y));
            if (s < bestScore) { bestScore = s; bestPair = { a, b, x, y }; if (s <= targetInfo.minimumScore) break; }
          }
          if (bestScore <= targetInfo.minimumScore) break;
        }
        if (bestScore <= targetInfo.minimumScore) break;
      }
      if (bestScore <= targetInfo.minimumScore) break;
    }
    if (!bestPair) return entry;
    const next = [...cur];
    next[bestPair.a] = bestPair.x;
    next[bestPair.b] = bestPair.y;
    next.sort((p, q) => p - q);
    // 用真实和重新给一次分，杜绝把“估算分”当成真实分
    return { indices: next, score: scoreFromSum(sumOf(next)) };
  }

  results.sort((a, b) => a.score - b.score);
  if (!exactFound && results.length && results[0].score > 0) {
    const budget = Math.max(0, Math.min(4000, deadline - Date.now()));
    const polished = polish(results[0], budget);
    if (polished.score < results[0].score) {
      results[0] = polished;
      exactFound = polished.score === 0;
    }
  }
  results.sort((a, b) => a.score - b.score);

  // 收尾自检：统一按返回顺序重算 float32 分数，保证 score 与材料复核一致。
  for (const r of results) {
    r.score = scoreFromSum(sumOf(r.indices));
  }
  results.sort((a, b) => a.score - b.score);
  exactFound = results.some(r => r.score === 0);

  const trimmed = results.slice(0, maxResults);
  // 注意：exactFound 必须是“粘性”的。之前这里用 trimmed.some(...) 重算，
  // 结果精确命中的组合可能被排序挤出前 maxResults 而丢失，导致 exactFound 假阴性。
  const anyExact = results.some(r => r.score === 0);
  // 若有精确命中，保证它一定出现在返回列表里（置顶）
  if (anyExact && !trimmed.some(r => r.score === 0)) {
    trimmed.unshift(results.find(r => r.score === 0));
    trimmed.pop();
  }
  return {
    results: trimmed,
    exactFound: anyExact,
    bestScore: trimmed[0]?.score ?? null,
    poolSize: N,
    elapsedMs: Date.now() - startTime,
    wantSum,
    minimumPossibleScore: targetInfo.minimumScore,
    mitm: mitmInfo,
  };
}

/**
 * 混收藏品时的产物分布。
 *
 * 规则：产物从**投入材料所属的那些收藏品**里按数量加权随机抽取。
 * 也就是说，投入 3 把这个收藏品的材料 + 7 把那个收藏品的材料，
 * 就有 30% 出前者的产物、70% 出后者的产物。
 *
 * 产物磨损的算法与单收藏品完全一致：先把每把材料按**它自己的区间**归一化，
 * 求平均归一化值，再映射到**各自产物**的磨损区间上。
 * 因为同一收藏品内不同产物的磨损区间相同，所以同一收藏品的产物磨损是唯一的。
 *
 * @param {{wear:number, matMin:number, matMax:number, collection?:string}[]} materials
 * @param {number} outMin 产物最小磨损
 * @param {number} outMax 产物最大磨损
 * @returns {{groups: Array, avgNormalized:number, totalWear:number}}
 *   groups 每项：{ collection, count, probability, wear }
 */
export function outputDistribution(materials, outMin, outMax) {
  const n = materials.length;
  if (!n) return { groups: [], avgNormalized: NaN, totalWear: NaN };

  let sum = 0;
  for (const m of materials) sum = f32(sum + normalizeWear(m.wear, m.matMin, m.matMax));
  const avgNormalized = f32(f32(sum) / f32(n));
  const totalWear = outputWearFromNormalizedSum(sum, n, outMin, outMax);

  const byCollection = new Map();
  for (const m of materials) {
    const key = m.collection ?? '__unknown__';
    byCollection.set(key, (byCollection.get(key) || 0) + 1);
  }

  const groups = [...byCollection.entries()]
    .map(([collection, count]) => ({
      collection,
      count,
      probability: count / n,
      // 同一收藏品的产物磨损相同：都等于本次的 totalWear
      wear: totalWear,
    }))
    .sort((a, b) => b.count - a.count);

  return { groups, avgNormalized, totalWear };
}

/** 磨损格式化 */
export function fmtWear(w, digits = 10) {
  if (!Number.isFinite(w)) return '-';
  return Number(w).toFixed(digits);
}
