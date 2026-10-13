import assert from 'node:assert/strict';
import { parseSteamLoginSecure, verifySteamSession } from '../src/auth/steam-login.mjs';
import { parseBuffCookies, prepareLoginInputs, verifyBuffSession } from '../src/auth/login-input.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

const id = '76561198000000000';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ typ: 'JWT', alg: 'EdDSA' })}.${b64({ sub: id, exp: 4102444800 })}.signature`;
const value = `${id}||${token}`;
assert.equal(parseSteamLoginSecure(value).steamId, id);
assert.equal(parseSteamLoginSecure(encodeURIComponent(value)).token, token);
assert.equal(parseSteamLoginSecure(`${id}||not-a-jwt`), null);
const expired = `${id}||${b64({ alg: 'EdDSA' })}.${b64({ sub: id, exp: 1 })}.sig`;
assert.throws(() => prepareLoginInputs({ steamLoginSecure: expired }), /已过期/);
const spacedHeader = Buffer.from('{ "typ": "JWT", "alg": "EdDSA" }').toString('base64url');
assert.ok(parseSteamLoginSecure(`${id}||${spacedHeader}.${b64({ sub: id, exp: 4102444800 })}.sig`));
for (const bad of ['%broken', 'steamLoginSecure=' + value, value + '; sessionid=abc',
  `${id}||${b64({ alg: 'none' })}.${b64({ sub: id, exp: 4102444800 })}.sig`,
  `${id}||${b64({ alg: 'EdDSA' })}.${b64({ sub: 'other', exp: 4102444800 })}.sig`]) {
  assert.equal(parseSteamLoginSecure(bad), null);
}

const prepared = prepareLoginInputs({ buff: 'Cookie: session=abc; csrf_token=def', steamLoginSecure: value });
assert.equal(prepared.buff[0].name, 'session');
assert.equal(prepared.steam[0].name, 'steamLoginSecure');
assert.equal(prepared.steam[0].value, encodeURIComponent(value));
assert.throws(() => prepareLoginInputs({ steam: value }), /steamLoginSecure 字段/);
assert.throws(() => parseBuffCookies('csrf_token=def'), /缺少 session/);
assert.throws(() => prepareLoginInputs({ buff: 'session=valid', steamLoginSecure: '%bad' }), /格式无效/);
assert.throws(() => parseBuffCookies('[{"name":"session","value":"abc","domain":"example.com"}]'), /其他站点/);
assert.equal(parseBuffCookies('[{"name":"session","value":"abc","domain":".buff.163.com"}]')[0].value, 'abc');
assert.equal(parseBuffCookies('[{"name":"session","value":"abc","domain":".163.com"}]')[0].value, 'abc');
assert.equal(parseBuffCookies('session=abc; mail=user@example.com:-1:1; csrf_token=a.b.c').length, 3);

const response = body => ({ status: 200, headers: {}, body });
const valid = await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}; sessionid=test`, {
  request: async () => response(`var g_steamID = "${id}"; <span class="actual_persona_name">Tester</span>`),
});
assert.equal(valid.ok, true);
const anonymous = await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}`, {
  request: async () => response('<html>public page</html>'),
});
assert.equal(anonymous.reason, 'unconfirmed');
const redirected = await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}`, {
  request: async () => ({ status: 302, headers: { location: '/login' }, body: '' }),
});
assert.equal(redirected.reason, 'not_logged_in');
let requests = 0;
const options = { allowInsecure: false, proxy: { protocol: 'http', host: '127.0.0.1', port: 7897 },
  request: async (url, opts) => {
    requests++;
    assert.equal(opts.allowInsecure, false);
    assert.equal(opts.proxy.port, 7897);
    assert.equal(opts.followRedirects, false);
    assert.ok(opts.signal && opts.timeoutMs <= 15000);
    return requests === 1
      ? { status: 302, headers: { location: `/profiles/${id}/tradeoffers/` } }
      : response(`g_steamID = '${id}';`);
  },
};
assert.equal((await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}`, options)).ok, true);
assert.equal(requests, 2);
for (const [reply, reason] of [
  [response('<title>Sign In</title>'), 'not_logged_in'],
  [response('g_steamID = "76561198000000001";'), 'account_mismatch'],
  [{ status: 302, headers: { location: 'https://example.com/' } }, 'redirect'],
  [{ status: 302, headers: { location: '/my/tradeoffers' } }, 'redirect'],
  [{ status: 429, headers: {} }, 'http_429'],
]) {
  let calls = 0;
  const checked = await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}`, {
    request: async () => { calls++; return reply; },
  });
  assert.equal(checked.reason, reason);
  assert.equal(calls, 1);
}
assert.equal((await verifySteamSession(`steamLoginSecure=${encodeURIComponent(value)}`, {
  request: async () => { throw new Error('secret-bearing network error'); },
})).reason, 'network');
assert.equal((await verifySteamSession(`steamLoginSecure=${expired}`, {
  request: () => { throw new Error('expired token must not make a request'); },
})).reason, 'expired');

