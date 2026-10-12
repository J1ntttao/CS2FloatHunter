import {
  parseSteamLoginSecure, looksLikeJwt, verifySteamSession, verifyCsfloatToken, csfloatDecode, saveCsfloatCreds, loadCsfloatCreds,
} from '../src/auth/steam-login.mjs';
import { decodeInspectLink } from '../src/market/inspect.mjs';

console.log('=== 1. steamLoginSecure 解析 ===');
for (const v of [
  '76561198012345678%7C%7Cabcd1234ef567890abcd1234ef567890abcd1234',
  '76561198012345678||abcd1234ef567890abcd1234ef567890abcd1234',
  'garbage',
  '',
]) {
  const p = parseSteamLoginSecure(v);
  console.log(`  ${JSON.stringify(v).slice(0, 50).padEnd(52)} -> ${p ? `steamId=${p.steamId} tokenLen=${p.token.length}` : 'null'}`);
}

console.log('\n=== 2. JWT 识别 ===');
for (const v of ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'not-a-jwt', '']) {
  console.log(`  ${JSON.stringify(v).slice(0, 40).padEnd(42)} -> ${looksLikeJwt(v)}`);
}

console.log('\n=== 3. 空凭证验证（应给出明确原因，不崩）===');
console.log('  ', JSON.stringify(await verifySteamSession(null)));
console.log('  ', JSON.stringify(await verifySteamSession('steamLoginSecure=badvalue')));

console.log('\n=== 4. 假 CSFloat 令牌（应被识别为格式不对）===');
console.log('  ', JSON.stringify(await verifyCsfloatToken('abc')));

console.log('\n=== 5. 真实网络验证（用格式正确但无效的令牌，看错误是否可读）===');
const r1 = await verifySteamSession('sessionid=abc; steamLoginSecure=76561198012345678%7C%7Cdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
console.log('  Steam:', JSON.stringify(r1));

console.log('\n=== 6. CSFloat 解码接口（官方已废弃，预期失败）===');
const hex = '08d19f84d8031007189a023d0000803e';
const link = `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20M2906459769049600931A18971892678D${hex}`;
console.log('  本地解码:', JSON.stringify(decodeInspectLink(link).floatvalue));
console.log('  CSFloat :', JSON.stringify(await csfloatDecode(link)).slice(0, 200));

console.log('\n=== 7. 保存/读取凭证 ===');
saveCsfloatCreds({ steamCookie: 'test=1', note: 'selftest' });
console.log('  ', JSON.stringify(loadCsfloatCreds()));
