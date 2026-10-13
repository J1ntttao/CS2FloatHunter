/**
 * 带节流与退避的 HTTP 客户端。
 *
 * 实测要点：buff 对高频请求会返回 HTTP 429 或 {"code":"System Error"}，
 * 所以这里统一走串行节流 + 指数退避；所有适配器都必须用它，不要直接用 fetch。
 */

import { setTimeout as delay } from 'node:timers/promises';

export class HttpClient {
  /**
   * @param {object} opts
   * @param {number} opts.minIntervalMs 同一实例内两次请求的最小间隔
   * @param {number} opts.maxRetries    429/5xx 重试次数
   * @param {string} opts.label        日志标签
   */
  constructor({ minIntervalMs = 1200, maxRetries = 4, label = 'http', verbose = true, signal } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.label = label;
    this.verbose = verbose;
    this.signal = signal;
    this._last = 0;
    this._queue = Promise.resolve();
    this.stats = { requests: 0, retries: 0, throttled: 0, failures: 0 };
  }

  _log(...a) { if (this.verbose) console.log(`[${this.label}]`, ...a); }

  /** 串行化 + 最小间隔，避免并发触发风控 */
  _schedule(fn) {
    const run = this._queue.then(async () => {
      this.signal?.throwIfAborted();
      const wait = this.minIntervalMs - (Date.now() - this._last);
      if (wait > 0) await delay(wait, undefined, { signal: this.signal });
      try { return await fn(); } finally { this._last = Date.now(); }
    });
    // 让队列不因单次失败而中断
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * @returns {Promise<{ok:boolean,status:number,data:any,raw:string,throttled:boolean,error?:string}>}
   */
  async request(url, {
    method = 'GET', headers = {}, body, timeoutMs = 25000, expectJson = true,
    maxRetries = this.maxRetries,
  } = {}) {
    return this._schedule(async () => {
      let attempt = 0;
      let lastErr = null;
      while (attempt <= maxRetries) {
        this.signal?.throwIfAborted();
        attempt++;
        this.stats.requests++;
        try {
          const r = await fetch(url, {
            method,
            headers,
            body,
            signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
          });
          const raw = await r.text();

          if ((r.status === 429 || r.status === 503) && attempt <= maxRetries) {
            this.stats.throttled++;
            const backoff = Math.min(60000, 2500 * 2 ** (attempt - 1)) + Math.random() * 700;
            this._log(`被限流 HTTP ${r.status}，第 ${attempt} 次重试，等待 ${Math.round(backoff)}ms`);
            await delay(backoff, undefined, { signal: this.signal });
            continue;
          }

          let data = null;
          if (expectJson) {
            try { data = JSON.parse(raw); } catch { data = null; }
          }

          // buff 用 HTTP 200 + code 字段表达限流/未登录，交给调用方判断
          if (data && typeof data === 'object' && data.code === 'System Error' && attempt <= maxRetries) {
            this.stats.throttled++;
            const backoff = Math.min(60000, 2500 * 2 ** (attempt - 1)) + Math.random() * 700;
            this._log(`buff 返回 System Error（限流），第 ${attempt} 次重试，等待 ${Math.round(backoff)}ms`);
            await delay(backoff, undefined, { signal: this.signal });
            continue;
          }

          return { ok: r.ok, status: r.status, data, raw, throttled: false };
        } catch (e) {
          this.signal?.throwIfAborted();
          lastErr = e;
          this.stats.failures++;
          if (attempt > maxRetries) break;
          const backoff = Math.min(30000, 1500 * 2 ** (attempt - 1));
          this._log(`网络错误 ${e.name}: ${e.message}，第 ${attempt} 次重试，等待 ${backoff}ms`);
          await delay(backoff, undefined, { signal: this.signal });
        }
      }
      return {
        ok: false, status: 0, data: null, raw: '', throttled: true,
        error: lastErr ? `${lastErr.name}: ${lastErr.message}` : '超过最大重试次数',
      };
    });
  }

  async getJson(url, headers, options = {}) { return this.request(url, { ...options, method: 'GET', headers }); }
  async postJson(url, body, headers) {
    return this.request(url, {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
}
