/**
 * 「仅 Steam」求解路径的离线测试：用假的 BUFF / Steam 客户端，验证
 *   - 只用包含目标磨损的那一个区间档（不会把相邻档混进来）
 *   - 每把材料都带皮肤名、Steam 购买链接、来自 Steam 挂单的磨损与价格
 *   - 产物磨损按该区间正确计算
 */
import assert from 'node:assert/strict';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { outputWear } from '../src/tradeup/float.mjs';
import fs from 'node:fs';
import { SteamMarket, parseValveSsrListings, steamListingMatches } from '../src/market/steam.mjs';
import { materialsInCollection } from '../src/cs2up/materials.mjs';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

// 保存的真实 SSR 页面同时含有 FT/WW/BS，不能用请求名覆盖页内物品身份。
const fixture = fs.readFileSync(new URL('../ref/steam/listing-page.html', import.meta.url), 'utf8');
const parsed = parseValveSsrListings(fixture);
ok(parsed.ok && new Set(parsed.listings.map(l => l.marketHashName)).size > 1, '真实 Steam 聚合页包含多个磨损档');
ok(parsed.listings[0].name === 'AUG | 蛇窟 (久经沙场)' &&
  parsed.listings[0].marketHashName === 'AUG | Snake Pit (Field-Tested)', '保留挂单自身的中英文名称');
const fixtureMarket = new SteamMarket({ minIntervalMs: 0 });
fixtureMarket.fetch = async () => ({ status: 200, body: fixture });
const fixtureResult = await fixtureMarket.listingsWithFloats('AUG | Snake Pit (Field-Tested)', { pages: 2 });
const fixtureFt = parsed.listings.filter(l => l.marketHashName === 'AUG | Snake Pit (Field-Tested)');
ok(fixtureResult.listings.length === fixtureFt.length && fixtureResult.listings.every(l =>
  l.marketHashName === 'AUG | Snake Pit (Field-Tested)' && l.floatvalue >= 0.15 && l.floatvalue < 0.38),
  'Steam 适配器排除聚合页中其它档位并对分页重复挂单去重');
const liveListing = fixtureFt[0];
const liveCheck = await fixtureMarket.verifyListing(liveListing);
ok(liveCheck.ok && liveCheck.available === true, 'Steam 最终配方复核可以确认挂单仍在售');
const missingCheck = await fixtureMarket.verifyListing({ ...liveListing, listingId: 'missing-listing' });
ok(missingCheck.ok && missingCheck.available === false, 'Steam 最终配方复核可以识别已被买走的挂单');
ok(!steamListingMatches({ marketHashName: 'X (Factory New)', floatvalue: 0.2226156443 }, 'X (Factory New)'),
  '0.222 磨损不能冒充崭新出厂');
ok(!steamListingMatches({ floatvalue: 0.22 }, 'X (Field-Tested)'), '缺少真实商品身份的挂单不参与求解');
ok(steamListingMatches({ marketHashName: 'X (Battle-Scarred)', floatvalue: 0.85 }, 'X (Field-Tested)',
  { allowOtherExteriors: true }), '库存采样保留同枪皮高磨损档的真实挂单');
ok(!steamListingMatches({ marketHashName: 'Other (Battle-Scarred)', floatvalue: 0.85 }, 'X (Field-Tested)',
  { allowOtherExteriors: true }), '库存采样仍拒绝其它枪皮');
ok(!steamListingMatches({ marketHashName: 'StatTrak™ X (Battle-Scarred)', floatvalue: 0.85 }, 'X (Field-Tested)',
  { allowOtherExteriors: true }), '跨外观档采样不混入暗金品质');
