import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { BuffCatalog, parseBuffCollections } from '../src/market/catalog.mjs';
import { CollectionHunter } from '../src/market/hunter.mjs';
import { outputWear, f32 } from '../src/tradeup/float.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buff-catalog-test-'));
const html = '<div id="search-itemset"><ul><li><h6>武器箱收藏品</h6><p value="set_test">测试 &amp; 箱子</p></li></ul></div>';
assert.deepEqual(parseBuffCollections(html), [{ id: 'set_test', name: '测试 & 箱子', category: '武器箱收藏品' }]);
assert.deepEqual(parseBuffCollections('<html>login</html>'), []);
const skins = [
  { id: 1, name: '材料一', en: 'Input One', grade: 'rare_weapon', range: [0, 1] },
  { id: 2, name: '材料二', en: 'Input Two', grade: 'rare_weapon', range: [0.1, 0.9] },
  { id: 3, name: '产物一', en: 'Output One', grade: 'mythical_weapon', range: [0, 0.8] },
  { id: 4, name: '产物二', en: 'Output Two', grade: 'mythical_weapon', range: [0, 0.8] },
  { id: 5, name: '产物三', en: 'Output Three', grade: 'mythical_weapon', range: [0.06, 0.8] },
];
let listingCalls = 0, detailCalls = 0, htmlCalls = 0, failDetails = false, missingLastPage = false;
const mockMarket = {
  _headers: () => ({}),
  http: { async request() { htmlCalls++; return { ok: true, raw: html }; } },
  async listGoods({ pageNum }) {
    listingCalls++;
    const items = skins.map(s => ({ id: s.id * 10, name: `${s.name} (久经沙场)`,
      market_hash_name: `${s.en} (Field-Tested)`, goods_info: { info: { tags: { rarity: { internal_name: s.grade } } } } }));
    items.push({ ...items[0], id: 777, name: '纪念品 | 材料一 (久经沙场)', market_hash_name: 'Souvenir Input One (Field-Tested)' });
    items.push({ ...items[0], id: 778, market_hash_name: 'StatTrak™ Input One (Field-Tested)' });
    // deliberately return all grades regardless of the query, as BUFF does.
    return { ok: true, total: items.length, totalPage: 2,
      items: pageNum === 1 ? items.slice(0, 3) : missingLastPage ? [] : items.slice(3) };
  },
  async goodsInfo(id) {
    detailCalls++;
    if (failDetails) return { ok: false, kind: 'login_required' };
    const skin = skins.find(s => s.id === Math.floor(Number(id) / 10));
    assert.ok(skin);
    const tier = Number(id) % 10;
    return { ok: true, info: { name: skin.name, market_hash_name: `${skin.en} (${tier === 1 ? 'Factory New' : tier === 2 ? 'Battle-Scarred' : 'Field-Tested'})`,
      paintwear_range: tier === 1 ? [skin.range[0], 0.15] : tier === 2 ? [0.45, skin.range[1]] : [0.15, 0.38],
      goods_info: { info: { tags: { rarity: { internal_name: skin.grade } } } },
      relative_goods: [{ tag: 'Factory New', goods_id: skin.id * 10 + 1, goods_name: `${skin.name} (崭新出厂)`, is_change: false },
        { tag: 'Battle-Scarred', goods_id: skin.id * 10 + 2, goods_name: `${skin.name} (战痕累累)`, is_change: false }] } };
  },
};
let plan;
try {
  const catalog = new BuffCatalog({ directory, marketFactory: () => mockMarket });
  plan = await catalog.plan('set_test', 'restricted');
  assert.equal(listingCalls, 2);
  assert.equal(plan.materialSpecs.length, 2);
  assert.equal(plan.outputSpecs.length, 3);
  assert.equal(plan.collectionSpecs[0].count, 10);
  assert.equal(plan.grade, 'milspec');
  assert.deepEqual(plan.materialSpecs.map(m => m.range), [[0, 1], [0.1, 0.9]]);
  assert.deepEqual(plan.outputSpecs.find(m => m.name === '产物一').range, [0, 0.8]);
  assert.deepEqual(plan.outputSpecs.find(m => m.name === '产物二').range, [0, 0.8]);
  assert.deepEqual(plan.outputSpecs.find(m => m.name === '产物三').range, [0.06, 0.8]);
  assert.ok(plan.outputSpecs.every(o => o.probability === 1 / 3));
  assert.equal(detailCalls, 15); // FT + first and last associated exterior per skin.
  const before = { listingCalls, detailCalls, htmlCalls };
  await new BuffCatalog({ directory, marketFactory: () => mockMarket }).plan('set_test', 'restricted');
  assert.deepEqual({ listingCalls, detailCalls, htmlCalls }, before);
  await assert.rejects(() => catalog.plan('invalid', 'restricted'), /收藏品选择无效/);
  await assert.rejects(() => catalog.plan('set_test', 'covert'), /产物等级/);
  failDetails = true;
  await assert.rejects(() => catalog.plan('set_test', 'restricted', false, { refresh: true }), /BUFF 要求登录/);
  failDetails = false;
  missingLastPage = true;
  await assert.rejects(() => catalog.collection('set_test', false, { refresh: true }), /分页不完整/);
  missingLastPage = false;
  console.log('✓ BUFF 目录、分页、等级与品质过滤、关联外观完整区间、等概率、持久缓存和错误提示');

  // Direct plans must use the BUFF materials, even when local material DB has no such collection.
  const hunter = new CollectionHunter({ intervalMs: 0 });
  const steam = { async listingsWithFloats(name) {
    const material = plan.materialSpecs.find(s => name.startsWith(s.nameEn + ' ('));
    assert.ok(material);
    const wear = material.range[0] + 0.25 * (material.range[1] - material.range[0]);
    return { ok: true, listings: Array.from({ length: 10 }, (_, i) => ({ listingId: `${material.id}-${i}`,
      assetId: `${material.id}-${i}`, marketHashName: name, floatvalue: f32(wear), price: 1, currencyId: 23 })) };
  } };
  const result = await hunter.huntFromSteam({ recipePlan: plan, targetWear: 0.2, statTrak: false,
    exteriors: ['ft'], steam, steamRandomPages: 1 }, { timeBudgetMs: 500 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.recipes[0].materials.length, 10);
  const calculated = result.recipes[0];
  assert.equal(calculated.outputs.find(o=>o.name==='产物一').wear, calculated.outputs.find(o=>o.name==='产物二').wear);
  assert.notEqual(calculated.outputs.find(o=>o.name==='产物一').wear, calculated.outputs.find(o=>o.name==='产物三').wear);
  assert.equal(calculated.outputs[0].wear, outputWear(calculated.materials.map(m => ({ wear: m.paintwear,
    matMin: m.matRange[0], matMax: m.matRange[1] })), 0, 0.8));
  console.log('✓ BUFF 新收藏品不依赖本地材料库或网址即可搜索十把材料，相同完整区间产物最终磨损一致');

  const directBuff = {
    async listGoods() { throw new Error('已确认商品不应重新搜索名称'); },
    async sellOrders({ goodsId: id }) {
      const material = plan.materialSpecs.find(m => m.variants.some(v => v.id === id));
      assert.ok(material);
      return { ok: true, total: 10, totalPage: 1, listings: Array.from({ length: 10 }, (_, i) => ({
        orderId: `${id}-${i}`, assetId: `${id}-${i}`, goodsId: id, price: 1,
        marketHashName: `${material.nameEn} (Field-Tested)`, name: `${material.name} (久经沙场)`,
        paintwear: material.range[0] + 0.25 * (material.range[1] - material.range[0]) })) };
    },
  };
  hunter.buff = directBuff;
  const buffResult = await hunter.hunt({ recipePlan: plan, targetWear: 0.2, statTrak: false,
    exteriors: ['ft'], steamRandomPages: 1 }, { timeBudgetMs: 500 });
  assert.equal(buffResult.ok, true, buffResult.message);
  assert.equal(buffResult.recipes[0].materials.length, 10);
  console.log('✓ BUFF 挂单搜索复用已确认商品，固定单收藏品十把并按完整区间计算');

  // Run actual page functions, including direct search parameter construction.
  const source = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries(['sourceMode','collectionSelect','outputGrade','catalogNote','catalogFields','linkFields',
    'refreshCatalog','sameWearNote','targetOutput','stattrak','link','qualityNote','go','stop','next','continue','eta',
    'randomPages','wear','interval','insecure','proxy',...['fn','mw','ft','ww','bs'].map(k=>'exterior_'+k)].map(id => [id,
    { value: '', checked: false, style: {}, addEventListener(type, handler) { this[type] = handler; } }]));
  elements.sourceMode.value = 'catalog'; elements.wear.value = '0.2'; elements.randomPages.value = '20'; elements.exterior_ft.checked = true;
  const queries = [], searches = [], messages = [];
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, AbortController, URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, crypto: { randomUUID: () => 'catalog-ui' },
    fetch: async url => { queries.push(url); const pathname = url.split('?')[0];
      return { json: async () => pathname.endsWith('/collections') ? { ok: true, items: parseBuffCollections(html) }
        : pathname.endsWith('/collection') ? { ok: true, grades: [{ key: 'restricted', label: '受限级' }] }
          : { ok: true, planId: 'test-plan', outputs: plan.outputSpecs, collection: plan.collection, materialGrade: '军规级', materialCount: 2 } }; },
    statusLine: message => messages.push(message), reset() {}, renderLocated() {}, renderResult() {},
    EventSource: class { constructor(url) { searches.push(url); } addEventListener() {} close() {} },
  });
  const between = (a,b) => source.slice(source.indexOf(a),source.indexOf(b));
  vm.runInContext(between('const $ =','function statusLine') + between('let qualitySid',"let MARKET = 'buff';") +
    between("let MARKET = 'buff';","$('stop').onclick = stopSearch;") + between("$('go').onclick =",'function openBuyPanel'), context);
  await vm.runInContext('loadCatalogDirectory()', context);
  elements.collectionSelect.value = 'set_test';
  await vm.runInContext('loadCatalogCollection()', context);
  assert.equal(elements.targetOutput.disabled, false);
  assert.match(elements.sameWearNote.textContent, /产物二/);
  assert.doesNotMatch(elements.sameWearNote.textContent, /产物三/);
  elements.go.onclick();
  const params = new URL(searches.at(-1), 'http://localhost').searchParams;
  assert.equal(params.get('plan_id'), 'test-plan');
  assert.equal(params.get('stattrak'), '0');
  assert.equal(params.has('url'), false);
  assert.ok(queries.every(url=>url.startsWith('/api/catalog/')));
  console.log('✓ 实际页面下拉加载、相同磨损标注及新搜索参数不携带网址、不调用 CS2UP');

  // Actual HTTP/SSE routes, with offline market data and solver result.
  const listener = http.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { BuffCatalog } from ${JSON.stringify(new URL('../src/market/catalog.mjs', import.meta.url).href)};
    import { CollectionHunter } from ${JSON.stringify(new URL('../src/market/hunter.mjs', import.meta.url).href)};
    import { SteamMarket } from ${JSON.stringify(new URL('../src/market/steam.mjs', import.meta.url).href)};
    const plan=${JSON.stringify(plan)}, result=${JSON.stringify(result)};
    BuffCatalog.prototype.collections = async()=>({items:[{id:'set_test',name:'测试收藏品',category:'收藏品'}]});
    BuffCatalog.prototype.collection = async()=>({collection:{id:'set_test'},grades:[{key:'restricted'}]});
    BuffCatalog.prototype.plan = async()=>plan;
    SteamMarket.prototype.health = async()=>({ok:true});
    CollectionHunter.prototype.huntFromSteam = async cfg=>{ if(cfg.recipePlan.materialSource!=='buff'||cfg.recipePlan.totalCount!==10)throw Error('Wrong plan'); return result; };
    globalThis.fetch=async()=>{throw Error('No external/CS2UP calls');};
    await import(${JSON.stringify(new URL('../src/web/server.mjs', import.meta.url).href)});
  `], { env: { ...process.env, CS2_WEB_PORT: String(port), CS2_SEARCH_RESULTS_DIR: path.join(directory, 'results') }, stdio: ['ignore','pipe','pipe'] });
  let log = ''; child.stdout.on('data', data=>log+=data); child.stderr.on('data',data=>log+=data);
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i=0;i<100;i++) { try { if ((await fetch(base+'/api/health')).ok) break; } catch {} await new Promise(resolve=>setTimeout(resolve,20)); }
    const metadata=await (await fetch(base+'/api/catalog/plan?collection=set_test&grade=restricted')).json();
    assert.equal(metadata.ok,true,log);
    const text=await (await fetch(base+`/api/hunt?plan_id=${metadata.planId}&wear=0.2&market=steam&stattrak=0`)).text();
    assert.ok(!text.includes('event: error'),text);
    const saved=JSON.parse(text.match(/event: result\ndata: ([^\n]+)/)[1]);
    assert.equal(saved.selection.source,'buff'); assert.equal(saved.collectionSpecs[0].count,10);
    const record=await (await fetch(base+`/api/search-results/${saved.saved.id}`)).json();
    assert.equal(record.request.selection.collectionId,'set_test');
    const invalid=await (await fetch(base+'/api/hunt?plan_id=invalid&wear=0.2&market=steam')).text();
    assert.match(invalid,/catalog_plan_expired/);
    const wrongQuality=await (await fetch(base+`/api/hunt?plan_id=${metadata.planId}&wear=0.2&market=steam&stattrak=1`)).text();
    assert.match(wrongQuality,/catalog_quality_changed/);
    console.log('✓ 真实 API/SSE 无网址搜索、固定十把、结果保存及失效选择/品质变化验证');
  } finally { child.kill(); await once(child,'exit'); }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
