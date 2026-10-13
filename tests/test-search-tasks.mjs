import { EventEmitter } from 'node:events';
import { SearchTasks } from '../src/web/search-tasks.mjs';
import { HttpClient } from '../src/util/http.mjs';
import { makeFetcher } from '../src/util/net.mjs';
import { httpsGet } from '../src/util/net.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
};

// 执行页面原有事件处理器，验证取消确认之前按钮不会允许重搜，旧事件也不污染新任务。
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const stopCode = html.slice(html.indexOf("let MARKET = 'buff';"), html.indexOf("$('stop').onclick = stopSearch;"));
const goCode = html.slice(html.indexOf("$('go').onclick ="), html.indexOf('function openBuyPanel'));
const elements = Object.fromEntries(['link', 'wear', 'go', 'stop', 'continue', 'band', 'interval', 'insecure', 'proxy', 'stattrak', 'qualityNote']
  .map(id => [id, { style: {}, value: '', checked: true }]));
elements.link.value = '7928752d714f8e31';
elements.wear.value = '0.2';
const sources = [];
const statuses = [];
let acknowledgeCancel;
class FakeEventSource {
  static CLOSED = 2;
  handlers = {};
  constructor(url) { this.url = url; sources.push(this); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}
const page = vm.createContext({
  $: id => elements[id], crypto: { randomUUID: () => `task-${sources.length}` },
  URLSearchParams, EventSource: FakeEventSource, MARKET_LABEL: { buff: 'BUFF' },
  statusLine: text => statuses.push(text), reset: () => {}, renderLocated: () => {}, renderResult: () => {},
  qualityInputSid: () => '7928752d714f8e31', qualitySid: null, qualityOverrideSid: null,
  fetch: () => new Promise(resolve => { acknowledgeCancel = resolve; }),
});
vm.runInContext(stopCode + goCode, page);
elements.go.onclick();
const stopping = vm.runInContext('stopSearch()', page);
ok(elements.go.disabled && sources[0].readyState === FakeEventSource.CLOSED,
  '停止时立即关闭 SSE，并在服务端确认取消前禁止重搜');
acknowledgeCancel({ ok: true });
await stopping;
ok(!elements.go.disabled, '服务端确认取消后恢复搜索按钮');
elements.go.onclick();
const statusCount = statuses.length;
sources[0].handlers.error({ data: '{"message":"old error"}' });
ok(elements.go.disabled && statuses.length === statusCount, '旧搜索的迟到错误不影响新搜索按钮和状态');

// 错误事件结束当前 SSE 后，恢复按钮仍必须可见；继续请求沿用首次搜索的品质参数。
page.qualitySid = '7928752d714f8e31';
elements.stattrak.checked = true;
elements.go.onclick();
const initialRetryable = sources[2];
ok(new URLSearchParams(initialRetryable.url.split('?')[1]).get('stattrak') === '1', '首次搜索记录显式暗金参数');
initialRetryable.handlers.error({ data: JSON.stringify({
  message: '搜索超时', resume: { id: 'resume-ui', canContinue: true, pending: [{ id: 'x' }] },
}) });
ok(elements.continue.style.display === '', '搜索错误结束后显示重试失败项按钮');
elements.continue.onclick();
const retried = sources[3];
ok(new URLSearchParams(retried.url.split('?')[1]).get('stattrak') === '1', '重试沿用首次搜索的品质参数');
retried.handlers.error({ data: JSON.stringify({ message: '结束', resume: { id: 'resume-ui', canContinue: false } }) });
page.qualitySid = null;
elements.go.onclick();
const autoQualitySearch = sources[4];
autoQualitySearch.handlers.located({ data: JSON.stringify({ sid: '7928752d714f8e31', statTrak: true, collectionSpecs: [] }) });
autoQualitySearch.handlers.error({ data: JSON.stringify({ message: '搜索超时', resume: { id: 'auto-quality-resume', canContinue: true } }) });
elements.continue.onclick();
const autoQualityRetryParams = new URLSearchParams(sources[5].url.split('?')[1]);
ok(autoQualityRetryParams.get('resume_id') === 'auto-quality-resume' && !autoQualityRetryParams.has('stattrak'),
  '配方自动识别品质后继续仍沿用原始参数，不改变断点签名');
sources[5].handlers.done({ data: JSON.stringify({ elapsedMs: 10 }) });
ok(elements.continue.style.display === '', '带待重试项的结果结束后仍显示继续入口');

const response = () => {
  const r = new EventEmitter();
  r.destroyed = false;
  r.writableEnded = false;
  r.end = () => { r.writableEnded = true; };
  return r;
};

const tasks = new SearchTasks();
const first = tasks.start(response(), 'first');
ok(tasks.busy, '启动任务后状态为 busy');
first.cancel();
ok(!tasks.busy, '取消任务立即释放 busy');

const second = tasks.start(response(), 'second');
ok(!!second && tasks.busy, '旧任务取消后可以立即启动新任务');
first.finish();
ok(tasks.active === second, '旧任务的 finally 不会清掉新任务锁');
ok(tasks.cancel('second') && !tasks.busy, '按任务 ID 取消当前任务');

const third = tasks.start(response(), 'third');
let finishOld;
const pending = third.run(() => new Promise(resolve => { finishOld = resolve; }));
await Promise.resolve();
third.cancel();
await pending.then(() => { throw new Error('取消后任务不应完成'); }, e => {
  ok(e.name === 'AbortError', '取消会中断任务 Promise');
});
finishOld('late');
const disconnected = response();
const fourth = tasks.start(disconnected, 'fourth');
disconnected.destroyed = true;
disconnected.emit('close');
ok(fourth.signal.aborted && !tasks.busy, '关闭 SSE 连接也会取消并释放任务');

const fifth = tasks.start(response(), 'fifth');
ok(!tasks.cancel('first') && tasks.active === fifth, '旧任务的迟到取消请求不能取消新任务');
ok(!tasks.start(response(), 'blocked'), '已有有效任务时继续拒绝并发搜索');
await fifth.run(() => Promise.resolve('finished'), 60000);
fifth.finish();
ok(!tasks.busy, '正常结束释放锁并清理超时计时器');

// 验证底层 HTTP 取消不再进入退避重试，也会终止已发出的请求。
const stalled = http.createServer((_req, res) => { res.writeHead(200); res.write('pending'); });
stalled.listen(0, '127.0.0.1');
await once(stalled, 'listening');
const stalledUrl = `http://127.0.0.1:${stalled.address().port}`;
try {
  for (const type of ['buff', 'steam']) {
    const controller = new AbortController();
    const requestSeen = once(stalled, 'request');
    const client = type === 'buff'
      ? new HttpClient({ minIntervalMs: 0, verbose: false, signal: controller.signal })
      : makeFetcher({ minIntervalMs: 0, signal: controller.signal });
    const request = type === 'buff' ? client.request(stalledUrl) : client(stalledUrl);
    const rejected = request.then(() => { throw new Error('取消请求不应成功'); }, e => {
      ok(e.name === 'AbortError', `${type} 取消正在读取的请求，停止重试`);
    });
    await requestSeen;
    controller.abort();
    await rejected;
  }
} finally {
  stalled.closeAllConnections();
  await new Promise(resolve => stalled.close(resolve));
}

// 元数据请求禁用重试时，429 也不能再进入漫长退避。
let limitedRequests = 0;
const limited = http.createServer((_req, res) => {
  limitedRequests++;
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end('{"code":"System Error"}');
});
limited.listen(0, '127.0.0.1');
await once(limited, 'listening');
try {
  const client = new HttpClient({ minIntervalMs: 0, verbose: false });
  const result = await client.getJson(`http://127.0.0.1:${limited.address().port}`, {}, { maxRetries: 0 });
  ok(result.status === 429 && limitedRequests === 1, '元数据禁用重试时限流响应立即返回，只请求一次');
} finally {
  await new Promise(resolve => limited.close(resolve));
}

let redirectHits = 0;
const redirect = http.createServer((_req, res) => {
  redirectHits++;
  res.writeHead(302, { location: `http://127.0.0.1:${redirect.address().port}/loop` });
  res.end();
});
redirect.listen(0, '127.0.0.1');
await once(redirect, 'listening');
try {
  await httpsGet(`http://127.0.0.1:${redirect.address().port}/loop`).then(
    () => { throw new Error('重定向循环不应成功'); },
    e => {
      ok(e.code === 'REDIRECT_LOOP' && redirectHits === 1, '重定向循环立即停止，不重复请求');
    },
  );
} finally {
  await new Promise(resolve => redirect.close(resolve));
}

// Steam/代理可能返回单层或组合 Content-Encoding；网络层必须把压缩正文还原后再交给 HTML/JSON 解析器。
const compressed = http.createServer((req, res) => {
  const payload = req.url === '/json' ? '{"ok":true,"source":"steam"}' : '<html><script id="valve-ssr-data">{"listings":[]}</script></html>';
  if (req.url === '/combo') {
    const gzip = zlib.gzipSync(Buffer.from(payload));
    const body = zlib.brotliCompressSync(gzip);
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip, br' });
    res.end(body);
    return;
  }
  const body = req.url === '/json'
    ? zlib.deflateSync(Buffer.from(payload))
    : zlib.gzipSync(Buffer.from(payload));
  res.writeHead(200, {
    'content-type': req.url === '/json' ? 'application/json' : 'text/html',
    'content-encoding': req.url === '/json' ? 'deflate' : 'gzip',
  });
  res.end(body);
});
compressed.listen(0, '127.0.0.1');
await once(compressed, 'listening');
try {
  const base = `http://127.0.0.1:${compressed.address().port}`;
  const page = await httpsGet(`${base}/html`);
  const json = await httpsGet(`${base}/json`);
  const combo = await httpsGet(`${base}/combo`);
  ok(page.body.includes('valve-ssr-data'), 'gzip Steam 页面先解压再解析 SSR 数据');
  ok(JSON.parse(json.body).source === 'steam', 'deflate Steam JSON 先解压再解析');
  ok(combo.body.includes('valve-ssr-data'), '组合 Content-Encoding 按逆序完整解压');
} finally {
  await new Promise(resolve => compressed.close(resolve));
}

// 运行真实 Web 端点；CS2UP 请求故意悬挂，取消必须终止它并立即允许重搜。
const portProbe = http.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const serverPath = new URL('../src/web/server.mjs', import.meta.url).href;
const child = spawn(process.execPath, ['--input-type=module', '-e', `
  globalThis.fetch = (_url, {signal}) => new Promise((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  });
  await import(${JSON.stringify(serverPath)});
`], { env: { ...process.env, CS2_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
const ready = new Promise((resolve, reject) => {
  child.stdout.on('data', data => {
    output += data;
    if (output.includes('已启动')) resolve();
  });
  child.once('error', reject);
  child.once('exit', code => reject(new Error(`测试服务退出 ${code}`)));
});
const streams = [];
const base = `http://127.0.0.1:${port}`;
const openSearch = async id => {
  const result = await fetch(`${base}/api/hunt?url=7928752d714f8e31&wear=0.2&task_id=${id}`);
  const reader = result.body.getReader();
  streams.push(reader);
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
};
try {
  await ready;
  ok((await openSearch('old')).includes('event: stage'), '真实端点开始搜索');
  const cancel = await fetch(`${base}/api/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'old' }) });
  ok((await cancel.json()).cancelled, '停止端点取消旧任务');
  ok((await openSearch('new')).includes('event: stage'), '停止后立即重搜成功，不再报已有任务');
  const stale = await fetch(`${base}/api/cancel`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'old' }) });
  ok(!(await stale.json()).cancelled, '迟到取消请求不影响新搜索');
  ok((await openSearch('overlap')).includes('已有任务在跑'), '旧任务清理后新任务仍占有锁');
} finally {
  await Promise.allSettled(streams.map(reader => reader.cancel()));
  child.kill();
  await once(child, 'exit');
}