for (const [wear, exterior] of [[0, 'Factory New'], [0.07, 'Minimal Wear'], [0.15, 'Field-Tested'],
  [0.38, 'Well-Worn'], [0.45, 'Battle-Scarred'], [1, 'Battle-Scarred']]) {
  const name = `X (${exterior})`;
  ok(steamListingMatches({ marketHashName: name, floatvalue: Math.fround(wear) }, name), `磨损边界 ${wear} → ${exterior}`);
}
const sampledPages = [];
const sampler = new SteamMarket({ minIntervalMs: 0 });
sampler.fetch = async () => ({ status: 200, body: fixture });
const sampled = await sampler.listingsWithFloats('AUG | Snake Pit (Field-Tested)', {
  pages: 1, minPaintwear: 0.2, maxPaintwear: 0.21, retainOutOfBand: true, allowOtherExteriors: true,
  onPage: listings => sampledPages.push([...listings]),
});
ok(sampled.listings.length > 0 && sampled.listings.some(l => l.floatvalue < 0.2 || l.floatvalue > 0.21),
  '库存模式保留查询优先区间外的真实挂单');
ok(sampledPages.length === 1 && sampledPages[0].length === sampled.listings.length,
  'Steam 每页成功后立即把候选交给增量求解，而非等所有页面抓完');
let stopPageRequests = 0;
sampler.fetch = async () => { stopPageRequests++; return { status: 200, body: fixture }; };
const stopPageState = {};
const stoppedPages = await sampler.listingsWithFloats('AUG | Snake Pit (Field-Tested)', {
  pages: 16, resumeState: stopPageState, onPage: () => false,
});
ok(stopPageRequests === 1 && stoppedPages.stoppedEarly && stopPageState.nextPage === 1,
  '增量求解命中后立即停止深翻页，检查点只记录真正完成的页面');

// 第一页全是别的档位时仍须继续翻页，后续页可能才出现目标档位。
const ssr = listings => `<script id="valve-ssr-data">${JSON.stringify({ listings })}</script>`;
let fetched = 0;
fixtureMarket.fetch = async () => {
  const exterior = fetched++ === 0 ? '(Battle-Scarred)' : '(Field-Tested)';
  return { status: 200, body: ssr([parsed.listings.find(l => l.marketHashName.endsWith(exterior)).raw]) };
};
const laterPage = await fixtureMarket.listingsWithFloats('AUG | Snake Pit (Field-Tested)', { pages: 2 });
ok(fetched === 2 && laterPage.listings.length === 1, '过滤后第一页为空仍继续抓取第二页');

// 第二页超时后，检查点保留第一页；继续时从第二页开始，不重复请求第一页。
const pageController = new AbortController();
const pageState = {};
const interruptedMarket = new SteamMarket({ minIntervalMs: 0, signal: pageController.signal });
const interruptedUrls = [];
interruptedMarket.fetch = async url => {
  interruptedUrls.push(url);
  if (url.includes('start=20')) {
    pageController.abort(new DOMException('搜索超时', 'TimeoutError'));
    throw pageController.signal.reason;
  }
  return { status: 200, body: ssr([parsed.listings.find(l => l.marketHashName === 'AUG | Snake Pit (Field-Tested)').raw]) };
};
await assert.rejects(
  interruptedMarket.listingsWithFloats('AUG | Snake Pit (Field-Tested)', { pages: 3, resumeState: pageState }),
  e => e.name === 'TimeoutError',
);
assert.equal(pageState.nextPage, 1);
assert.equal(pageState.listings.length, 1);
const resumedMarket = new SteamMarket({ minIntervalMs: 0 });
const resumedUrls = [];
resumedMarket.fetch = async url => {
  resumedUrls.push(url);
  return { status: 200, body: ssr([parsed.listings.find(l => l.marketHashName === 'AUG | Snake Pit (Field-Tested)').raw]) };
};
const resumedPages = await resumedMarket.listingsWithFloats('AUG | Snake Pit (Field-Tested)', { pages: 3, resumeState: pageState });
assert.ok(resumedUrls[0].includes('start=20'));
ok(interruptedUrls.length === 2 && resumedPages.listings.length === 1, 'Steam 页级超时后只从未完成页继续抓取');

// 两个皮肤，各有三个磨损档商品；只有 [0.15,0.35] 档包含目标 0.2004
const SKINS = ['AUG | 钢铁哨兵', '新星 | 夜雨月台'];
const RANGES = { 'Factory New': [0, 0.07], 'Minimal Wear': [0.07, 0.15], 'Field-Tested': [0.15, 0.35] };
const goods = new Map();
let gid = 1;
for (const s of SKINS) for (const [ext, r] of Object.entries(RANGES)) {
  goods.set(gid, { name: `${s} (${ext})`, range: r, mhn: `EN ${s} (${ext})` });
  gid++;
}

