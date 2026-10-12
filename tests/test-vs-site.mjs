/**
 * 对照测试：把我的实现与 https://68688888.github.io/ 的真实源码逐位比较。
 *
 * 做法：把站点自己的 ref/script.js 放进 Node 里求值（它只在 DOMContentLoaded 时启动，
 * 顶层只定义 class，所以加载是安全的），拿到它的 Utils.getIEEE754 /
 * Utils.normalizeWearForCalculation，再用它的主流程公式（script.js:1238-1243）
 * 作为基准，与我的 src/tradeup/float.mjs 对照。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as mine from '../src/tradeup/float.mjs';

// ---- 1. 在 Node 里加载站点源码 ----
const root = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'ref', 'script.js'), 'utf8');

const noop = () => {};
const fakeEl = new Proxy({}, {
  get: (t, p) => {
    if (p === 'style') return fakeEl;
    if (p === 'classList') return { add: noop, remove: noop, contains: () => false };
    if (p === 'textContent' || p === 'value' || p === 'innerHTML') return '';
    if (p === 'appendChild' || p === 'insertBefore' || p === 'setAttribute' || p === 'remove') return noop;
    if (p === 'querySelector' || p === 'querySelectorAll') return () => (p === 'querySelectorAll' ? [] : null);
    if (p === 'parentNode') return fakeEl;
    return noop;
  },
  set: () => true,
});
const documentStub = {
  addEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeEl,
  body: fakeEl,
};
const sandbox = { document: documentStub, window: {}, console, Math, Number, parseFloat, parseInt, Float32Array, Int32Array, Date, setTimeout: noop };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// 顶层 class 声明不会挂到 globalThis，追加导出
vm.runInContext(src + '\n;globalThis.__Utils = Utils;', sandbox, { filename: 'site-script.js' });

const SiteUtils = sandbox.__Utils;
if (!SiteUtils) { console.error('无法从站点源码取到 Utils'); process.exit(1); }
console.log('✅ 已加载站点源码，Utils 方法:', Object.getOwnPropertyNames(SiteUtils).filter(n => typeof SiteUtils[n] === 'function').join(', '));

// ---- 2. 用站点自己的公式算产物磨损（script.js:1238-1243）----
function siteOutputWear(materials, outMin, outMax) {
  const G = SiteUtils.getIEEE754;
  let normalizedSum = 0;
  for (const m of materials) {
    normalizedSum = G(normalizedSum + SiteUtils.normalizeWearForCalculation(m.wear, m.matMin, m.matMax));
  }
  const avgNormalized = G(normalizedSum / G(materials.length));
  return G(outMin + G(avgNormalized * G(outMax - outMin)));
}

// normalizeWearForCalculation 在站点里是读 DOM 的，这里改写成等价的纯函数版本
SiteUtils.normalizeWearForCalculation = (wearValue, matMin, matMax) => {
  const G = SiteUtils.getIEEE754;
  const mn = G(matMin), mx = G(matMax);
  if (mx - mn <= 0) return 0;
  return Math.max(0, Math.min(1, G((wearValue - mn) / (mx - mn))));
};

// ---- 3. 对照 ----
let pass = 0, fail = 0;
/** 断言两个值相等 */
const eq = (name, a, b) => {
  const ok = Object.is(a, b);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        a=${a}\n        b=${b}`}`);
  ok ? pass++ : fail++;
};
/** 断言某个计数为 0（即“全部一致”） */
const eq0 = (name, diffCount, samples) => {
  const ok = diffCount === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}（${samples} 组，不一致 ${diffCount} 处）`);
  ok ? pass++ : fail++;
};

console.log('\n=== A. getIEEE754 等价性（随机 20000 个值）===');
{
  let diff = 0;
  for (let i = 0; i < 20000; i++) {
    const v = Math.random() * 1.2 - 0.1;
    if (!Object.is(SiteUtils.getIEEE754(v), mine.f32(v))) diff++;
  }
  eq0('Math.fround === 站点 getIEEE754', diff, 20000);
}

console.log('\n=== B. 归一化等价性（随机 20000 组）===');
{
  let diff = 0;
  for (let i = 0; i < 20000; i++) {
    const mn = Math.random() * 0.5;
    const mx = mn + 0.05 + Math.random() * 0.5;
    const w = mn + Math.random() * (mx - mn);
    const a = SiteUtils.normalizeWearForCalculation(w, mn, mx);
    const b = mine.normalizeWear(w, mn, mx);
    if (!Object.is(a, b)) diff++;
  }
  eq0('normalizeWear 逐位一致', diff, 20000);
}

console.log('\n=== C. 产物磨损等价性：同区间 10 把材料 ===');
{
  const outMin = 0.10, outMax = 0.70;
  // 同一件材料的区间
  const matMin = 0.10, matMax = 0.70;
  let diff = 0, samples = 0;
  for (let t = 0; t < 3000; t++) {
    const materials = Array.from({ length: 10 }, () => {
      const w = matMin + Math.random() * (matMax - matMin);
      return { wear: mine.f32(w), matMin, matMax };
    });
    const a = mine.outputWear(materials, outMin, outMax);
    const b = siteOutputWear(materials, outMin, outMax);
    samples++;
    if (!Object.is(a, b)) diff++;
  }
  eq0('同区间全部一致', diff, samples);
}

console.log('\n=== D. 产物磨损等价性：每把材料区间都不同（关键场景）===');
{
  const outMin = 0.10, outMax = 0.70;
  let diff = 0, samples = 0;
  for (let t = 0; t < 3000; t++) {
    const materials = Array.from({ length: 10 }, (_, i) => {
      // 模拟来自不同收藏品的材料，区间各不相同
      const matMin = [0, 0.06, 0.10, 0.12][i % 4];
      const matMax = [0.5, 0.7, 0.8, 1.0][i % 4];
      const w = matMin + Math.random() * (matMax - matMin);
      return { wear: mine.f32(w), matMin, matMax };
    });
    const a = mine.outputWear(materials, outMin, outMax);
    const b = siteOutputWear(materials, outMin, outMax);
    samples++;
    if (!Object.is(a, b)) diff++;
  }
  eq0('混合区间全部一致', diff, samples);
}

console.log('\n=== E. 反推一致：requiredAvgNormalized ===');
{
  const outMin = 0.1, outMax = 0.7;
  let diff = 0;
  for (let i = 0; i < 5000; i++) {
    const target = outMin + Math.random() * (outMax - outMin);
    const G = SiteUtils.getIEEE754;
    const siteVal = G((target - outMin) / (outMax - outMin));
    if (!Object.is(siteVal, mine.requiredAvgNormalized(target, outMin, outMax))) diff++;
  }
  eq0('反推归一化均值逐位一致', diff, 5000);
}

console.log('\n=== F. 关键反例：混合区间时“平均原始磨损”是错的 ===');
{
  const outMin = 0.10, outMax = 0.70;
  const materials = [
    { wear: mine.f32(0.15), matMin: 0.10, matMax: 0.70 },
    { wear: mine.f32(0.15), matMin: 0.10, matMax: 0.70 },
    { wear: mine.f32(0.15), matMin: 0.10, matMax: 0.70 },
    { wear: mine.f32(0.15), matMin: 0.10, matMax: 0.70 },
    { wear: mine.f32(0.15), matMin: 0.10, matMax: 0.70 },
    { wear: mine.f32(0.05), matMin: 0.00, matMax: 0.50 }, // 区间不同的材料
    { wear: mine.f32(0.05), matMin: 0.00, matMax: 0.50 },
    { wear: mine.f32(0.05), matMin: 0.00, matMax: 0.50 },
    { wear: mine.f32(0.05), matMin: 0.00, matMax: 0.50 },
    { wear: mine.f32(0.05), matMin: 0.00, matMax: 0.50 },
  ];
  const correct = mine.outputWear(materials, outMin, outMax);
  const siteVal = siteOutputWear(materials, outMin, outMax);
  // 错误做法：直接平均原始磨损
  const naiveAvg = materials.reduce((a, m) => a + m.wear, 0) / 10;
  const naive = mine.f32(outMin + mine.f32(mine.f32(naiveAvg) * mine.f32(outMax - outMin)));

  console.log(`  正确（归一化） = ${correct}`);
  console.log(`  站点           = ${siteVal}`);
  console.log(`  错误（平均原始磨损） = ${naive}`);
  eq('我的实现与站点一致', correct, siteVal);
  eq('两种做法确实不同（说明这个修正是必要的）', correct !== naive, true);
  console.log(`  差异 = ${Math.abs(correct - naive).toExponential(3)}`);
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
