#!/usr/bin/env node
/**
 * 登录态与连通性自检。先跑这个，再跑抓取。
 *
 * 用法: node scripts/doctor.mjs [--site buff|all]
 */

import path from 'node:path';
import { loadCookiesDetailed, hasCookies, defaultHeaders, SITES, DATA_DIR } from '../src/auth/session.mjs';
import { HttpClient } from '../src/util/http.mjs';

const args = process.argv.slice(2);
const siteArg = args.includes('--site') ? args[args.indexOf('--site') + 1] : 'all';
const targets = siteArg === 'all' ? ['buff'] : [siteArg];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function line(c = '─', n = 66) { console.log(c.repeat(n)); }

console.log('=== CS2 磨损猎人 · 环境自检 ===\n');
console.log(`凭证目录: ${DATA_DIR}`);
console.log(`Node     : ${process.version}\n`);

for (const site of targets) {
  const cfg = SITES[site];
  line();
  console.log(`【${cfg.label}】`);
  const { cookies, sources } = loadCookiesDetailed(site);

  if (!cookies.length) {
    console.log('  cookie : 无 ✗');
    console.log(`  修复   : 运行  powershell -File scripts\\set-cookies.ps1 -Site ${site}`);
    continue;
  }
  console.log(`  cookie : ${cookies.length} 条 ✓`);
  for (const s of sources) console.log(`           来源 ${s.label} (${s.count}) ${s.file}`);
  console.log(`           字段 ${cookies.map(c => c.name).join(', ')}`);

  // 关键登录 cookie 是否在
  const names = new Set(cookies.map(c => c.name));
  const critical = site === 'buff' ? ['session'] : [];
  const missing = critical.filter(n => !names.has(n));
  if (missing.length) console.log(`  ! 缺少常见登录字段: ${missing.join(', ')}（可能仍可用，先测）`);

  const http = new HttpClient({ minIntervalMs: 1500, maxRetries: 3, label: site, verbose: true });

  if (site === 'buff') {
    // 1) 登录态：登录后 /api/market/goods 不再返回 Login Required
    const r1 = await http.getJson('https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=5',
      defaultHeaders('buff', { 'x-requested-with': 'XMLHttpRequest' }));
    console.log(`\n  [登录态探测] HTTP ${r1.status} code=${r1.data?.code ?? '-'} error=${r1.data?.error ?? '-'}`);
    const loggedIn = r1.data && r1.data.code === 'OK';
    console.log(`  => ${loggedIn ? '已登录 ✓' : '未登录或受限 ✗'}`);
    if (loggedIn) {
      const items = r1.data.data?.items || [];
      console.log(`     市场列表可用，首批 ${items.length} 件`);
      if (items[0]) console.log(`     样例: ${items[0].name}  售价 ${items[0].sell_min_price}`);
    }

    // 2) 单品挂单 + 每笔磨损
    const r2 = await http.getJson('https://buff.163.com/api/market/goods/sell_order?game=csgo&goods_id=33960&page_num=1&sort_by=default',
      defaultHeaders('buff', { 'x-requested-with': 'XMLHttpRequest' }));
    const items = r2.data?.data?.items || [];
    console.log(`\n  [单品挂单探测] HTTP ${r2.status} code=${r2.data?.code ?? '-'} 挂单数=${items.length}`);
    if (items.length) {
      const w = items.map(x => x.asset_info?.paintwear).filter(Boolean);
      console.log(`     每笔磨损字段 asset_info.paintwear = ${JSON.stringify(items[0].asset_info?.paintwear)}`);
      console.log(`     本页磨损范围 ${Math.min(...w.map(Number)).toFixed(9)} ~ ${Math.max(...w.map(Number)).toFixed(9)}`);
      console.log(`     => 可按磨损精确筛选 ✓`);
    } else {
      console.log(`     返回: ${JSON.stringify(r2.data).slice(0, 200)}`);
    }
  }
}

line();
console.log('\n下一步：');
console.log('  1) 若上面显示“未登录”，按提示运行 set-cookies.ps1 录入 cookie');
console.log('  2) 然后运行  node src/cli.mjs --target 0.1234567');
