import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchResults } from '../src/web/search-results.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-results-'));
try {
  const store = new SearchResults(directory);
  assert.deepEqual(await store.list(), []);
  const result = { targetOutput: '<target>', targetWear: 0.2, market: 'steam', exactFound: true,
    optimization: { proven: true }, recipes: [{ costByCurrency: [{ currencyId: 23, total: 1.01 }],
      materials: [{ listingId: '001', paintwear: 0.20000000298023224, buyUrl: 'https://steamcommunity.com/market/listings/730/test?detail=001' }] }] };
  const saved = await store.save(result, { link: 'sample', targetWear: 0.2 });
  const restarted = new SearchResults(directory);
  const record = await restarted.get(saved.id);
  assert.deepEqual(record.result, result);
  assert.deepEqual(record.request, { link: 'sample', targetWear: 0.2 });
  assert.equal((await restarted.list())[0].id, saved.id);
  assert.equal(await restarted.get('../cookies.manual.buff'), null);
  assert.equal(await restarted.get('not-a-uuid'), null);
  await Promise.all(Array.from({ length: 5 }, () => store.save(result, {})));
  assert.equal((await restarted.list()).length, 6);
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  console.log('✓ 自动保存、并发写入、重建实例读取、精确磨损与链接保留、路径校验');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
