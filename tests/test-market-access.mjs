import { marketAccess, normalizeMarket } from '../src/market/access.mjs';

const checks = [
  ['默认模式归一化为 buff', normalizeMarket() === 'buff'],
  ['Steam 模式保留', normalizeMarket('STEAM') === 'steam'],
  ['BUFF 模式缺 Cookie 仍拒绝', marketAccess('buff').code === 'no_cookie'],
  ['混合模式缺 Cookie 仍拒绝', marketAccess('both').code === 'no_cookie'],
  ['Steam 模式缺 BUFF Cookie 仍可搜索收藏品', marketAccess('steam').ok === true],
  ['Steam 模式有 BUFF Cookie 放行', marketAccess('steam', { hasBuff: true }).ok === true],
  ['分享配方已有 Steam 英文名时不要求 BUFF Cookie', marketAccess('steam', { hasSteamNames: true }).ok === true],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
