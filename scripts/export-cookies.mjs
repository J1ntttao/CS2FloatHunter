#!/usr/bin/env node
/**
 * Chrome Cookie 导出器（Windows / Chrome 127+，兼容 App-Bound Encryption 时代）
 *
 * 设计原因（都是实测得出的约束）：
 *  - Chrome 运行时会以独占方式锁定整份 profile（Cookies / History 连只读打开都会被拒绝），
 *    所以本脚本要求在 Chrome 完全退出后运行。
 *  - 主密钥存放在 "Local State" 的 os_crypt.encrypted_key，带 5 字节 "DPAPI" 前缀，
 *    必须用当前 Windows 用户的 DPAPI 解开。Node 在本沙箱内无法调用 DPAPI，
 *    因此密钥解密交给 PowerShell，Cookie 解密与 SQLite 读取留在 Node。
 *  - Cookie 值加密格式：'v10'/'v11' + 12 字节 nonce + 密文 + 16 字节 GCM tag（AES-256-GCM）。
 *
 * 用法:
 *   node scripts/export-cookies.mjs
 *   node scripts/export-cookies.mjs --profile "Profile 1"
 *   node scripts/export-cookies.mjs --master-key-base64 <b64>   # 跳过 DPAPI
 *   node scripts/export-cookies.mjs --self-test                 # 用可读 profile 验证解密链路
 *   node scripts/export-cookies.mjs --keep-all                  # 导出全部站点 cookie
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// 注意：本沙箱禁止 Node 派生子进程（spawnSync -> EPERM，命名管道被封锁），
// 所以 DPAPI 解密钥这一步不能由 Node 发起，必须由 PowerShell 入口脚本
// 通过 --master-key-base64 传入。run-export-cookies.ps1 就是这个入口。

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');

const TARGET_DOMAINS = [
  'buff.163.com',
  'steamcommunity.com',
  'cs2up.cn',
  '163.com',
  'netease.com',
];

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
function die(msg, code = 1) { console.error(`\n[错误] ${msg}\n`); process.exit(code); }

function parseArgs(argv) {
  const out = { profile: 'Default', masterKeyBase64: null, selfTest: false, keepAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--master-key-base64') out.masterKeyBase64 = argv[++i];
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--keep-all') out.keepAll = true;
    else if (a === '--help' || a === '-h') {
      log('用法: node scripts/export-cookies.mjs [--profile "Default"] [--master-key-base64 B64] [--self-test] [--keep-all]');
      process.exit(0);
    }
  }
  return out;
}

const chromeUserDataDir = () =>
  path.join(process.env.LOCALAPPDATA || die('找不到 %LOCALAPPDATA%'), 'Google', 'Chrome', 'User Data');

/** 只输出纯 base64，用 -EncodedCommand 避免引号转义问题。
 *  仅当从 PowerShell 入口之外直接运行、且 --master-key-base64 未提供时才会走到这里；
 *  在受限沙箱内 execFileSync 会抛 EPERM，此时给出明确指引。 */
function unwrapMasterKeyViaDPAPI(userDataDir) {
  const localState = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localState)) die(`找不到 Local State: ${localState}`);

  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    `$ls = ${JSON.stringify(localState)}`,
    '$j = Get-Content -LiteralPath $ls -Raw | ConvertFrom-Json',
    '$b64 = $j.os_crypt.encrypted_key',
    "if (-not $b64) { [Console]::Error.Write('os_crypt.encrypted_key missing'); exit 2 }",
    '$raw = [Convert]::FromBase64String($b64)',
    "$prefix = [System.Text.Encoding]::ASCII.GetString($raw[0..4])",
    "if ($prefix -ne 'DPAPI') { [Console]::Error.Write(\"unexpected key prefix: $prefix\"); exit 3 }",
    '$blob = New-Object byte[] ($raw.Length - 5)',
    '[Array]::Copy($raw, 5, $blob, 0, $blob.Length)',
    "$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')",
    '[Convert]::ToBase64String($key)',
  ].join('; ');

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20,
    });
  } catch (e) {
    if (e.code === 'EPERM') {
      die(
        '当前沙箱禁止 Node 派生子进程（EPERM），无法自行调用 DPAPI 解主密钥。\n' +
        '请改用 PowerShell 入口脚本运行：\n' +
        '  pwsh -File scripts/run-export-cookies.ps1'
      );
    }
    die(`DPAPI 解密主密钥失败：${(e.stderr || e.stdout || e.message || '').toString().trim()}`);
  }
  const b64 = out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  const key = Buffer.from(b64 || '', 'base64');
  if (key.length !== 32) die(`DPAPI 解出的主密钥长度异常：${key.length} 字节（期望 32）`);
  return key;
}

/** 打开 Cookies 库并读出原始行。
 *  实测要点（Windows + node:sqlite）：
 *   - 裸 Windows 路径 + '?immutable=1' 会报 "unable to open database file"，
 *     必须写成 file:/// URI（正斜杠）才能带查询参数。
 *   - Node 的 fs.copyFileSync 能以 FILE_SHARE_READ|WRITE 打开 Chrome 独占锁定的文件
 *     （PowerShell 的 FileStream 反而会被拒绝），所以复制一份再读最稳妥；
 *     复制失败时回退到 immutable 直读原始库。 */
