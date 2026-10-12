#!/usr/bin/env node
/**
 * CS2 目标磨损炼金助手 —— 主流程。
 *
 * 流程：
 *   1) 解析目标产物磨损，用 IEEE754 校验该值是否真实存在
 *   2) 反推需要的材料平均磨损，确定材料磨损带
 *   3) 从 BUFF 搜索同档材料 → 拉取每件材料的磨损区间 → 抓取落在磨损带内的真实挂单
 *   4) 用 float32 精确求解 10 把材料
 *   5) 输出台账 + 生成可视化 HTML
 *
 * 用法示例：
 *   node src/cli.mjs --target 0.1512345 --out-min 0.10 --out-max 0.70
 *   node src/cli.mjs --target 0.06666666 --out-min 0.06 --out-max 0.80 --rarity classified
 *   node src/cli.mjs --target 0.1512345 --out-min 0.10 --out-max 0.70 --dry   # 只算数学，不联网
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildPoolFromBuff, buildPoolFromYoupin, poolStats, normalizePool } from './market/pool.mjs';
import {
  f32, requiredAvgNormalized, requiredNormalizedSum, outputWear, outputDistribution,
  solveCombinations, ieee754Info, verifyCombination,
} from './tradeup/float.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const DATA_DIR = path.join(ROOT, 'data');

function parseArgs(argv) {
  const o = {
    target: null, outMin: 0.10, outMax: 0.70, rarity: 'classified',
    count: 10, band: 0.02, maxItems: 25, maxListingsPerItem: 60,
    mode: 'game', dry: false, intervalMs: 3000, timeBudgetMs: 20000, wants: 5,
    market: 'buff', maxTemplates: 40, mix: false, maxCollections: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--target' || a === '-t') o.target = parseFloat(v());
    else if (a === '--out-min') o.outMin = parseFloat(v());
    else if (a === '--out-max') o.outMax = parseFloat(v());
    else if (a === '--rarity') o.rarity = v();
    else if (a === '--market') o.market = v();
    else if (a === '--max-templates') o.maxTemplates = parseInt(v(), 10);
    else if (a === '--mix') o.mix = true;
    else if (a === '--no-mix') o.mix = false;
    else if (a === '--max-collections') o.maxCollections = parseInt(v(), 10);
    else if (a === '--count') o.count = parseInt(v(), 10);
    else if (a === '--band') o.band = parseFloat(v());
    else if (a === '--max-items') o.maxItems = parseInt(v(), 10);
    else if (a === '--max-listings') o.maxListingsPerItem = parseInt(v(), 10);
    else if (a === '--mode') o.mode = v();
    else if (a === '--interval') o.intervalMs = parseInt(v(), 10);
    else if (a === '--time-budget') o.timeBudgetMs = parseInt(v(), 10);
    else if (a === '--wants') o.wants = parseInt(v(), 10);
    else if (a === '--dry') o.dry = true;
    else if (a === '--help' || a === '-h') { help(); process.exit(0); }
  }
  return o;
}

function help() {
  console.log(`CS2 目标磨损炼金助手

  --target <float>     目标产物磨损（必填），如 0.1512345
  --out-min <float>    产物磨损区间下限（默认 0.10）
  --out-max <float>    产物磨损区间上限（默认 0.70）
  --rarity <key>       材料稀有度：consumer|industrial|milspec|restricted|classified（默认 classified）
                       隐秘(ancient) 产物的材料是 classified；隐蔽(legendary) 产物的材料是 restricted
  --market <m>         数据源：buff | youpin | both（默认 buff）
                       注意：youpin 匿名每个模板只能拿到 20 笔挂单，池子比 buff 小一个数量级
  --max-templates <n>  youpin 最多检查多少个模板（默认 40）
  --mix                开启**混收藏品配方**：材料可以来自不同收藏品，
                       产物变成按材料数量加权的概率分布（网页会列出每个产物的概率）
  --no-mix             关闭混收藏品（默认关闭，即单收藏品→确定产物）
  --max-collections <n> 混收藏品时最多涉及几个收藏品（默认 3）
  --count <n>          材料数量（默认 10）
  --band <float>       材料磨损带宽度（默认 0.02，越大越可能精确命中但抓取更慢）
  --max-items <n>      最多检查多少件材料（默认 25）
  --max-listings <n>   每件材料最多抓多少笔挂单（默认 60）
  --mode <game|exact>  磨损计算模式（默认 game，最贴近游戏内部）
  --interval <ms>      请求间隔（默认 3000，buff 风控严格，别调太小）
  --time-budget <ms>   求解器时间预算（默认 20000）
  --wants <n>          返回多少组候选配方（默认 5）
  --dry                不联网，只用合成数据演示数学流程`);
}

const args = parseArgs(process.argv);
if (args.target == null) { help(); process.exit(1); }

const RARITY_LABEL = {
  consumer: '消费级', industrial: '工业级', milspec: '军规级',
  restricted: '受限', classified: '保密', covert: '隐秘',
};
if (!Object.keys(RARITY_LABEL).includes(args.rarity)) {
  console.error(`[错误] 未知材料稀有度 "${args.rarity}"，可选：${Object.keys(RARITY_LABEL).join(', ')}`);
  process.exit(1);
}

const TARGET = args.target;
const ie = ieee754Info(TARGET);
const wantNorm = requiredAvgNormalized(TARGET, args.outMin, args.outMax);
// 若所有材料都与产物同区间，材料磨损均值就等于这个归一化值；否则要按各自区间折算
const wantAvg = wantNorm;

console.log('════════════════════════════════════════════════════════════');
console.log(' CS2 目标磨损炼金助手');
console.log('════════════════════════════════════════════════════════════');
console.log(`目标产物磨损 : ${TARGET}`);
console.log(`产物区间     : [${args.outMin}, ${args.outMax}]`);
console.log(`材料稀有度   : ${RARITY_LABEL[args.rarity]} (${args.rarity})`);
console.log(`材料数量     : ${args.count}`);
console.log('');
console.log('【IEEE754 校验】');
console.log(`  float32 可表示值 : ${ie.asFloat32}`);
console.log(`  输入是否精确     : ${ie.exact ? '是' : '否（最近可表示值如上）'}`);
console.log(`  可表示间距       : ${ie.spacing.toExponential(4)}`);
if (!ie.exact) {
  console.log(`  ! 你输入的磨损在 float32 下不存在，实际操作会被吸附到 ${ie.asFloat32}`);
}
console.log(`  需要材料平均磨损 : ${wantAvg.toFixed(10)}`);

let pool = [];
let usableItems = [];
let buildLog = [];

if (args.dry) {
  console.log('\n【--dry 模式】用合成挂单演示数学流程，不访问网络。');
  // 刻意给每笔挂单不同的磨损区间与收藏品，模拟“材料来自不同收藏品”的真实情况
  const rangePool = [[0.00, 0.50], [0.06, 0.80], [0.10, 0.70], [0.00, 1.00], [0.12, 0.45]];
  const setPool = ['set_community_2', 'set_community_5', 'set_bravo', 'set_phoenix', 'set_hydra'];
  for (let i = 0; i < 300; i++) {
    const rg = rangePool[i % rangePool.length];
    const w = Math.min(rg[1], Math.max(rg[0], wantAvg + (Math.random() - 0.5) * args.band));
    pool.push({
      market: 'synthetic', templateId: 0, orderId: `S${i}`,
      paintwear: f32(w), matRange: rg,
      itemset: setPool[i % setPool.length],
      collectionName: `合成收藏品${i % setPool.length + 1}`,
      price: Math.round(10 + Math.random() * 200),
      name: `合成材料 #${i} 区间[${rg[0]},${rg[1]}]`,
    });
  }
} else {
  const markets = args.market === 'both' ? ['buff', 'youpin'] : [args.market];
  for (const mk of markets) {
    console.log(`\n──── 数据源：${mk} ────`);
    let r;
    if (mk === 'buff') {
      r = await buildPoolFromBuff({
        rarity: args.rarity, wantAvg, band: args.band,
        maxItems: args.maxItems, maxListingsPerItem: args.maxListingsPerItem,
        intervalMs: args.intervalMs, verbose: true,
      });
    } else if (mk === 'youpin') {
      r = await buildPoolFromYoupin({
        rarity: args.rarity, wantAvg, band: args.band,
        maxTemplates: args.maxTemplates, intervalMs: args.intervalMs, verbose: true,
      });
    } else {
      console.error(`  未知数据源 "${mk}"，可选 buff | youpin | both`);
      process.exit(5);
    }
    if (r.error) {
      if (r.error === 'login_required') {
        console.error(`  [${mk}] 需要登录态。buff 请运行：`);
        console.error('         powershell -File scripts\\set-cookies.ps1 -Site buff');
      } else {
        console.error(`  [${mk}] 抓取失败：${r.error}`);
      }
      if (markets.length === 1) process.exit(2);
      continue;
    }
    pool = pool.concat(r.pool);
    usableItems = usableItems.concat(r.usableItems);
    buildLog = buildLog.concat(r.log);
  }

  if (!usableItems.length) {
    console.error('\n没有任何材料的磨损区间能覆盖所需均值。');
    console.error('可能原因：产物区间给错了 / 材料稀有度选错了（材料要比产物低一档）/ --band 太小。');
    process.exit(3);
  }
}

console.log(`\n候选池共 ${pool.length} 笔挂单`);
if (pool.length < args.count) {
  console.error(`候选不足 ${args.count} 笔，无法求解。可加大 --band、--max-items，或换 --market。`);
  process.exit(4);
}
const stats = poolStats(pool);
console.log(`磨损范围 ${stats.minWear.toFixed(9)} ~ ${stats.maxWear.toFixed(9)}`);
console.log(`价格范围 ¥${stats.minPrice} ~ ¥${stats.maxPrice}`);

// 归一化：每把材料按它自己的区间折算，再进求解器
const { norm, usable: cand } = normalizePool(pool);
console.log(`\n归一化后可用候选 ${cand.length} 笔`);
if (cand.length < args.count) {
  console.error(`归一化后候选不足 ${args.count} 笔（原始 ${pool.length} 笔里有些缺少磨损区间或超出范围）。`);
  process.exit(4);
}
const wantNormSum = requiredNormalizedSum(TARGET, args.outMin, args.outMax, args.count);
console.log(`需要的归一化总和 = ${wantNormSum}（每把平均 ${wantNormSum / args.count}）`);

// 混收藏品模式：给求解器带上每笔候选所属的收藏品，替换只在同收藏品内进行
let normPool = norm;
let candPool = cand;
let collections = null;
if (args.mix) {
  // 只有带收藏品信息的候选才能参与（否则产物归属无法判定）
  const idx = [];
  for (let i = 0; i < cand.length; i++) {
    if (cand[i].itemset || cand[i].collectionName) idx.push(i);
  }
  normPool = idx.map(i => norm[i]);
  candPool = idx.map(i => cand[i]);
  collections = candPool.map(c => c.itemset || c.collectionName || '__unknown__');
  const distinct = new Set(collections).size;
  console.log(`\n【混收藏品模式】可用于混材的候选 ${candPool.length} 笔，来自 ${distinct} 个不同收藏品`);
  if (distinct < 2) {
    console.error('  可用的收藏品不足 2 个，无法构成混收藏品配方。');
    console.error('  可加大 --band / --max-items 以纳入更多收藏品的材料。');
    process.exit(6);
  }
  const bySet = new Map();
  for (const c of collections) bySet.set(c, (bySet.get(c) || 0) + 1);
  console.log('  各收藏品候选数：' + [...bySet.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 10).map(([k, v]) => `${k}:${v}`).join('  '));
}

console.log(`\n求解 ${args.count} 把材料${args.mix ? '（混收藏品）' : ''} ...`);
const t0 = Date.now();
const solved = solveCombinations(normPool, {
  count: args.count, outMin: args.outMin, outMax: args.outMax, targetOut: TARGET,
  tries: args.mix ? 60000 : 20000, maxResults: args.wants, timeBudgetMs: args.timeBudgetMs,
  collections,
  maxCollections: args.mix ? args.maxCollections : null,
});
console.log(`  精确命中=${solved.exactFound}  最优误差=${solved.bestScore?.toExponential(3)}  耗时=${Date.now() - t0}ms`);

// 组装结果
const recipes = solved.results.map(r => {
  const picks = r.indices.map(i => candPool[i]);
  const mats = picks.map(p => ({
    wear: p.paintwear, matMin: p.matRange[0], matMax: p.matRange[1],
    collection: p.itemset || p.collectionName || null,
  }));
  const dist = outputDistribution(mats, args.outMin, args.outMax);
  const out = dist.totalWear;
  const cost = picks.reduce((a, p) => a + (p.price || 0), 0);

  // 收藏品数量超限则跳过（在混收藏品模式下生效）
  const distinctCount = dist.groups.filter(g => g.collection !== '__unknown__').length;
  if (args.mix && distinctCount > args.maxCollections) return null;

  return {
    score: r.score,
    exact: r.score === 0,
    outputWear: out,
    cost,
    mixCount: distinctCount,
    outputs: dist.groups.map(g => ({
      collection: g.collection,
      collectionName: (picks.find(p => (p.itemset || p.collectionName) === g.collection) || {}).collectionName || g.collection,
      count: g.count,
      probability: g.probability,
      wear: g.wear,
    })),
    materials: picks.map(p => ({
      market: p.market, goodsId: p.goodsId, templateId: p.templateId, orderId: p.orderId,
      assetId: p.assetId,
      name: p.name || p.matName, paintwear: p.paintwear, paintwearRaw: p.paintwearRaw,
      matRange: p.matRange, norm: p.norm,
      collection: p.itemset || null,
      collectionName: p.collectionName || null,
      price: p.price, priceText: p.price != null ? `¥${p.price}` : '-',
      tradable: p.tradable,
      url: p.url, buyUrl: p.buyUrl || p.url, inspectUrl: p.inspectUrl || null,
    })),
  };
}).filter(Boolean);

console.log('\n════════════════════════════════════════════════════════════');
console.log(' 结果');
console.log('════════════════════════════════════════════════════════════');
recipes.forEach((r, i) => {
  console.log(`\n配方 #${i + 1}  ${r.exact ? '★ 精确命中' : `误差 ${r.score.toExponential(3)}`}  产物磨损=${r.outputWear}  材料总价=¥${r.cost.toFixed(2)}`);
  if (r.outputs.length > 1) {
    console.log(`   产物分布（${r.outputs.length} 个收藏品）：`);
    for (const o of r.outputs) {
      console.log(`     ${(o.probability * 100).toFixed(0).padStart(3)}%  ${o.count}把  ${o.collectionName}  磨损 ${o.wear}`);
    }
  } else if (r.outputs[0]) {
    console.log(`   产物收藏品：${r.outputs[0].collectionName}`);
  }
  for (const m of r.materials) {
    console.log(`   ${m.priceText.padStart(10)}  float=${String(m.paintwear).padEnd(20)} 区间[${m.matRange[0]},${m.matRange[1]}]  ${m.name}`);
    console.log(`               购买: ${m.buyUrl || '-'}${m.inspectUrl ? `\n               检视: ${m.inspectUrl}` : ''}`);
  }
});

// 落盘
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const payload = {
  generatedAt: new Date().toISOString(),
  engine: '68688888.github.io 西林磨损计算器（算法已逐位对齐，见 tests/test-vs-site.mjs）',
  request: {
    target: TARGET, outMin: args.outMin, outMax: args.outMax,
    rarity: args.rarity, count: args.count, band: args.band, market: args.market,
    mix: args.mix, maxCollections: args.maxCollections,
  },
  ieee754: ie,
  requiredAvgWear: wantAvg,
  requiredNormalizedSum: wantNormSum,
  poolSize: pool.length,
  normalizedPoolSize: cand.length,
  mixPoolSize: args.mix ? candPool.length : null,
  exactFound: solved.exactFound,
  recipes,
};
const jsonFile = path.join(OUT_DIR, `recipe-${stamp}.json`);
fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(DATA_DIR, 'last-pool.json'), JSON.stringify(pool.slice(0, 800), null, 2));
console.log(`\n台账已写入: ${jsonFile}`);

const { renderHtml } = await import('./web/report.mjs');
const htmlFile = path.join(OUT_DIR, `report-${stamp}.html`);
fs.writeFileSync(htmlFile, renderHtml(payload));
console.log(`可视化网页: ${htmlFile}`);
