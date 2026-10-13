/**
 * 支持 HTTP 代理的 HTTPS 客户端（零依赖）。
 *
 * 为什么不用全局 fetch：
 *   Node 内置 fetch（undici）不支持通过 `dispatcher` 指定代理（实测 import('undici') 不可用），
 *   也不会读取 HTTP_PROXY/HTTPS_PROXY。而本项目需要：
 *     1. 走用户自己的代理去访问 Steam（steamcommunity.com 直连不通）
 *     2. 接受本机 SteamTools 之类工具注入的证书（否则报 UNABLE_TO_VERIFY_LEAF_SIGNATURE）
 *   所以这里用 node:https + 手工 CONNECT 隧道实现。
 *
 * 代理来源（优先级从高到低）：
 *   1. 显式传入的 proxy 参数（--proxy / 页面选项）
 *   2. 环境变量 HTTPS_PROXY / https_proxy / ALL_PROXY / HTTP_PROXY
 *   3. 不代理（直连）
 *
 * TLS 策略：
 *   - 默认严格校验
 *   - allowInsecure=true 时不校验证书（用于本机存在 MITM 的场景，仅建议对本机流量使用）
 *   - caFile 指定自定义根证书时优先用它
 */

import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 从环境变量推断代理 */
export function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  return parseProxyUrl(raw);
}

/**
 * 解析代理串。支持：
 *   http://host:port      普通 HTTP 代理（CONNECT 隧道）
 *   socks5://host:port    SOCKS5（含远程 DNS）
 *   socks5h://host:port   同 socks5
 *   host:port             默认按 http 处理
 */
export function parseProxyUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const withScheme = s.includes('://') ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    let type = (u.protocol || 'http:').replace(':', '').toLowerCase();
    if (type === 'socks5h' || type === 'socks') type = 'socks5';
    if (type === 'socks4') type = 'socks4';
    return {
      type,                                   // 'http' | 'socks5' | 'socks4'
      host: u.hostname,
      port: Number(u.port || (type === 'http' ? 80 : 1080)),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch { return null; }
}

/** 探测某端口是不是可用的代理（TCP 能连上即可） */
export async function probeProxy(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

/**
 * 建立到目标主机的隧道：
 *  - http 代理：发 CONNECT
 *  - socks5   ：走 SOCKS5 握手 + CONNECT（由代理做远程 DNS）
 * 返回已就绪的裸 socket（未做 TLS）。
 *
 * 注意：整个握手过程用一个硬性 deadline 兜底，任何一步卡住都会抛错而不是永久挂起。
 */
async function openTunnel(proxy, hostname, port, timeoutMs, signal) {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(500, deadline - Date.now());

  const socket = net.connect({ host: proxy.host, port: proxy.port, timeout: left() });
  const abort = () => socket.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  socket.once('close', () => signal?.removeEventListener('abort', abort));
  const guard = setTimeout(() => { try { socket.destroy(); } catch {} }, timeoutMs + 2000);
  try {
    await new Promise((res, rej) => {
      socket.once('connect', res);
      socket.once('error', e => rej(new Error(`连接代理 ${proxy.host}:${proxy.port} 失败：${e.message}`)));
      socket.once('timeout', () => { socket.destroy(); rej(new Error('连接代理超时')); });
    });

    const finishAuth = async () => {
      socket.setTimeout(0);
      // 隧道就绪后清掉整体看门狗
      clearTimeout(guard);
      return socket;
    };

    if (proxy.type === 'socks5') {
      socket.setTimeout(left());
      // 1) 问候
      const methods = proxy.username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
      const greet = await readExact(socket, 2, left());
      if (greet[0] !== 0x05) throw new Error('该端口不是 SOCKS5 代理');
      if (greet[1] === 0xff) throw new Error('SOCKS5 代理拒绝了所有认证方式');
      if (greet[1] === 0x02) {
        const u = Buffer.from(proxy.username || '', 'utf8');
        const p = Buffer.from(proxy.password || '', 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const auth = await readExact(socket, 2, left());
        if (auth[1] !== 0x00) throw new Error('SOCKS5 认证失败（用户名/密码错误）');
      }
      // 2) CONNECT，ATYP=0x03 域名（交给代理做 DNS）
      const h = Buffer.from(hostname, 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
      const rep = await readExact(socket, 4, left());
      if (rep[1] !== 0x00) {
        const codes = { 1: '一般失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒', 6: 'TTL 超时', 7: '命令不支持', 8: '地址类型不支持' };
        throw new Error(`SOCKS5 CONNECT 失败：${codes[rep[1]] || 'code ' + rep[1]}`);
      }
      const skip = rep[3] === 0x01 ? 4 : rep[3] === 0x04 ? 16 : (await readExact(socket, 1, left()))[0];
      await readExact(socket, skip + 2, left());
      return await finishAuth();
    }

    if (proxy.type === 'socks4') {
      socket.setTimeout(left());
      const dns = await import('node:dns');
      const ip = await new Promise(res => dns.lookup(hostname, (e, a) => res(e ? null : a)));
      if (!ip) throw new Error('SOCKS4 需要先解析域名，但解析失败');
      const parts = ip.split('.').map(Number);
      socket.write(Buffer.concat([Buffer.from([0x04, 0x01, port >> 8, port & 0xff, ...parts, 0x00])]));
      const r = await readExact(socket, 8, left());
      if (r[1] !== 0x5a) throw new Error(`SOCKS4 CONNECT 失败：code ${r[1]}`);
      return await finishAuth();
    }

    // 默认：HTTP CONNECT
    socket.setTimeout(left());
    socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    const head = await new Promise((res, rej) => {
      let buf = Buffer.alloc(0);
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) { socket.off('data', onData); res(buf.subarray(0, i).toString('latin1')); }
      };
      socket.on('data', onData);
      socket.once('error', rej);
      socket.once('timeout', () => { socket.destroy(); rej(new Error('代理 CONNECT 超时')); });
    });
    if (!/^HTTP\/1\.[01] 200/.test(head)) {
      throw new Error(`代理拒绝 CONNECT（${head.split('\r\n')[0]}）`);
    }
    return await finishAuth();
  } catch (e) {
    clearTimeout(guard);
    try { socket.destroy(); } catch {}
    throw e;
  }
}

/** 从 socket 精确读 n 字节（带超时兜底） */
function readExact(socket, n, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      rej(new Error(`读取代理响应超时（期望 ${n} 字节，实际 ${buf.length}）`));
    }, timeoutMs);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) { cleanup(); res(buf.subarray(0, n)); }
    };
    const onErr = e => { cleanup(); rej(e); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
    };
    socket.on('data', onData);
    socket.once('error', onErr);
  });
}