function readCookieRows(cookieDb) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const toUri = p => 'file:///' + p.replace(/\\/g, '/');

  const attempts = [];
  const copyPath = path.join(CACHE_DIR, `Cookies.copy.${process.pid}.db`);
  try {
    fs.copyFileSync(cookieDb, copyPath);
    attempts.push({ label: '副本', uri: toUri(copyPath), cleanup: copyPath });
  } catch (e) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    warn(`  ! 无法复制 Cookies 库（${e.code}），改用 immutable 直读`);
  }
  attempts.push({ label: 'immutable 直读', uri: toUri(cookieDb) + '?immutable=1', cleanup: null });

  let lastErr = null;
  for (const a of attempts) {
    let db;
    try {
      db = new DatabaseSync(a.uri, {});
      // expires_utc 是 Chrome 的 1601 纪元微秒数（约 1.34e16），超出 JS 安全整数范围，
      // 直接读取会抛 "Value is too large to be represented as a JavaScript number"，
      // 因此在 SQL 层转成文本再自行解析。
      const rows = db.prepare(
        'SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly FROM cookies'
      ).all();
      db.close();
      if (a.cleanup) { try { fs.unlinkSync(a.cleanup); } catch {} }
      return rows;
    } catch (e) {
      lastErr = e;
      try { db?.close(); } catch {}
      if (a.cleanup) { try { fs.unlinkSync(a.cleanup); } catch {} }
    }
  }
  die(`无法读取 Cookies 数据库：${lastErr?.message}`);
}

function decryptCookieValue(encBuf, key) {
  const buf = Buffer.isBuffer(encBuf) ? encBuf : Buffer.from(encBuf || []);
  if (buf.length < 3 + 12 + 16) return null;
  const version = buf.subarray(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') return null;
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(15, buf.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function isChromeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8' });
    return /chrome\.exe/i.test(out);
  } catch { return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = chromeUserDataDir();
  const cookieDb = path.join(userDataDir, args.profile, 'Network', 'Cookies');

  log('=== Chrome Cookie 导出器 ===');
  log(`用户数据目录 : ${userDataDir}`);
  log(`Profile      : ${args.profile}`);
  log(`Cookies 库   : ${cookieDb}`);
  if (!fs.existsSync(cookieDb)) die('找不到 Cookies 数据库，请确认 profile 名称是否正确。');

  const running = isChromeRunning();
  if (running) {
    warn(
      '\n[注意] 检测到 chrome.exe 正在运行。\n' +
      '  Chrome 会独占锁定 profile，但 Node 能以共享方式复制 Cookies 库（已实测可行），\n' +
      '  因此仍然可以导出。副作用：Chrome 内存中尚未落盘的 cookie 可能读不到，\n' +
      '  若发现缺少关键登录 cookie，请完全退出 Chrome 后重新运行本脚本。\n'
    );
  }

  log('\n[1/4] 获取主密钥 ...');
  const key = args.masterKeyBase64
    ? Buffer.from(args.masterKeyBase64, 'base64')
    : unwrapMasterKeyViaDPAPI(userDataDir);
  if (key.length !== 32) die(`主密钥长度必须为 32 字节，实际 ${key.length}`);
  log(`      OK（指纹 ${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}）`);

  log('\n[2/4] 读取并解密 cookies ...');
  const rows = readCookieRows(cookieDb);

  let decrypted = 0, failed = 0, plain = 0;
  const cookies = [];
  for (const r of rows) {
    let value = r.value;
    if (value) { plain++; }
    else if (r.encrypted_value && r.encrypted_value.length) {
      const v = decryptCookieValue(r.encrypted_value, key);
      if (v === null) { failed++; continue; }
      value = v; decrypted++;
    } else { continue; }

    cookies.push({
      domain: r.host_key,
      name: r.name,
      value,
      path: r.path || '/',
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly,
      expires: r.expires_utc ? Math.round(Number(r.expires_utc) / 1e6 - 11644473600) : null,    });
  }
  log(`      共 ${rows.length} 条 → 明文 ${plain}，解密成功 ${decrypted}，解密失败 ${failed}`);

  log('\n[3/4] 筛选目标站点 ...');
  const wanted = args.keepAll ? cookies : cookies.filter(c => {
    const d = c.domain.replace(/^\./, '');
    return TARGET_DOMAINS.some(t => d === t || d.endsWith('.' + t));
  });
  const byDomain = new Map();
  for (const c of wanted) {
    const d = c.domain.replace(/^\./, '');
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c.name);
  }
  for (const d of [...byDomain.keys()].sort()) {
    const names = byDomain.get(d);
    log(`      ${d.padEnd(24)} ${String(names.length).padStart(3)} 条  [${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}]`);
  }
  if (!wanted.length) {
    warn('\n  ! 未匹配到任何目标站点 cookie。请确认已在该 Chrome profile 里登录 buff。');
  }

  log('\n[4/4] 写入凭证文件 ...');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `cookies.${args.profile.replace(/[^\w.-]+/g, '_')}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    source: 'chrome',
    profile: args.profile,
    counts: { total: cookies.length, matched: wanted.length, decrypted, failed, plain },
    cookies: wanted,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.writeFileSync(
    path.join(OUT_DIR, 'cookies.latest.json'),
    JSON.stringify({ profile: args.profile, file: path.basename(outFile), exportedAt: payload.exportedAt }, null, 2)
  );
  log(`      -> ${outFile}`);
  log(`      匹配 ${wanted.length} 条 cookie`);

  if (!wanted.length) { log('\n失败：没有可用 cookie。'); process.exit(2); }
  log('\n完成。现在可以重新打开 Chrome 了。');
}

main().catch(e => die(e?.stack || String(e)));
