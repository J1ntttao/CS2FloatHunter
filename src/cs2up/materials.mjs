/**
 * 收藏品材料库：把 ref/materials-data.js（西林磨损计算器自带的材料库）读进内存。
 *
 * 用途：给定「收藏品 + 稀有度」，列出该收藏品里所有符合条件的皮肤。
 *
 * 为什么不直接问 BUFF：实测 BUFF 的列表接口在同时给 itemset 与 rarity 时
 * **会忽略 rarity**（三种 rarity 返回完全相同的 186 条），所以必须自己按稀有度筛。
 * BUFF 的列表返回里也不带 itemset/rarity 标签，靠它反查反而更绕。
 *
 * 本库的 min/max 是整个皮肤的完整磨损范围，严格配方搜索用它归一化材料及产物。
 * BUFF 的 paintwear_range 可能只对应商品的外观档位（例如久经沙场 [0.15,0.38]），
 * 不能把档位区间当作完整皮肤区间参与炼金计算。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 中文稀有度（本项目/站点） → 内部代号 */
export const GRADE_CN = {
  consumer: '消费级', industrial: '工业级', milspec: '军规级',
  restricted: '受限级', classified: '保密级', covert: '隐秘级', ancient: '金色传说',
};

// CS2UP 使用 Steam/英文收藏品名，本地材料库使用中文名。新旧译名会并存，
// 因此集中维护别名，避免每条配方都依赖皮肤名称反查。
export const COLLECTION_ALIASES = {
  'the revolution collection': '变革收藏品',
  'the achroma collection': '墨彩收藏品',
  'the genesis collection': ['创世纪收藏品'],
  'the fracture collection': '裂空武器箱收藏品',
  'the shattered web collection': '“裂网大行动”收藏品',
  'the dead hand collection': '毁灭之手终端机',
  'the dead hand terminal': '毁灭之手终端机',
};

function normalizeCollectionLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[“”"'‘’]/g, '')
    .replace(/[\s·]/g, '')
    .replace(/(collection|收藏品|终端机)$/i, '');
}

let _db = null;