/** 扫描常见本地代理端口，返回第一个可连的（带类型猜测） */
export async function findLocalProxy() {
  const ports = [7897, 7890, 7891, 10809, 10808, 1080, 8080, 8888, 3128, 8118, 20171];
  for (const p of ports) {
    if (await probeProxy('127.0.0.1', p)) {
      // 1080/10809/10808 通常是 socks5，7890/7891/7897 多为 http（Clash 的混合口两者都吃）
      const type = [1080, 10808, 10809].includes(p) ? 'socks5' : 'http';
      return { host: '127.0.0.1', port: p, type };
    }
  }
  return null;
}

function decompress(buf, encoding) {
  // Content-Encoding 是按应用顺序列出的，读取时必须反向解码。
  // 例如 `gzip, br` 表示先 gzip 再 br，收到的字节要先 brotli、再 gzip。
  const encodings = String(encoding || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value && value !== 'identity')
    .reverse();
  let out = buf;
  try {
    for (const encodingName of encodings) {
      if (encodingName === 'br') out = zlib.brotliDecompressSync(out);
      else if (encodingName === 'gzip' || encodingName === 'x-gzip') out = zlib.gunzipSync(out);
      else if (encodingName === 'deflate') out = zlib.inflateSync(out);
    }
    return out;
  } catch {
    // 某些代理会丢失或改写 Content-Encoding。按常见压缩头再尝试一次，
    // 成功后解析器拿到正文；仍失败则保留原始字节，由上层返回明确结构错误。
    try {
      if (out === buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return zlib.gunzipSync(buf);
      }
    } catch { /* 保留原始响应，避免吞掉原始诊断信息 */ }
    return buf;
  }
}

/**
 * 一次 HTTPS GET（支持自动跟随 3xx 重定向）。
 *
 * Steam 的 /market/listings/730/<名字> 会 302 到新版短链 /market/listings/730/G181120C50A3004，
 * 必须跟随才能拿到真正的挂单页，所以默认 followRedirects=true。
 */
export async function httpsGet(url, opts = {}) {
  opts.signal?.throwIfAborted();
  const { followRedirects = true, maxRedirects = 5, ...rest } = opts;
  let current = url;
  const visited = new Set();
  for (let i = 0; i <= maxRedirects; i++) {
    opts.signal?.throwIfAborted();
    if (visited.has(current)) {
      const e = new Error(`重定向循环：${current}`);
      e.code = 'REDIRECT_LOOP';
      e.url = current;
      throw e;
    }
    visited.add(current);
    const r = await httpsGetOnce(current, rest);
    if (followRedirects && r.status >= 300 && r.status < 400 && r.headers?.location) {
      const loc = r.headers.location;
      current = loc.startsWith('http') ? loc : new URL(loc, current).toString();
      continue;
    }
    return { ...r, finalUrl: current };
  }
  const e = new Error(`重定向次数超过 ${maxRedirects}`);
  e.code = 'REDIRECT_LIMIT';
  e.url = current;
  throw e;
}