const buff = await verifyBuffSession(prepared.buff, {
  client: { getJson: async () => ({ ok: true, status: 200, data: { code: 'OK' } }) },
});
assert.equal(buff.ok, true);
for (const [reply, reason] of [
  [{ ok: true, status: 200, data: { code: 'Login Required' } }, 'not_logged_in'],
  [{ ok: true, status: 200, data: { code: 'System Error' } }, 'throttled'],
  [{ ok: false, status: 429 }, 'throttled'],
  [{ ok: true, status: 200, data: null }, 'unconfirmed'],
]) {
  const checked = await verifyBuffSession(prepared.buff, { client: {
    getJson: async (_url, headers, opts) => {
      assert.equal(headers.cookie, 'session=abc; csrf_token=def');
      assert.equal(opts.maxRetries, 0);
      assert.equal(opts.timeoutMs, 15000);
      return reply;
    },
  } });
  assert.equal(checked.reason, reason);
}
// 执行真实页面保存处理器，验证请求字段与验证反馈；不写任何真实凭证文件。
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function setMsg('), html.indexOf('async function refreshState()'));
const elements = Object.fromEntries(['buffCookie', 'steamLoginSecure', 'saveCookies', 'saveMsg', 'verifyBox', 'proxy', 'insecure']
  .map(key => [key, { value: '', checked: false, style: {} }]));
elements.buffCookie.value = 'session=synthetic';
elements.steamLoginSecure.value = value;
elements.proxy.value = 'http://127.0.0.1:7897';
let submitted;
let result = { ok: true, buff: 1, steam: 2,
  buffVerify: { ok: true, message: 'BUFF valid' },
  steamVerify: { ok: false, reason: 'network', message: 'network failed' },
};
const page = vm.createContext({
  $: key => elements[key], esc: text => String(text), refreshState: () => {},
  fetch: async (_url, opts) => { submitted = JSON.parse(opts.body); return { json: async () => result }; },
});
vm.runInContext(source, page);
await elements.saveCookies.onclick();
assert.equal(submitted.steamLoginSecure, value);
assert.ok(!('steam' in submitted));
assert.equal(submitted.proxy, elements.proxy.value);
assert.equal(submitted.insecure, false);
assert.match(elements.saveMsg.textContent, /已保存.*请查看/);
assert.match(elements.verifyBox.innerHTML, /msg good.*BUFF/);
assert.match(elements.verifyBox.innerHTML, /msg warn.*Steam/);
assert.equal(elements.saveCookies.disabled, false);
assert.equal(elements.steamLoginSecure.value, '');
elements.steamLoginSecure.value = value;
result = { ok: false, error: '格式无效' };
await elements.saveCookies.onclick();
assert.match(elements.saveMsg.textContent, /保存失败/);
assert.equal(elements.steamLoginSecure.value, value);
assert.equal(elements.saveCookies.disabled, false);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // 整个页面脚本语法检查
console.log('login validation tests passed');
