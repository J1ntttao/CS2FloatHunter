/**
 * Cookie / 登录态加载。
 *
 * 凭证来源优先级（高 → 低）：
 *   1. data/credentials.json      —— 手工汇总文件（最可控）
 *   2. data/cookies.manual.<site>.json —— scripts/set-cookies.* 写入
 *   3. data/cookies.<profile>.json     —— scripts/export-cookies.* 写入（Chrome, 仅当 cookie 是 v10 等可解格式）
 *
 * 站点键：buff / youpin / steam / cs2up
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');

export const SITES = {
  buff: {
    label: 'BUFF',
    domains: ['buff.163.com'],
    origin: 'https://buff.163.com',
    referer: 'https://buff.163.com/market/csgo',
  },
  youpin: {
    label: '悠悠有品',
    domains: ['youpin898.com'],
    origin: 'https://www.youpin898.com',
    referer: 'https://www.youpin898.com/',
  },
  steam: {
    label: 'Steam 社区市场',
    domains: ['steamcommunity.com'],
    origin: 'https://steamcommunity.com',
    referer: 'https://steamcommunity.com/market/',
  },
  cs2up: {
    label: 'CS2UP',
    domains: ['cs2up.cn'],
    origin: 'https://cs2up.cn',
    referer: 'https://cs2up.cn/tradeup.html',
  },
};

export function siteMatchesDomain(site, domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return SITES[site]?.domains.some(sd => d === sd || d.endsWith('.' + sd));
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** 汇总某站点的所有 cookie（后面的来源覆盖前面的同名 cookie） */
export function loadCookies(site) {
  const merged = new Map();
  for (const c of loadCookiesDetailed(site).cookies) merged.set(c.name, c);
  return [...merged.values()];
}

/** 返回 { cookies, sources }，便于诊断 cookie 来自哪里 */
export function loadCookiesDetailed(site) {
  const sources = [];
  const cookies = [];

  const push = (file, list, label) => {
    if (!Array.isArray(list) || !list.length) return;
    let n = 0;
    for (const c of list) {
      if (!c || !c.name || c.value == null) continue;
      // 只接受属于该站点的 cookie（手工 JSON 可能没写 domain）
      if (c.domain && !siteMatchesDomain(site, c.domain)) continue;
      cookies.push({
        domain: c.domain || '.' + SITES[site].domains[0],
        name: String(c.name),
        value: String(c.value),
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        expires: c.expires ?? (c.expirationDate ? Math.floor(c.expirationDate) : null),
      });
      n++;
    }
    if (n) sources.push({ file: path.relative(ROOT, file), label, count: n });
  };

  // 1) 汇总文件
  const creds = readJsonIfExists(path.join(DATA_DIR, 'credentials.json'));
  if (creds) {
    const bucket = creds.sites?.[site] || (creds.site === site ? creds : null);
    if (bucket) push(path.join(DATA_DIR, 'credentials.json'), bucket.cookies || bucket, 'credentials.json');
  }

  // 2) 手工录入
  const manual = path.join(DATA_DIR, `cookies.manual.${site}.json`);
  const mj = readJsonIfExists(manual);
  if (mj) push(manual, mj.cookies, '手工录入');

  // 3) Chrome 导出（任意 profile 文件里属于该站点的部分）
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^cookies\..+\.json$/.test(f)) continue;
      if (f === 'cookies.latest.json') continue;
      if (f.startsWith('cookies.manual.') || f === 'credentials.json') continue;
      const j = readJsonIfExists(path.join(DATA_DIR, f));
      if (j) push(path.join(DATA_DIR, f), j.cookies, `Chrome 导出(${j.profile || '?'})`);
    }
  }

  return { cookies, sources };
}

/** 生成 Cookie 请求头 */
export function cookieHeader(site) {
  return loadCookies(site).map(c => `${c.name}=${c.value}`).join('; ');
}

export function hasCookies(site) {
  const c = loadCookies(site);
  return c.length > 0;
}

/** 通用请求头（含浏览器指纹字段，尽量贴近真实浏览器） */
export function defaultHeaders(site, extra = {}) {
  const s = SITES[site];
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const h = {
    'user-agent': ua,
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'referer': s?.referer || '',
    'origin': s?.origin || '',
  };
  const cookies = cookieHeader(site);
  if (cookies) h['cookie'] = cookies;
  return { ...h, ...extra };
}
