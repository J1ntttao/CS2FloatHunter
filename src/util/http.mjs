/**
 * 带节流与退避的 HTTP 客户端。
 *
 * 实测要点：buff 对高频请求会返回 HTTP 429 或 {"code":"System Error"}，
 * 所以这里统一走串行节流 + 指数退避；所有适配器都必须用它，不要直接用 fetch。
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class HttpClient {
  /**
   * @param {object} opts
   * @param {number} opts.minIntervalMs 同一实例内两次请求的最小间隔
   * @param {number} opts.maxRetries    429/5xx 重试次数
   * @param {string} opts.label        日志标签
   */
  constructor({ minIntervalMs = 1200, maxRetries = 4, label = 'http', verbose = true } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.label = label;
    this.verbose = verbose;
    this._last = 0;
    this._queue = Promise.resolve();
    this.stats = { requests: 0, retries: 0, throttled: 0, failures: 0 };
  }

  _log(...a) { if (this.verbose) console.log(`[${this.label}]`, ...a); }

  /** 串行化 + 最小间隔，避免并发触发风控 */
  _schedule(fn) {
    const run = this._queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this._last);
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this._last = Date.now(); }
    });
    // 让队列不因单次失败而中断
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * @returns {Promise<{ok:boolean,status:number,data:any,raw:string,throttled:boolean,error?:string}>}
   */
  async request(url, { method = 'GET', headers = {}, body, timeoutMs = 25000, expectJson = true } = {}) {
    return this._schedule(async () => {
      let attempt = 0;
      let lastErr = null;
      while (attempt <= this.maxRetries) {
        attempt++;
        this.stats.requests++;
        try {
          const r = await fetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
          });
          const raw = await r.text();

          if (r.status === 429 || r.status === 503) {
            this.stats.throttled++;
            const backoff = Math.min(60000, 2500 * 2 ** (attempt - 1)) + Math.random() * 700;
            this._log(`被限流 HTTP ${r.status}，第 ${attempt} 次重试，等待 ${Math.round(backoff)}ms`);
            await sleep(backoff);
            continue;
          }

          let data = null;
          if (expectJson) {
            try { data = JSON.parse(raw); } catch { data = null; }
          }

          // buff 用 HTTP 200 + code 字段表达限流/未登录，交给调用方判断
          if (data && typeof data === 'object' && data.code === 'System Error' && attempt <= this.maxRetries) {
            this.stats.throttled++;
            const backoff = Math.min(60000, 2500 * 2 ** (attempt - 1)) + Math.random() * 700;
            this._log(`buff 返回 System Error（限流），第 ${attempt} 次重试，等待 ${Math.round(backoff)}ms`);
            await sleep(backoff);
            continue;
          }

          return { ok: r.ok, status: r.status, data, raw, throttled: false };
        } catch (e) {
          lastErr = e;
          this.stats.failures++;
          if (attempt > this.maxRetries) break;
          const backoff = Math.min(30000, 1500 * 2 ** (attempt - 1));
          this._log(`网络错误 ${e.name}: ${e.message}，第 ${attempt} 次重试，等待 ${backoff}ms`);
          await sleep(backoff);
        }
      }
      return {
        ok: false, status: 0, data: null, raw: '', throttled: true,
        error: lastErr ? `${lastErr.name}: ${lastErr.message}` : '超过最大重试次数',
      };
    });
  }

  async getJson(url, headers) { return this.request(url, { method: 'GET', headers }); }
  async postJson(url, body, headers) {
    return this.request(url, {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
}
