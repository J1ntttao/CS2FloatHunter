#!/usr/bin/env node
/**
 * 手动录入 Cookie 字符串。
 *
 * 用法（三种任选）：
 *   node scripts/set-cookies.mjs --from-clipboard
 *   node scripts/set-cookies.mjs --from-file my-cookies.txt
 *   node scripts/set-cookies.mjs --site buff --string "session=xxx; csrf_token=yyy; ..."
 *   node scripts/set-cookies.mjs --json '[{"domain":".buff.163.com","name":"session","value":"xxx"}]'
 *
 * 支持的输入格式（自动识别）：
 *   1) DevTools 的 Cookie 请求头：  session=abc; csrf_token=def; Device-Id=ghi
 *   2) Cookie-Editor 导出的 JSON 数组 / {"cookies":[...]}
 *   3) name=value 每行一条
 *
 * 站点用 --site 指定（buff / youpin / steam / cs2up），默认 buff。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');

const SITES = {
  buff:   { domain: '.buff.163.com',   label: 'BUFF',      referer: 'https://buff.163.com/market/csgo' },
  youpin: { domain: '.youpin898.com',  label: '悠悠有品',  referer: 'https://www.youpin898.com/' },
  steam:  { domain: 'steamcommunity.com', label: 'Steam 社区市场', referer: 'https://steamcommunity.com/market/' },
  cs2up:  { domain: 'cs2up.cn',        label: 'CS2UP',     referer: 'https://cs2up.cn/tradeup.html' },
};

function die(msg, code = 1) { console.error(`\n[错误] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const o = { site: 'buff', string: null, json: null, file: null, clipboard: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site') o.site = argv[++i];
    else if (a === '--string' || a === '-s') o.string = argv[++i];
    else if (a === '--json' || a === '-j') o.json = argv[++i];
    else if (a === '--file' || a === '-f') o.file = argv[++i];
    else if (a === '--from-clipboard' || a === '-c') o.clipboard = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return o;
}

function printHelp() {
  console.log(`用法:
  node scripts/set-cookies.mjs --from-clipboard [--site buff]
  node scripts/set-cookies.mjs --from-file cookies.txt [--site buff]
  node scripts/set-cookies.mjs --string "session=...; csrf_token=..." [--site buff]
  node scripts/set-cookies.mjs --json '[{"domain":".buff.163.com","name":"session","value":"..."}]'

站点: ${Object.keys(SITES).join(' / ')}`);
}

/** 从 "a=1; b=2" 形式的 cookie 头解析 */
function parseCookieHeader(str) {
  const out = [];
  for (const part of str.split(/[;\n\r]+/)) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (!name || /^cookie$/i.test(name)) continue;
    out.push({ name, value });
  }
  return out;
}

/** 尝试把输入当成 JSON（Cookie-Editor 导出等） */
function tryParseJson(text) {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  let obj;
  try { obj = JSON.parse(t); } catch { return null; }
  const arr = Array.isArray(obj) ? obj : (obj.cookies || obj.Cookies);
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const name = c.name ?? c.Name;
    const value = c.value ?? c.Value;
    if (!name || value == null) continue;
    out.push({ name: String(name), value: String(value), domain: c.domain ?? c.Domain ?? undefined, path: c.path ?? c.Path ?? '/' });
  }
  return out.length ? out : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = SITES[args.site];
  if (!site) die(`未知站点 "${args.site}"，可选：${Object.keys(SITES).join(', ')}`);

  let raw = null;
  if (args.string != null) raw = args.string;
  else if (args.json != null) raw = args.json;
  else if (args.file) {
    if (!fs.existsSync(args.file)) die(`文件不存在：${args.file}`);
    raw = fs.readFileSync(args.file, 'utf8');
  } else if (args.clipboard) {
    const { execFileSync } = await import('node:child_process');
    try {
      raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
        { encoding: 'utf8', windowsHide: true });
    } catch (e) {
      if (e.code === 'EPERM') die('当前沙箱禁止 Node 调用剪贴板，请改用 --string / --from-file。');
      die(`读取剪贴板失败：${e.message}`);
    }
  } else {
    printHelp();
    die('请指定输入方式（--from-clipboard / --string / --from-file / --json）');
  }

  if (!raw || !raw.trim()) die('输入为空。');

  let items = tryParseJson(raw);
  let how = 'Cookie-Editor JSON';
  if (!items) { items = parseCookieHeader(raw); how = 'Cookie 请求头'; }
  if (!items || !items.length) die('未能从输入中解析出任何 cookie。请检查格式。');

  const now = Math.floor(Date.now() / 1000);
  const cookies = items.map(c => ({
    domain: c.domain || site.domain,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: true,
    httpOnly: false,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : now + 30 * 24 * 3600,
  }));

  fs.mkdirSync(DATA, { recursive: true });
  const outFile = path.join(DATA, `cookies.manual.${args.site}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    source: `manual:${how}`,
    site: args.site,
    referer: site.referer,
    counts: { total: cookies.length },
    cookies,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), { mode: 0o600 });

  console.log(`=== ${site.label} Cookie 录入 ===`);
  console.log(`解析方式 : ${how}`);
  console.log(`解析到   : ${cookies.length} 条 cookie`);
  console.log(`写入     : ${outFile}`);
  console.log(`包含     : ${cookies.map(c => c.name).join(', ')}`);
  console.log('\n提示：cookie 会过期，若之后抓取报“未登录”，重新执行本脚本即可。');
}

main().catch(e => die(e?.stack || String(e)));