const hunter = new CollectionHunter({ intervalMs: 0 });
// mock 本地材料库：返回两个皮肤，各有 FT 区间 [0.15, 0.35] 覆盖目标
hunter._materialsInCollection = () => SKINS.map(s => ({
  key: s, name: s, min: 0.15, max: 0.35, grade: 'industrial', collections: ['X'],
}));
hunter.enumerateMaterials = async () => SKINS.map(s => ({
  db: { name: s }, ok: true,
  variants: [...goods.entries()].filter(([, g]) => g.name.startsWith(s)).map(([id, g]) => ({ goodsId: id, name: g.name })),
}));
hunter.buff = {
  goodsInfo: async id => ({ ok: true, info: { paintwear_range: goods.get(id).range, market_hash_name: goods.get(id).mhn } }),
};

let seq = 0;
const steam = {
  async listingsWithFloats(mhn) {
    const g = [...goods.values()].find(x => x.mhn === mhn);
    const listings = [];
    for (let i = 0; i < 30; i++) {
      const f = g.range[0] + (g.range[1] - g.range[0]) * Math.random();
      listings.push({ listingId: String(++seq), marketHashName: g.mhn, floatvalue: f, price: 0.3 + i / 100, priceText: `¥${(0.3 + i / 100).toFixed(2)}`, currencyId: 23, paintseed: i });
    }
    // Steam 聚合页里常会混入其它磨损档；这些不能被当前商品重复使用。
    listings.push({ listingId: String(++seq), marketHashName: `${g.mhn} (wrong exterior)`, floatvalue: 0.2004, price: 0.01, currencyId: 23 });
    listings[0].assetId = 'asset-shared-between-products';
    listings.push({ ...listings[0] }); // 同一挂单重复出现
    listings.push({ ...listings[0], listingId: String(++seq) }); // 同一资产被重复挂单
    // 一笔美元挂单，必须被排除
    listings.push({ listingId: String(++seq), marketHashName: g.mhn, floatvalue: 0.2004, price: 9.99, currencyId: 1 });
    return { ok: true, listings, pagesFetched: 2 };
  },
};

const target = 0.20040205;
const r = await hunter.huntFromSteam({
  collectionName: 'X', materialGrade: 'industrial', targetWear: target, band: 0.15, count: 10, steam,
}, { timeBudgetMs: 3000, wants: 3 });

ok(r.ok, `求解成功（${r.message || ''}）`);
ok(r.dataSource === 'steam', 'dataSource = steam');
ok(JSON.stringify(r.outRange) === '[0.15,0.35]', `产物/材料区间取包含目标的档位 ${JSON.stringify(r.outRange)}`);
ok(r.band[0] >= 0.15 && r.band[1] <= 0.35, `磨损带被夹在区间内 ${r.band.map(v => v.toFixed(4))}`);
ok(r.skippedRanges.length === 0, `跳过不包含目标的档位（${r.skippedRanges.length} 个）`);
ok(r.poolSize === 59, `候选池跨商品去重后包含 59 件真实材料（${r.poolSize} 件）`);

