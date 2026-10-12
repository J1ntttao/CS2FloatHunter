/**
 * 「仅 Steam」求解路径的离线测试：用假的 BUFF / Steam 客户端，验证
 *   - 只用包含目标磨损的那一个区间档（不会把相邻档混进来）
 *   - 每把材料都带皮肤名、Steam 购买链接、来自 Steam 挂单的磨损与价格
 *   - 产物磨损按该区间正确计算
 */
import { CollectionHunter } from '../src/market/hunter.mjs';
import { outputWear } from '../src/tradeup/float.mjs';

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

// 两个皮肤，各有三个磨损档商品；只有 [0.15,0.35] 档包含目标 0.2004
const SKINS = ['AUG | 钢铁哨兵', '新星 | 夜雨月台'];
const RANGES = { FN: [0, 0.07], MW: [0.07, 0.15], FT: [0.15, 0.35] };
const goods = new Map();
let gid = 1;
for (const s of SKINS) for (const [ext, r] of Object.entries(RANGES)) {
  goods.set(gid, { name: `${s} (${ext})`, range: r, mhn: `EN ${s} (${ext})` });
  gid++;
}

const hunter = new CollectionHunter({ intervalMs: 0 });
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
      listings.push({ listingId: String(++seq), floatvalue: f, price: 0.3 + i / 100, priceText: `¥${(0.3 + i / 100).toFixed(2)}`, currencyId: 23, paintseed: i });
    }
    // 一笔美元挂单，必须被排除
    listings.push({ listingId: String(++seq), floatvalue: 0.2004, price: 9.99, currencyId: 1 });
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
ok(r.skippedRanges.length === 2, '跳过另外两个档位');

const rec = r.recipes[0];
ok(rec && rec.materials.length === 10, '配方有 10 把材料');
for (const m of rec.materials) {
  if (!m.name || !m.name.includes('|')) { ok(false, `材料缺皮肤名 ${JSON.stringify(m)}`); break; }
  if (!m.url || !m.url.includes(`?listing=${m.listingId}`) || !m.url.includes(encodeURIComponent(m.marketHashName))) {
    ok(false, `购买链接不对 ${m.url}`); break;
  }
  if (JSON.stringify(m.matRange) !== '[0.15,0.35]') { ok(false, `混入了别的档位 ${m.matRange}`); break; }
  if (m.price === 9.99) { ok(false, '混入了非人民币挂单'); break; }
}
ok(rec.materials.every(m => m.name && m.url), '每把材料都有皮肤名和 Steam 购买链接');
const cost = rec.materials.reduce((a, m) => a + m.price, 0);
ok(Math.abs(cost - rec.cost) < 1e-9, `总价 = 各笔 Steam 价格之和（¥${rec.cost.toFixed(2)}）`);
const recomputed = outputWear(rec.materials.map(m => ({ wear: m.paintwear, matMin: 0.15, matMax: 0.35 })), 0.15, 0.35);
ok(recomputed === rec.outputWear, `产物磨损可复算 ${rec.outputWear}`);
ok(Math.abs(rec.outputWear - target) < 1e-3, `产物磨损接近目标（误差 ${Math.abs(rec.outputWear - target).toExponential(2)}）`);

process.exit(fail ? 1 : 0);
