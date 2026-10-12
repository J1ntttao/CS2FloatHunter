import {
  f32, normalizeWear, outputWear, outputWearFromNormalizedSum,
  requiredAvgNormalized, requiredNormalizedSum, recommendedWearFor,
  ieee754Info, verifyCombination, solveCombinations, meetInTheMiddle,
} from '../src/tradeup/float.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => check(name, Object.is(a, b), `a=${a} b=${b}`);

/** 造一批材料；同区间时用同一个 range */
const mk = (wears, range) => wears.map(w => ({ wear: w, matMin: range[0], matMax: range[1] }));

console.log('=== 1. 归一化 ===');
{
  eq('区间 [0,1] 时归一化等于自身', normalizeWear(0.25, 0, 1), f32(0.25));
  eq('区间 [0.1,0.7] 时 0.4 → 0.5', normalizeWear(0.4, 0.1, 0.7), f32(0.5));
  eq('低于区间下限被 clamp 到 0', normalizeWear(0.05, 0.1, 0.7), 0);
  eq('高于区间上限被 clamp 到 1', normalizeWear(0.9, 0.1, 0.7), 1);
  eq('区间为零时返回 0', normalizeWear(0.3, 0.5, 0.5), 0);
}

console.log('\n=== 2. 产物磨损公式 ===');
{
  // 同区间且区间恰为产物区间时，产物磨损 == 材料磨损平均（归一化后仍是线性映射）
  const r = [0.10, 0.70];
  const wears = Array(10).fill(0.10);
  eq('材料全 0.10，区间=产物区间 → 0.10', outputWear(mk(wears, r), 0.10, 0.70), f32(0.10));

  // 材料区间 [0,1]，产物区间 [0.1,0.7]：材料均值 0.5 → 产物 0.1+0.5*0.6=0.4
  const m2 = mk(Array(10).fill(0.5), [0, 1]);
  eq('材料区间[0,1] 全 0.5 → 产物 0.4', outputWear(m2, 0.10, 0.70), f32(0.4));

  // 混合区间：一半材料区间[0,1]均值0.5，一半区间[0,0.5]均值0.25
  // 归一化后都是 0.5 → 产物 0.4
  const mixed = [...mk(Array(5).fill(0.5), [0, 1]), ...mk(Array(5).fill(0.25), [0, 0.5])];
  eq('不同区间但归一化相同 → 产物 0.4', outputWear(mixed, 0.10, 0.70), f32(0.4));

  // 与 outputWearFromNormalizedSum 一致
  const sum = mixed.reduce((a, m) => f32(a + normalizeWear(m.wear, m.matMin, m.matMax)), 0);
  eq('outputWear === outputWearFromNormalizedSum',
    outputWear(mixed, 0.10, 0.70), outputWearFromNormalizedSum(sum, 10, 0.10, 0.70));
}

console.log('\n=== 3. 反推与正算互逆 ===');
{
  const outMin = 0.10, outMax = 0.70, target = 0.1512345;
  const avgNorm = requiredAvgNormalized(target, outMin, outMax);
  const sum = requiredNormalizedSum(target, outMin, outMax, 10);
  eq('sum = avgNorm * count', sum, avgNorm * 10);
  const got = outputWearFromNormalizedSum(f32(sum), 10, outMin, outMax);
  check('反推后正算回到目标（float32 精度内）', Math.abs(got - f32(target)) < 1e-7, `got=${got}`);
}

console.log('\n=== 4. 自动配材反推（站点 script.js:2103）===');
{
  // 材料区间 [0.1,0.7]，需要贡献归一化 0.5 → 应买 0.4
  eq('归一化 0.5 在区间[0.1,0.7] → 磨损 0.4', recommendedWearFor(0.1, 0.7, 0.5), f32(0.4));
  eq('归一化 0 在区间[0.1,0.7] → 磨损 0.1', recommendedWearFor(0.1, 0.7, 0), f32(0.1));
  // 注意：这里**不能**直接写 f32(0.7)。站点式子是 G(min + G(k*(max-min)))，
  // 0.1 先被舍成 f32(0.1)=0.10000000149011612，所以结果是 0.7000000476837158，
  // 与 f32(0.7)=0.699999988079071 差 1 个 ULP。这是站点自身的行为，必须照抄。
  eq('归一化 1 在区间[0.1,0.7] → 0.7000000476837158（与站点式子一致）',
    recommendedWearFor(0.1, 0.7, 1), f32(0.1 + f32(1 * (0.7 - 0.1))));
  check('该结果确实不等于 f32(0.7)', !Object.is(recommendedWearFor(0.1, 0.7, 1), f32(0.7)),
    '说明这里忠实复刻了站点的中间舍入');
}