const rec = r.recipes[0];
ok(rec && rec.materials.length === 10, '配方有 10 把材料');
for (const m of rec.materials) {
  if (!m.name || !m.name.includes('|')) { ok(false, `材料缺皮肤名 ${JSON.stringify(m)}`); break; }
  if (!m.url || new URL(m.url).searchParams.get('detail') !== m.listingId ||
      new URL(m.url).searchParams.has('listing') || !m.url.includes(encodeURIComponent(m.marketHashName))) {
    ok(false, `购买链接不对 ${m.url}`); break;
  }
  if (JSON.stringify(m.matRange) !== '[0.15,0.35]') { ok(false, `混入了别的档位 ${m.matRange}`); break; }
  if (m.price === 9.99) { ok(false, '混入了非人民币挂单'); break; }
}
ok(rec.materials.every(m => m.name && m.url), '每把材料都有皮肤名和 Steam 购买链接');
ok(rec.materials.every(m => m.marketHashName && !m.marketHashName.includes('wrong exterior')), '排除聚合页中的其它磨损档');
ok(new Set(rec.materials.map(m => m.listingId)).size === 10, '入炉的 10 件材料挂单各不相同');
const assetIds = rec.materials.map(m => m.assetId).filter(Boolean);
ok(new Set(assetIds).size === assetIds.length, '同一资产不能通过不同挂单或商品入口重复入炉');
const cost = rec.materials.reduce((a, m) => a + m.price, 0);
ok(Math.abs(cost - rec.cost) < 1e-9, `总价 = 各笔 Steam 价格之和（¥${rec.cost.toFixed(2)}）`);
const recomputed = outputWear(rec.materials.map(m => ({ wear: m.paintwear, matMin: 0.15, matMax: 0.35 })), 0.15, 0.35);
ok(recomputed === rec.outputWear, `产物磨损可复算 ${rec.outputWear}`);
ok(Math.abs(rec.outputWear - target) < 1e-3, `产物磨损接近目标（误差 ${Math.abs(rec.outputWear - target).toExponential(2)}）`);

// 复现用户的 10 行结果：真实挂单只有 5 笔，多种外观入口返回同一批挂单。
const repro = new CollectionHunter({ intervalMs: 0 });
const blue = 'Five-SeveN | Sky Blue';
const naval = 'M4A4 | Naval Shred Camo';
repro._materialsInCollection = () => [{ name: 'FN57 | 青空', min: 0, max: 0.6 },
  { name: 'M4A4 | 海军虎纹迷彩', min: 0, max: 0.6 }];
repro.enumerateMaterials = async () => repro._materialsInCollection().map(m => ({ db: m, ok: true,
  variants: ['Well-Worn', 'Factory New', 'Minimal Wear', 'Field-Tested', 'Battle-Scarred']
    .map(ext => ({ goodsId: `${m.name.startsWith('FN57') ? blue : naval} (${ext})`, name: `${m.name} (${ext})` })),
}));
repro.buff = { goodsInfo: async id => ({ ok: true, info: { market_hash_name: id } }) };
const ids = ['552411343247404614', '538900544339609368', '538900544339550112', '538900544339576176'];
const wears = [0.2226156443, 0.2250957787, 0.1943360269, 0.2225033194];
const reproResult = await repro.huntFromSteam({ collectionName: 'X', materialGrade: 'industrial',
  targetWear: 0.2222222239, band: 0.03, count: 10, steam: {
    listingsWithFloats: async name => ({ ok: true, listings: name.startsWith(blue)
      ? ids.map((id, i) => ({ listingId: id, assetId: id, marketHashName: `${blue} (Field-Tested)`,
        name: 'FN57 | 青空 (久经沙场)', floatvalue: wears[i], price: i === 0 ? 0.28 : 0.34, currencyId: 23 }))
      : [{ listingId: '526515644821269024', assetId: '526515644821269024',
        marketHashName: `${naval} (Field-Tested)`, name: 'M4A4 | 海军虎纹迷彩 (久经沙场)',
        floatvalue: 0.2447056323, price: 0.36, currencyId: 23 }],
    }),
  },
});
ok(!reproResult.ok && reproResult.error === 'not_enough_steam' && reproResult.poolSize === 5,
  '用户的 10 行重复结果只有 5 件真实材料，必须报不足而不是精确命中');

