/**
 * Steam / CSFloat 登录态处理与验证。
 *
 * 背景（来自 CSGOFloat extension 官方 src/README.md）：
 *   扩展「几乎全部逻辑运行在 Steam 页面的 JS 上下文里」，这样能直接读到页面全局变量
 *   （也就是挂单数据 g_rgListingInfo），然后把检视链接通过后台脚本发给
 *   `https://api.csfloat.com/?url=steam://...` 换回 float。
 *   ⇒ 所以它必须有 Steam 登录态，登录态就是它的前提。
 *
 * 本模块负责：
 *   1. 解析用户粘贴的各种 Steam 凭证并存盘
 *   2. **真的去验证一下**这些凭证有没有生效（而不是存了就完事）
 *   3. 给出明确的失败原因
 *
 * 支持的凭证形式：
 *   - steamLoginSecure 的值（SteamID64||JWT，分隔符也可以是 %7C%7C）
 *   - CSFloat 的 JWT（形如 eyJ...），用于 api.csfloat.com
 */

import fs from 'node:fs';
import path from 'node:path';
import { httpsGet } from '../util/net.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const CRED_FILE = path.join(DATA_DIR, 'csfloat-credentials.json');

/** 只解析 steamLoginSecure 的值；JWT 解码只检查结构，不代表签名验证成功。 */
export function parseSteamLoginSecure(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const dec = decodeURIComponent(raw);
    const m = dec.match(/^(7656\d{13})\|\|([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if (!m) return null;
    const [header, payload] = m[2].split('.').slice(0, 2)
      .map(part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    if (!header || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') return null;
    if (payload?.sub !== m[1] || !Number.isFinite(payload.exp) || payload.exp <= 0) return null;
    return { steamId: m[1], token: m[2], raw, cookieValue: encodeURIComponent(dec), expiresAt: payload.exp };
  } catch { return null; }
}

/** 看起来像不像 CSFloat 的 JWT */
export function looksLikeJwt(value) {
  const s = String(value || '').trim();
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

/** 读已保存的 CSFloat / Steam 凭证 */
export function loadCsfloatCreds() {
  try {
    if (!fs.existsSync(CRED_FILE)) return {};
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  } catch { return {}; }
}

/** 存凭证 */
export function saveCsfloatCreds(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cur = loadCsfloatCreds();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CRED_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * 验证 Steam 登录态是否真的有效。
 *
 * 判定方式：请求 /my/tradeoffers 或 /profiles/<steamid> —— 带有效登录态时
 * 会返回已登录页面；未登录会被重定向到登录页。
 * 只跟随 Steam 社区站内跳转，并检查登录账号标识；HTTP 200 本身不代表登录成功。
 */
export async function verifySteamSession(cookieHeader, { allowInsecure = true, proxy = null, request = httpsGet } = {}) {
  if (!cookieHeader) return { ok: false, reason: 'no_cookie', message: '没有提供 steamLoginSecure 的值' };

  const hasLoginSecure = /steamLoginSecure=/.test(cookieHeader);
  const hasSessionId = /sessionid=/.test(cookieHeader);
  const parsed = (() => {
    const m = cookieHeader.match(/(?:^|;\s*)steamLoginSecure=([^;]+)/);
    return m ? parseSteamLoginSecure(m[1]) : null;
  })();

  const out = {
    hasLoginSecure, hasSessionId,
    steamId: parsed ? parsed.steamId : null,
    tokenLooksValid: !!parsed,
  };

  if (!parsed) return { ...out, ok: false, reason: 'invalid_format', message: 'steamLoginSecure 格式无效，应为 SteamID64||JWT 或 SteamID64%7C%7CJWT' };
  if (parsed.expiresAt <= Date.now() / 1000) {
    return { ...out, ok: false, reason: 'expired', message: 'steamLoginSecure 中的 JWT 已过期，请登录 Steam 后重新复制' };
  }
  let url = 'https://steamcommunity.com/my/tradeoffers';
  const visited = new Set();
  const deadline = Date.now() + 15000;
  const signal = AbortSignal.timeout(15000);
  try {
    for (let step = 0; step < 5; step++) {
      if (visited.has(url)) return { ...out, ok: false, reason: 'redirect', message: 'Steam 验证遇到重定向循环，无法确认登录态' };
      visited.add(url);
      const r = await request(url, {
        allowInsecure, proxy,
        headers: { accept: 'text/html', cookie: cookieHeader, referer: 'https://steamcommunity.com/' },
        followRedirects: false, timeoutMs: Math.max(1, deadline - Date.now()), signal,
      });
      out.httpStatus = r.status;
      const location = r.headers?.location;
      if (r.status >= 300 && r.status < 400 && /\/login|\/openid/i.test(location || '')) {
        return { ...out, ok: false, reason: 'not_logged_in', message: 'Steam 把请求重定向到了登录页，说明登录态无效或已过期' };
      }
      if (r.status >= 300 && r.status < 400 && location) {
        const next = new URL(location, url);
        if (next.origin !== 'https://steamcommunity.com' || next.username || next.password) {
          return { ...out, ok: false, reason: 'redirect', message: 'Steam 验证跳转到了其他站点，无法确认登录态' };
        }
        url = next.href;
        continue;
      }
      if (r.status === 200) {
        // 200 也可能是登录页（Steam 有时直接渲染登录页），再查内容特征
        const body = r.body || '';
        const isLoginPage = /<title>[^<]*Sign In|登录 Steam|action="\/login\/doLogin"/i.test(body);
        if (isLoginPage) {
          return { ...out, ok: false, reason: 'not_logged_in', message: '返回的是登录页内容，登录态无效' };
        }
        // 找个人标识
        const idMatch = body.match(/\bg_steamID\s*=\s*['"](\d+)['"]/);
        if (idMatch && idMatch[1] !== parsed.steamId) {
          return { ...out, ok: false, reason: 'account_mismatch', message: 'Steam 返回的账号与 steamLoginSecure 中的 SteamID 不一致' };
        }
        const nameMatch = body.match(/<span\b[^>]*class=['"][^'"]*\bactual_persona_name\b[^'"]*['"][^>]*>([^<]+)<\/span>/i);
        if (!idMatch && !nameMatch) {
          return { ...out, ok: false, reason: 'unconfirmed', message: 'Steam 页面没有登录账号标识，无法确认登录态' };
        }
        out.personaName = nameMatch ? nameMatch[1].trim() : null;
        return { ...out, ok: true, message: `Steam 登录态有效${out.personaName ? `（账号：${out.personaName}）` : ''}` };
      }
      return { ...out, ok: false, reason: `http_${r.status}`, message: `Steam 返回 HTTP ${r.status}` };
    }
    return { ...out, ok: false, reason: 'redirect', message: 'Steam 验证跳转次数过多，无法确认登录态' };
  } catch (e) {
    return { ...out, ok: false, reason: 'network', message: 'Steam 在线验证失败，请检查网络、代理或证书设置后重试' };
  }
}

/**
 * 用 CSFloat 的 JWT 验证并读取账号信息。
 * 若接口不可达或 token 非 CSFloat 的，会如实报告。
 */
export async function verifyCsfloatToken(token, { allowInsecure = true, proxy = null } = {}) {
  if (!token) return { ok: false, reason: 'no_token', message: '没有提供 CSFloat 令牌' };
  if (!looksLikeJwt(token)) return { ok: false, reason: 'not_jwt', message: '这不像一个 JWT（应以 eyJ 开头，含两个点）' };

  try {
    const r = await httpsGet('https://csfloat.com/api/v1/me', {
      allowInsecure, proxy,
      headers: { accept: 'application/json', authorization: token, referer: 'https://csfloat.com/' },
      timeoutMs: 25000,
    });
    let j = null; try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
    if (r.status === 200 && j) {
      return {
        ok: true,
        steamId: j.steam_id || j.steamId || null,
        username: j.username || j.name || null,
        message: `CSFloat 令牌有效${j.username ? `（${j.username}）` : ''}`,
      };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, reason: 'unauthorized', httpStatus: r.status, message: 'CSFloat 拒绝了这个令牌（401/403），可能已过期' };
    }
    return { ok: false, reason: `http_${r.status}`, httpStatus: r.status, message: `CSFloat 返回 HTTP ${r.status}：${r.body.slice(0, 160)}` };
  } catch (e) {
    return { ok: false, reason: 'network', message: `访问 csfloat.com 失败：${e.message}（若本机访问不了 csfloat，这一项无法验证，属正常）` };
  }
}

/**
 * 用 CSFloat 的公开解码接口把检视链接换成 float。
 * 对应扩展里的 `https://api.csfloat.com/?url=steam://...`。
 * 注意：官方已宣布该服务自 2026-03 起废弃，所以失败是预期内的 —— 失败就退回本地解码。
 */
export async function csfloatDecode(inspectUrl, { allowInsecure = true, proxy = null, token = null } = {}) {
  const url = `https://api.csfloat.com/?url=${encodeURIComponent(inspectUrl)}`;
  try {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = token;
    const r = await httpsGet(url, { allowInsecure, proxy, headers, timeoutMs: 25000 });
    let j = null; try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
    if (r.status === 200 && j) return { ok: true, data: j };
    return { ok: false, httpStatus: r.status, body: r.body.slice(0, 200) };
  } catch (e) {
    return { ok: false, reason: 'network', message: e.message };
  }
}
