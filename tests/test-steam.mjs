import { SteamMarket } from '../src/market/steam.mjs';
import { proxyFromEnv, findLocalProxy } from '../src/util/net.mjs';

console.log('env 代理:', JSON.stringify(proxyFromEnv()));
const local = await findLocalProxy();
console.log('本地代理:', JSON.stringify(local));

const steam = new SteamMarket({ minIntervalMs: 1600, verbose: true });
console.log('\n=== 健康检查 ===');
console.log(JSON.stringify(await steam.health(), null, 1));

console.log('\n=== 配方材料在 Steam 上的价格（人民币）===');
const names = [
  'Dual Berettas | Angel Eyes (Field-Tested)',
  'M4A1-S | Liquidation (Field-Tested)',
  'MAC-10 | Cat Fight (Field-Tested)',
  'Nova | Blossom (Field-Tested)',
  'UMP-45 | Continuum (Field-Tested)',
];
for (const n of names) {
  const r = await steam.priceOverview(n);
  console.log(`  ${n}`);
  console.log(`     ${r.ok ? `最低 ${r.lowestText} | 中位 ${r.medianText} | 成交量 ${r.volume}` : `不可用: ${r.error} ${r.raw || ''}`}`);
}

console.log('\n=== 搜索（价格升序，久经沙场）===');
const s = await steam.search({ query: 'Cat Fight', count: 5, sortColumn: 'price', sortDir: 'asc' });
console.log('  ok=', s.ok, 'total=', s.total);
if (s.ok) for (const it of s.results) console.log(`     ${it.name}  ${it.priceText} 挂单${it.sellListings}`);
