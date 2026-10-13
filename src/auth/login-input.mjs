import { randomBytes } from 'node:crypto';
import { parseSteamLoginSecure } from './steam-login.mjs';
import { defaultHeaders } from './session.mjs';
import { HttpClient } from '../util/http.mjs';

/** BUFF 支持完整 Cookie 请求头、逐行 name=value 和 Cookie-Editor JSON。 */
export function parseBuffCookies(raw) {
  const text = String(raw || '').trim().replace(/^cookie\s*:\s*/i, '');
  if (!text) return [];
  let entries;
  if (/^[\[{]/.test(text)) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('BUFF Cookie JSON 格式无效'); }
    entries = Array.isArray(data) ? data : data.cookies;
    if (!Array.isArray(entries)) throw new Error('BUFF Cookie JSON 应为数组或包含 cookies 数组');
  } else {
    entries = text.split(/[;\r\n]+/).filter(part => part.trim()).map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) throw new Error('BUFF 请粘贴完整 Cookie 请求头，格式为 session=...; csrf_token=...');
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
  }
  const cookies = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('BUFF Cookie 字段格式无效');
    const name = String(entry.name ?? entry.Name ?? '');
    const value = String(entry.value ?? entry.Value ?? '');
    const domain = String(entry.domain || entry.Domain || '.buff.163.com').replace(/^\./, '').toLowerCase();
    if (domain !== '163.com' && domain !== 'buff.163.com' && !domain.endsWith('.buff.163.com')) throw new Error('BUFF Cookie JSON 中包含其他站点的字段');
    if (!/^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(name) || /[;\x00-\x20\x7f]/.test(value)) {
      throw new Error('BUFF Cookie 字段格式无效，请重新复制 Cookie 请求头');
    }
    cookies.set(name, { domain: '.buff.163.com', name, value, path: '/', secure: true, httpOnly: false });
  }
  const result = [...cookies.values()];
  if (!cookies.get('session')?.value) throw new Error('BUFF Cookie 缺少 session，请复制 buff.163.com 已登录请求的完整 Cookie 请求头');
  return result;
}

/** 先检查全部输入，避免另一项格式错误时部分覆盖现有登录态。 */
export function prepareLoginInputs(body) {
  if (body.steam != null && String(body.steam).trim()) throw new Error('Steam 请使用 steamLoginSecure 字段，只填写它的值');
  const buff = String(body.buff || '').trim();
  const steam = String(body.steamLoginSecure || '').trim();
  if (!buff && !steam && !String(body.csfloatToken || '').trim()) throw new Error('请填写 BUFF Cookie 或 steamLoginSecure 的值');
  const result = {};
  if (buff) result.buff = parseBuffCookies(buff);
  if (steam) {
    const parsed = parseSteamLoginSecure(steam);
    if (!parsed) throw new Error('steamLoginSecure 格式无效。只粘贴值：SteamID64||JWT 或 SteamID64%7C%7CJWT，不要包含 steamLoginSecure= 或其他 Cookie 字段');
    if (parsed.expiresAt <= Date.now() / 1000) throw new Error('steamLoginSecure 中的 JWT 已过期，请登录 Steam 后重新复制');
    result.steam = [
      { domain: 'steamcommunity.com', name: 'steamLoginSecure', value: parsed.cookieValue, path: '/', secure: true, httpOnly: true },
      { domain: 'steamcommunity.com', name: 'sessionid', value: randomBytes(12).toString('hex'), path: '/', secure: true, httpOnly: false },
    ];
  }
  return result;
}

export async function verifyBuffSession(cookies, { client = new HttpClient({ minIntervalMs: 0, maxRetries: 0, verbose: false }) } = {}) {
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  try {
    const r = await client.getJson('https://buff.163.com/api/market/goods?game=csgo&page_num=1&page_size=1',
      defaultHeaders('buff', { cookie, 'x-requested-with': 'XMLHttpRequest' }), { timeoutMs: 15000, maxRetries: 0 });
    if (r.ok && r.data?.code === 'OK') return { ok: true, message: 'BUFF 登录态有效，市场接口可用' };
    if (r.data?.code === 'Login Required') return { ok: false, reason: 'not_logged_in', message: 'BUFF 要求重新登录，登录态可能已失效或受限，请重新复制 Cookie 后重试' };
    if (r.status === 429 || r.data?.code === 'System Error') return { ok: false, reason: 'throttled', message: 'BUFF 限流，暂时无法确认登录态，请稍后验证' };
    return { ok: false, reason: 'unconfirmed', message: r.status ? `BUFF 返回 HTTP ${r.status}，未确认登录态` : 'BUFF 在线验证失败，请检查网络后重试' };
  } catch {
    return { ok: false, reason: 'network', message: 'BUFF 在线验证失败，请检查网络后重试' };
  }
}