/** 载入材料库（带缓存） */
export function loadMaterialDb() {
  if (_db) return _db;
  const file = path.join(ROOT, 'ref', 'materials-data.js');
  if (!fs.existsSync(file)) throw new Error(`找不到材料库：${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__db = materialDatabase;', sandbox, { filename: 'materials-data.js' });
  const raw = sandbox.__db || {};
  _db = Object.entries(raw).map(([key, m]) => ({
    key,
    name: m.name,
    paintIndex: m.paint_index,
    min: Number(m.min),
    max: Number(m.max),
    grade: m.grade,
    collections: m.collections || [],
    crates: m.crates || [],
  }));
  return _db;
}

/** 列出所有收藏品名 */
export function listCollections() {
  const s = new Set();
  for (const m of loadMaterialDb()) for (const c of m.collections) s.add(c);
  return [...s].sort();
}

/**
 * 按收藏品 + 稀有度取皮肤清单。
 * @param {string} collectionName 例：'创世纪收藏品'
 * @param {string} grade          例：'restricted'
 */
export function materialsInCollection(collectionName, grade) {
  const db = loadMaterialDb();
  return db.filter(m =>
    m.collections.includes(collectionName) && (!grade || m.grade === grade));
}

/**
 * 把名字规整成可比较的形式：
 * 去掉中文全角/半角括号里的磨损后缀，统一空格，并把全角括号换成半角。
 */
export function normalizeName(name) {
  return String(name ?? '')
    .replace(/[（(]\s*(崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累)\s*[)）]\s*$/, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 统一 CS2UP/BUFF 常见的武器名称写法。
 * CS2UP 的中文翻译会把 M4A1-S 写成“ M4A1 消音型”，材料库沿用
 * BUFF 的“M4A1消音版”；两者指向同一个 paint index。
 */
function canonicalWeaponName(name) {
  return normalizeName(name)
    .replace(/^m4a1(?:\s*-\s*s|\s*消音(?:型|版))(?=\s*[|(])/, 'm4a1消音版')
    .replace(/^usp(?:\s*-\s*s|\s*消音(?:型|版))(?=\s*[|(])/, 'usp消音版');
}

/** 判断名字里是否含 StatTrak / 纪念品 / 匕首手套标记 */
export function nameFlags(name) {
  const s = String(name ?? '');
  return {
    statTrak: /StatTrak|暗金/i.test(s),
    souvenir: /纪念品|Souvenir/i.test(s),
    knifeOrGlove: s.includes('★'),
  };
}

/**
 * 用 BUFF 的实际名字去材料库里找匹配项（忽略磨损后缀）。
 * @returns {object|null}
 */
export function findInDbByBuffName(buffName) {
  const n = normalizeName(buffName);
  const db = loadMaterialDb();
  // 先精确（忽略磨损）
  let hit = db.find(m => normalizeName(m.name) === n);
  if (hit) return hit;
  // CS2UP 与 BUFF 的武器中文译名略有差异，先做武器别名归一化。
  const canonical = canonicalWeaponName(buffName);
  hit = db.find(m => canonicalWeaponName(m.name) === canonical);
  if (hit) return hit;
  // 再放宽：去掉 StatTrak 前缀等差异
  const strip = s => canonicalWeaponName(normalizeName(s)
    .replace(/\(\s*stattrak™?\s*\)/g, '')
    .replace(/stattrak™?|纪念品|souvenir/g, '').trim()).replace(/\s+/g, '');
  const n2 = strip(buffName);
  hit = db.find(m => strip(m.name) === n2);
  return hit || null;
}

/**
 * 用「该收藏品的若干皮肤名」反查本地库里的中文收藏品名。
 *
 * 场景：CS2UP 给的是英文收藏品名（The Genesis Collection），本地库是中文（创世纪收藏品），
 * 名字对不上。但这些皮肤的中文名（AWP | 可燃冰）在两边是一致的，
 * 所以拿皮肤名去反查它属于哪个收藏品，再用「材料档位」投票选出最可能的那个。
 *
 * @param {string[]} itemNames 该收藏品内的皮肤名（用中文名，忽略磨损后缀）
 * @param {string} grade      材料档位（内部代号），用于投票时加权
 * @returns {string|null}
 */
export function inferCollection(itemNames, grade) {
  const db = loadMaterialDb();
  const votes = new Map();
  for (const n of itemNames) {
    const hit = findInDbByBuffName(n);
    if (!hit) continue;
    for (const c of hit.collections) {
      votes.set(c, (votes.get(c) || 0) + 1);
    }
  }
  if (!votes.size) return null;

  // 有多个候选时，优先选「包含指定档位皮肤」的那个
  if (grade) {
    const withGrade = [...votes.entries()]
      .map(([c, v]) => [c, v, materialsInCollection(c, grade).length])
      .filter(([, , n]) => n > 0)
      .sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]));
    if (withGrade.length) return withGrade[0][0];
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 给定收藏品的英文/中文名，尽量在材料库里定位。
 * CS2UP 用的是英文名（The Genesis Collection），本地库是中文（创世纪收藏品），
 * 所以这里支持：精确中文、去后缀模糊、以及由调用方先用具体皮肤名反查出的中文名。
 */
export function findCollectionName(hint) {
  if (!hint) return null;
  const cols = listCollections();
  const exact = cols.find(c => c === hint);
  if (exact) return exact;
  const alias = COLLECTION_ALIASES[String(hint).trim().toLowerCase()];
  if (alias) {
    const candidates = Array.isArray(alias) ? alias : [alias];
    for (const candidate of candidates) {
      const hit = cols.find(c => normalizeCollectionLabel(c) === normalizeCollectionLabel(candidate));
      if (hit) return hit;
    }
  }
  // 同一收藏品在数据源之间可能只差引号、空格或“收藏品/终端机”后缀。
  const normalizedHint = normalizeCollectionLabel(hint);
  const normalized = cols.find(c => normalizeCollectionLabel(c) === normalizedHint);
  if (normalized) return normalized;
  const loose = cols.find(c => c.includes(hint) || hint.includes(c));
  return loose || null;
}