console.log('\n=== 5. IEEE754 可表示性 ===');
{
  check('0.1 不可精确表示', ieee754Info(0.1).exact === false);
  check('0.5 可精确表示', ieee754Info(0.5).exact === true);
  const i = ieee754Info(0.06666666);
  check('间距为正', i.spacing > 0);
  check('nearestBelow < 值 < nearestAbove', i.nearestBelow < i.asFloat32 && i.asFloat32 < i.nearestAbove);
}

console.log('\n=== 6. 求解器：池中存在精确解 ===');
{
  // 思路：先用**相遇中点**确定性地找出一个真实存在的精确和（它就是「已知可达」的基准），
  // 再用这个和反推目标产物磨损，最后验证 solveCombinations 能否命中它。
  //
  // 为什么不能自己"植入"一个和：float32 加法不满足结合律，求和结果依赖**累加顺序**，
  // 相遇中点按「左半前5个 + 右半后5个」累加，与按下标一路累加可能差 1 个 ULP。
  // 所以基准必须由求解器同一套口径算出来。
  const outMin = 0.10, outMax = 0.70;

  // 池子用固定种子，确定可复现
  let seed = 31337;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const norm = [];
  for (let i = 0; i < 24; i++) norm.push(f32(0.25 + (rnd() - 0.5) * 1e-5));

  // 以 2.5 为目标跑相遇中点，它返回的每组都是「float32 下精确等于该和」的组合
  const probe = meetInTheMiddle(norm, 10, 2.5, { maxPerSide: 200000, maxResults: 3 });
  if (!probe || !probe.pairs.length) {
    console.log('  ! 前置条件失败：相遇中点没枚举出任何精确和，跳过本用例');
  } else {
    const ref = probe.pairs[0];
    const wantSum = ref.sum;
    const targetOut = f32(outMin + f32(f32(wantSum / 10) * f32(outMax - outMin)));

    // 基准自检：这组解必须真的能复核通过
    const refMats = ref.indices.map(i => ({ wear: norm[i], matMin: 0, matMax: 1 }));
    const refV = verifyCombination(refMats, outMin, outMax, targetOut);
    check('基准解自身可复核', refV.exact, `got=${refV.got} want=${refV.want}`);
    console.log(`      基准和=${wantSum} 目标产物磨损=${targetOut}`);

    const t0 = Date.now();
    const res = solveCombinations(norm, { count: 10, outMin, outMax, targetOut, tries: 500, maxResults: 10, timeBudgetMs: 10000 });

    // 断言「求解器承诺可复核」：凡是它标为 score===0 的结果，用 verifyCombination 复核必须真的命中。
    // 不去断言「一定存在精确解」——启发式求解器对任意池子并不保证找到，
    // 这也是它给出 bestScore 而不是布尔值的原因。
    const hits = res.results.filter(r => {
      const mats = r.indices.map(i => ({ wear: norm[i], matMin: 0, matMax: 1 }));
      return verifyCombination(mats, outMin, outMax, targetOut).exact;
    });
    check('标为精确命中的结果都能复核通过',
      res.results.filter(r => r.score === 0).every(r => {
        const mats = r.indices.map(i => ({ wear: norm[i], matMin: 0, matMax: 1 }));
        return verifyCombination(mats, outMin, outMax, targetOut).exact;
      }),
      `score=0 的有 ${res.results.filter(r => r.score === 0).length} 个`);
    check('exactFound 与实际命中数一致', res.exactFound === (hits.length > 0),
      `exactFound=${res.exactFound} hits=${hits.length}`);

    console.log(`      池子 ${res.poolSize}，耗时 ${Date.now() - t0}ms，精确命中 ${hits.length} 组，最优误差 ${res.bestScore?.toExponential(2)}`);
  }
}