async function httpsGetOnce(url, opts = {}) {
  const {
    proxy = null, allowInsecure = false, caFile = null,
    headers = {}, timeoutMs = 25000, method = 'GET', body = null, signal,
  } = opts;

  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port || (isHttps ? 443 : 80));
  const path = u.pathname + u.search;

  let ca;
  if (caFile && fs.existsSync(caFile)) ca = fs.readFileSync(caFile, 'utf8');
  const rejectUnauthorized = ca ? true : !allowInsecure;

  const baseHeaders = {
    'user-agent': DEFAULT_UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    ...headers,
  };

  // ---------- 代理模式：HTTP CONNECT 或 SOCKS5 隧道 ----------
  if (proxy && isHttps) {
    const socket = await openTunnel(proxy, u.hostname, port, timeoutMs, signal);

    if (socket.destroyed) throw new Error('代理隧道建立后连接被关闭');
    socket.setTimeout(0);

    const tlsSock = tls.connect({ socket, servername: u.hostname, rejectUnauthorized, ca, timeout: timeoutMs });
    await new Promise((res, rej) => {
      tlsSock.once('secureConnect', res);
      tlsSock.once('error', e => rej(new Error(`经代理的 TLS 握手失败：${e.message}`)));
    });
    const cert = tlsSock.getPeerCertificate();
    tlsSock.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
      Object.entries(baseHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      `\r\nConnection: close\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n` +
      (body || '')
    );
    const chunks = [];
    await new Promise((res, rej) => {
      tlsSock.on('data', d => chunks.push(d));
      tlsSock.on('end', res);
      tlsSock.on('error', rej);
      tlsSock.on('timeout', () => { tlsSock.destroy(); rej(new Error('读取超时')); });
    });
    const raw = Buffer.concat(chunks);
    return parseRawResponse(raw, true, cert);
  }

  // ---------- 代理 + 明文 HTTP（非 https 目标）----------
  if (proxy && !isHttps) {
    const socket = await openTunnel(proxy, u.hostname, port, timeoutMs, signal);
    socket.setTimeout(0);
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${u.hostname}\r\n` +
      Object.entries(baseHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      `\r\nConnection: close\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n` +
      (body || '')
    );
    const chunks = [];
    await new Promise((res, rej) => {
      socket.on('data', d => chunks.push(d));
      socket.on('end', res);
      socket.on('error', rej);
      socket.on('timeout', () => { socket.destroy(); rej(new Error('读取超时')); });
    });
    return parseRawResponse(Buffer.concat(chunks), true, null);
  }

  // ---------- 直连 ----------
  if (!isHttps) {
    const lib = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = lib.request({ hostname: u.hostname, port, path, method, headers: baseHeaders, timeout: timeoutMs, signal }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers,
          body: decompress(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'),
          viaProxy: false,
        }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port, path, method, headers: baseHeaders,
      rejectUnauthorized, ca, timeout: timeoutMs, signal,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const cert = res.socket?.getPeerCertificate?.();
        resolve({
          status: res.statusCode, headers: res.headers,
          body: decompress(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'),
          viaProxy: false,
          tlsIssuer: cert?.issuer?.O || cert?.issuer?.CN,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 解析手工隧道拿到的原始 HTTP 响应 */
function parseRawResponse(raw, viaProxy, cert) {
  // 先找头尾分隔；body 可能是二进制（gzip），所以按字节切
  const idx = raw.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error('响应格式异常（找不到头部结束）');
  const headText = raw.subarray(0, idx).toString('latin1');
  let bodyBuf = raw.subarray(idx + 4);

  const lines = headText.split('\r\n');
  const status = Number((lines[0].match(/\s(\d{3})/) || [])[1]);
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }

  // chunked 传输要自己解码
  if (String(headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    bodyBuf = decodeChunked(bodyBuf);
  }
  const body = decompress(bodyBuf, headers['content-encoding']).toString('utf8');
  return {
    status, headers, body, viaProxy,
    tlsIssuer: cert?.issuer?.O || cert?.issuer?.CN,
  };
}

function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * 组装一个「带节流 + 重试」的取数器，供各市场适配器使用。
 */
export function makeFetcher({ proxy = null, allowInsecure = false, caFile = null, minIntervalMs = 1500, label = 'http', signal } = {}) {
  let last = 0;
  const sleep = ms => delay(ms, undefined, { signal });
  return async function fetchOnce(url, { headers = {}, retries = 3, timeoutMs = 25000 } = {}) {
    let attempt = 0;
    while (true) {
      signal?.throwIfAborted();
      attempt++;
      const wait = minIntervalMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      try {
        const r = await httpsGet(url, { proxy, allowInsecure, caFile, headers, timeoutMs, signal });
        last = Date.now();
        if ((r.status === 429 || r.status === 503) && attempt <= retries) {
          const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.random() * 500;
          console.log(`[${label}] HTTP ${r.status}，第 ${attempt} 次重试，等待 ${Math.round(backoff)}ms`);
          await sleep(backoff);
          continue;
        }
        return r;
      } catch (e) {
        signal?.throwIfAborted();
        last = Date.now();
        // 商品页短链循环/超过上限通常是代理或 Steam 路由异常，重试只会重复同一循环。
        if (e?.code === 'REDIRECT_LOOP' || e?.code === 'REDIRECT_LIMIT') throw e;
        if (attempt > retries) throw e;
        const backoff = Math.min(15000, 1200 * 2 ** (attempt - 1));
        console.log(`[${label}] ${e.message}，第 ${attempt} 次重试，等待 ${backoff}ms`);
        await sleep(backoff);
      }
    }
  };
}
