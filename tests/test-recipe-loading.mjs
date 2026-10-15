import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const elements = Object.fromEntries(['link', 'stattrak', 'qualityNote', 'targetOutput', 'go', 'stop',
  'next', 'continue', 'eta', 'randomPages', 'wear', 'interval', 'insecure', 'proxy',
  'exterior_fn', 'exterior_mw', 'exterior_ft', 'exterior_ww', 'exterior_bs'].map(id => [id, {
  value: '', checked: false, style: {}, addEventListener(type, fn) { this[type] = fn; },
}]));
elements.wear.value = '0.2'; elements.randomPages.value = '20'; elements.exterior_ft.checked = true;
const requests = [], timers = new Map(), searches = [], messages = [];
let timerId = 0;
const page = vm.createContext({
  document: { getElementById: id => elements[id] }, AbortController, URLSearchParams,
  crypto: { randomUUID: () => 'recipe-loading-test' },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  setInterval: () => 1, clearInterval() {},
  EventSource: class { constructor(url) { searches.push(url); } addEventListener() {} close() {} },
  statusLine: message => messages.push(message), reset() {}, renderLocated() {}, renderResult() {},
});
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
vm.runInContext(between('const $ =', 'function statusLine') +
  between('let qualitySid', "let MARKET = 'buff';") +
  between("let MARKET = 'buff';", "$('stop').onclick = stopSearch;") +
  between("$('go').onclick =", 'function openBuyPanel'), page);

const startReading = sid => {
  elements.link.value = sid; elements.link.input();
  const [id, fn] = [...timers].at(-1); timers.delete(id);
  return fn();
};
const respond = async (pending, data) => {
  requests.at(-1).resolve({ json: async () => data }); await pending;
};
const outputs = [
  { name: '未知产物', probability: 0.1, range: null, unavailableReason: '缺少完整磨损区间' },
  { name: 'AK-47 | 突破', probability: 0.45, range: [0, 0.75] },
  { name: 'M4A1 消音型 | 隐伏帝王龙', probability: 0.02, range: [0, 0.8] },
];
let pending = startReading('https://cs2up.cn/share.html?sid=6cc935885d8238ab\u00a0');
elements.go.onclick();
assert.equal(searches.length, 0);
assert.match(messages.at(-1), /正在读取/);
await respond(pending, { ok: true, statTrak: false, outputs });
assert.equal(elements.stattrak.checked, false);
assert.equal(elements.targetOutput.value, '1');
assert.equal(elements.targetOutput.disabled, false);
assert.match(elements.targetOutput.innerHTML, /value="0" disabled/);
assert.match(elements.targetOutput.innerHTML, /45.00%/);
elements.go.onclick();
let params = new URL(searches.at(-1), 'http://localhost').searchParams;
assert.equal(params.get('stattrak'), '0');
assert.equal(params.get('output_index'), '1');
elements.targetOutput.value = '2'; elements.targetOutput.change();
elements.stattrak.checked = true; elements.stattrak.change(); elements.go.onclick();
params = new URL(searches.at(-1), 'http://localhost').searchParams;
assert.equal(params.get('stattrak'), '1');
assert.equal(params.get('output_index'), '2');
console.log('✓ 页面自动选可用产物，保留概率与索引，搜索明确传递默认品质和手动覆盖');

pending = startReading('bbbbbbbbbbbbbbbb');
elements.stattrak.checked = true; elements.stattrak.change();
await respond(pending, { ok: false, message: '配方不存在或已失效' });
assert.match(elements.qualityNote.textContent, /配方不存在或已失效/);
const beforeRetry = requests.length, beforeSearch = searches.length;
elements.go.onclick();
assert.equal(requests.length, beforeRetry + 1);
assert.equal(searches.length, beforeSearch);
assert.match(messages.at(-1), /正在重试/);
requests.at(-1).resolve({ json: async () => ({ ok: true, statTrak: false, outputs }) });
// retry is intentionally launched by the synchronous click handler.
await new Promise(resolve => setTimeout(resolve, 0));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(elements.targetOutput.disabled, false);
assert.equal(elements.stattrak.checked, true);
elements.go.onclick();
assert.equal(searches.length, beforeSearch + 1);
assert.equal(new URL(searches.at(-1), 'http://localhost').searchParams.get('stattrak'), '1');
console.log('✓ 读取失败显示具体原因，点击搜索可重试；手动品质不会掩盖错误或被重试覆盖');

pending = startReading('cccccccccccccccc');
await respond(pending, { ok: true, statTrak: false, outputs: [outputs[0]] });
assert.equal(elements.targetOutput.disabled, true);
const beforeUnavailable = searches.length;
elements.go.onclick();
assert.equal(searches.length, beforeUnavailable);
assert.match(messages.at(-1), /暂无可用目标产物/);
const oldPending = startReading('dddddddddddddddd'), oldRequest = requests.at(-1);
pending = startReading('eeeeeeeeeeeeeeee');
await respond(pending, { ok: true, statTrak: true, outputs });
oldRequest.resolve({ json: async () => ({ ok: false, message: '旧链接失败' }) }); await oldPending;
assert.equal(elements.stattrak.checked, true);
assert.doesNotMatch(elements.qualityNote.textContent, /旧链接失败/);
console.log('✓ 全部区间缺失有明确提示；旧链接迟到失败不污染新链接状态');