console.log('\n=== 7. 求解器：逼真场景（围绕目标分布）===');
{
  // 用固定种子的伪随机数，保证测试可复现（否则池子每次都不同，结果会偶发抖动）
  let seed = 20261012;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const outMin = 0.10, outMax = 0.70, targetOut = 0.1512345;
  const avgNorm = requiredAvgNormalized(targetOut, outMin, outMax);
  const norm = [];
  for (let i = 0; i < 400; i++) norm.push(f32(avgNorm + (rnd() - 0.5) * 0.05));

  const res = solveCombinations(norm, { count: 10, outMin, outMax, targetOut, tries: 1500, maxResults: 5, timeBudgetMs: 10000 });
  check('给出候选', res.results.length > 0);
  const best = res.results[0];
  if (best) {
    const mats = best.indices.map(i => ({ wear: norm[i], matMin: 0, matMax: 1 }));
    const v = verifyCombination(mats, outMin, outMax, targetOut);
    console.log(`      最优产物 ${v.got} vs 目标 ${v.want}（差 ${v.delta.toExponential(3)}）`);
    // 诚实的能力边界：单个 ULP 在该目标处约 1.49e-8。
    // 均匀随机池下不保证每次都能精确归零，但必须落在 1 个 ULP 以内。
    const ulp = 1.4901161193847656e-8 * 1.001;
    check('误差不超过 1 个 ULP', v.delta < ulp, `delta=${v.delta}`);
    console.log(`      （该处 1 ULP ≈ ${ulp.toExponential(3)}）`);
  }
}

console.log('\n=== 7b. 求解器：给足预算时能找到精确解 ===');
{
  // 构造“必存在精确解”的池子：植入 24 个恰好等于目标平均归一化值的候选
  const outMin = 0.10, outMax = 0.70, targetOut = 0.1512345;
  const avgNorm = requiredAvgNormalized(targetOut, outMin, outMax);
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const norm = [];
  for (let i = 0; i < 24; i++) norm.push(f32(avgNorm));
  for (let i = 0; i < 376; i++) norm.push(f32(avgNorm + (rnd() - 0.5) * 0.05));

  const res = solveCombinations(norm, { count: 10, outMin, outMax, targetOut, tries: 4000, maxResults: 5, timeBudgetMs: 15000 });
  const best = res.results[0];
  check('找到精确解', res.exactFound === true, `best=${res.bestScore}`);
  if (best) {
    const mats = best.indices.map(i => ({ wear: norm[i], matMin: 0, matMax: 1 }));
    const v = verifyCombination(mats, outMin, outMax, targetOut);
    check('验证精确命中', v.exact, `delta=${v.delta}`);
  }
}

console.log('\n=== 8. 边界 ===');
{
  const r = solveCombinations([0.1, 0.2], { count: 10, outMin: 0, outMax: 1, targetOut: 0.5 });
  eq('候选不足时给出原因', r.reason, 'not_enough_candidates');
}

console.log('\n=== 6b. 相遇中点：确定性精确求解（小池子）===');
{
  // 相遇中点是**确定性**的：只要池子够小、且确实存在精确解，就必然找到。
  const outMin = 0.10, outMax = 0.70, targetOut = 0.25;
  const wantSum = requiredNormalizedSum(targetOut, outMin, outMax, 10);
  const RANGE = [0, 1];

  // 造 26 个候选：其中 10 个是精心构造、float32 求和恰为目标总和的解
  const planted = [];
  let acc = 0;
  for (let i = 0; i < 9; i++) { const v = f32(0.25 + (i - 4) * 1e-6); planted.push(v); acc = f32(acc + v); }
  planted.push(f32(wantSum - acc));
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pool = [...planted];
  while (pool.length < 26) pool.push(f32(rnd()));

  const r = meetInTheMiddle(pool, 10, wantSum, { maxPerSide: 200000, maxResults: 10 });
  check('相遇中点能在小池子里枚举', r !== null);
  if (r) {
    console.log(`      左 ${r.leftCount} 组合 / 右 ${r.rightCount} 组合，命中 ${r.pairs.length} 组`);
    check('确实命中精确解', r.pairs.length > 0, `hits=${r.pairs.length}`);
    if (r.pairs[0]) {
      const mats = r.pairs[0].indices.map(i => ({ wear: pool[i], matMin: RANGE[0], matMax: RANGE[1] }));
      const v = verifyCombination(mats, outMin, outMax, targetOut);
      check('命中项验证为 float32 精确相等', v.exact, `got=${v.got} want=${v.want}`);
    }
  }
  // 大池子应当被明确拒绝，而不是悄悄算错
  const big = Array.from({ length: 300 }, (_, i) => f32(rnd()));
  const r2 = meetInTheMiddle(big, 10, wantSum, { maxPerSide: 200000 });
  check('大池子明确返回 null（不硬算）', r2 === null);
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
