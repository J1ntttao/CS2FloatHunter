import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 每次搜索独立文件，原子发布；列表不把完整挂单读进浏览器。 */
export class SearchResults {
  constructor(directory) { this.directory = directory; }
  validId(id) { return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id); }
  async save(result, request) {
    const id = randomUUID(), savedAt = new Date().toISOString();
    const document = { version: 1, id, savedAt, request, result };
    await fs.mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${id}.json`), temporary = filename + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(document), { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
    return { id, savedAt };
  }
  async get(id) {
    if (!this.validId(id)) return null;
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async list(limit = 50) {
    let files;
    try { files = await fs.readdir(this.directory); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const summaries = [];
    for (const file of files) {
      if (!file.endsWith('.json') || !this.validId(file.slice(0, -5))) continue;
      let item;
      try { item = await this.get(file.slice(0, -5)); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
      if (!item?.result) continue;
      const r = item.result;
      summaries.push({ id: item.id, savedAt: item.savedAt, targetOutput: r.targetOutput,
        targetWear: r.targetWear, market: r.market, exactFound: r.exactFound,
        costByCurrency: r.recipes?.[0]?.costByCurrency, optimization: r.optimization });
    }
    return summaries.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, limit);
  }
}