// 用户的寒带收藏品场景：不要在枚举结束后再静默请求 12 × 5 个商品详情。
const boreal = new CollectionHunter({ intervalMs: 0 });
const borealMaterials = materialsInCollection('寒带收藏品', 'consumer');
const wearNames = ['崭新出厂', '略有磨损', '久经沙场', '破损不堪', '战痕累累'];
const wearNamesEn = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const listQueries = [];
const metadataCalls = [];
const listingQueries = [];
const progress = [];
let omitHash = false;
boreal.buff = {
  listGoods: async (query, options) => {
    listQueries.push({ name: query.search, options });
    return { ok: true, items: wearNames.map((ext, index) => ({
      id: `${query.search}:${index}`, name: `${query.search} (${ext})`,
      market_hash_name: omitHash && query.search === listQueries[0].name && index === 4
        ? null : `EN ${query.search} (${wearNamesEn[index]})`,
    })) };
  },
  goodsInfo: async (id, options) => {
    metadataCalls.push({ id, options });
    return { ok: true, info: { market_hash_name: `EN ${id.split(':')[0]} (Battle-Scarred)` } };
  },
};
const borealConfig = { collectionName: '寒带收藏品', materialGrade: 'consumer',
  targetWear: 0.6666666666, band: 0.15, steam: {
    listingsWithFloats: async name => {
      listingQueries.push(name);
      return { ok: true, listings: [], pagesFetched: 1 };
    },
  },
};
await boreal.huntFromSteam(borealConfig, { onProgress: message => progress.push(message) });
ok(borealMaterials.length === 12 && listQueries.length === 6,
  '寒带收藏品有 12 个皮肤，仅为覆盖目标磨损的 6 个查询商品名');
ok(metadataCalls.length === 0 && listingQueries.length === 6 &&
  listingQueries.every(name => name.endsWith('(Battle-Scarred)')),
  '列表已有英文名时不查任何商品详情，直接抓取 6 个战痕累累商品');
ok(listQueries.every(query => query.options.timeoutMs === 10000 && query.options.maxRetries === 0),
  '仅 Steam 的 BUFF 元数据请求使用 10 秒超时且不重试');
ok(progress.some(message => message.includes('0 个商品需要补查详情')) &&
  progress.some(message => message.includes('[1/6] 开始抓取')),
  '商品解析结束后明确显示进入 Steam 挂单抓取');

omitHash = true;
listQueries.length = 0;
listingQueries.length = 0;
progress.length = 0;
await boreal.huntFromSteam(borealConfig, { onProgress: message => progress.push(message) });
ok(metadataCalls.length === 1 && listingQueries.length === 6 &&
  metadataCalls[0].options.timeoutMs === 10000 && metadataCalls[0].options.maxRetries === 0,
  '只有一个列表英文名缺失时只补查一次详情');
ok(progress.some(message => message.includes('[1/1] 补查') && message.includes('10 秒')),
  '补查详情之前就显示当前商品和等待上限');

// 商品英文名的计数不能掩盖其它皮肤未解析到的情况。
metadataCalls.length = 0;
boreal.buff.goodsInfo = async () => ({ ok: false, kind: 'throttled' });
let steamSearches = 0;
borealConfig.steam.search = async () => { steamSearches++; return { ok: false, results: [] }; };
await boreal.huntFromSteam(borealConfig, { onProgress: message => progress.push(message) });
ok(steamSearches === 1 && progress.some(message => message.includes('未取得英文名，将尝试 Steam 搜索')),
  '详情查询失败后继续 Steam 搜索，已有其它商品名不会阻止补充');

const redirectHunter = new CollectionHunter({ intervalMs: 0 });
redirectHunter._materialsInCollection = () => [{ name: 'Redirect Skin', min: 0, max: 1 }];
redirectHunter.enumerateMaterials = async () => [{ db: { name: 'Redirect Skin' }, ok: true,
  variants: [{ goodsId: 1, name: 'Redirect Skin (Field-Tested)', marketHashName: 'Redirect Skin (Field-Tested)' }],
}];
const redirectProgress = [];
const redirectResult = await redirectHunter.huntFromSteam({ collectionName: 'X', materialGrade: 'consumer',
  targetWear: 0.2, steam: { listingsWithFloats: async () => ({ ok: false, error: '请求挂单页失败：重定向次数超过 5', listings: [] }) },
}, { onProgress: message => redirectProgress.push(message) });
ok(redirectResult.error === 'steam_redirect_loop' && !redirectProgress.some(message => message.includes('[2/')),
  '遇到重定向超限立即停止，不继续抓取后续商品');

process.exit(fail ? 1 : 0);
