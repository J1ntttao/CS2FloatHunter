/**
 * CS2UP 配方读取器。
 *
 * 用户给的是配方广场里的分享链接，形如：
 *   https://cs2up.cn/share.html?sid=7928752d714f8e31
 *
 * 实测（ref/cs2up/share.js:91）该页面会调：
 *   GET /api/share-payloads?id=<sid>
 * 返回完整配方，包括：
 *   - 10 把材料的**名称 + 目标磨损(wear) + 收藏品 + 单价**
 *   - 产物列表 outputs[]（name/cn/collection/probability/expected_wear/price）
 *   - 稀有度（input_rarity_label → output_rarity_label）
 *
 * 注意：接口**不返回磨损区间**（min/max wear），所以产物的区间要另行解析
 * （本项目用 BUFF 的 /api/market/goods/info 拿 paintwear_range）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CS2UP = 'https://cs2up.cn';

/** 中文稀有度 → 内部代号（与本项目其他模块一致） */
export const RARITY_CN_TO_KEY = {
  消费级: 'consumer',
  工业级: 'industrial',
  军规级: 'milspec',
  受限级: 'restricted',
  受限: 'restricted',
  保密级: 'classified',
  保密: 'classified',
  隐秘级: 'covert',
  隐秘: 'covert',
  违禁: 'contraband',
};

/**
 * 从任意形式的输入里抽出 sid。
 * 支持：完整 URL、带/不带协议、只有 sid 本身。
 */
export function extractSid(input) {
  if (!input) return null;
  const s = String(input).trim();
  // 直接就是 16 位 hex
  if (/^[0-9a-f]{16}$/i.test(s)) return s.toLowerCase();
  const m = s.match(/[?&]sid=([0-9a-fA-F]{8,64})/);
  if (m) return m[1].toLowerCase();
  // 兜底：URL 里任意位置的 sid
  const m2 = s.match(/sid[=/]([0-9a-fA-F]{8,64})/i);
  return m2 ? m2[1].toLowerCase() : null;
}

/** 拉取分享配方 */
export async function fetchShareRecipe(input, { timeoutMs = 25000 } = {}) {
  const sid = extractSid(input);
  if (!sid) {
    return { ok: false, error: 'invalid_sid', message: '链接里找不到 sid。正确形式：https://cs2up.cn/share.html?sid=xxxxxxxxxxxxxxxx' };
  }
  let res, text;
  try {
    res = await fetch(`${CS2UP}/api/share-payloads?id=${encodeURIComponent(sid)}`, {
      headers: { 'user-agent': UA, accept: 'application/json', referer: `${CS2UP}/share.html?sid=${sid}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: 'network', message: `请求 CS2UP 失败：${e.message}` };
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }

  if (!json) {
    return { ok: false, error: 'bad_response', message: `CS2UP 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}` };
  }
  if (json.ok === false || !json.item?.payload) {
    return {
      ok: false,
      error: 'not_found',
      message: `配方不存在或已失效（HTTP ${res.status}）：${json.error || '未知原因'}`,
    };
  }

  const p = json.item.payload;
  const mats = Array.isArray(p.materials) ? p.materials : [];
  if (!mats.length) return { ok: false, error: 'empty_recipe', message: '该配方里没有材料数据。' };

  // 按“同名同磨损”归并，得到“需要 N 把 wear=X 的某材料”
  const merged = new Map();
  for (const m of mats) {
    const key = `${m.cn || m.name}|${m.wear}`;
    if (!merged.has(key)) {
      merged.set(key, {
        nameEn: m.name,
        name: m.cn || m.name,
        collection: m.collection || null,
        wear: Number(m.wear),
        unitPrice: m.unit_price != null ? Number(m.unit_price) : null,
        image: m.image || null,
        count: 0,
      });
    }
    merged.get(key).count++;
  }

  const outputs = (Array.isArray(p.outputs) ? p.outputs : []).map(o => ({
    nameEn: o.name,
    name: o.cn || o.name,
    collection: o.collection || null,
    probability: o.probability != null ? Number(o.probability) : null,
    expectedWear: o.expected_wear != null ? Number(o.expected_wear) : null,
    price: o.price != null ? Number(o.price) : null,
  }));

  const totalCount = mats.length;
  const targetWear = outputs[0]?.expectedWear ?? null;

  return {
    ok: true,
    sid,
    detailId: json.item.detail_id || null,
    title: p.title || null,
    subtitle: p.subtitle || null,
    recipeLine: p.recipe_line || null,
    matchup: p.matchup || null,
    statTrak: !!p.stattrak,
    inputRarityLabel: p.input_rarity_label || null,
    outputRarityLabel: p.output_rarity_label || null,
    inputRarity: RARITY_CN_TO_KEY[p.input_rarity_label] || null,
    outputRarity: RARITY_CN_TO_KEY[p.output_rarity_label] || null,
    collections: Array.isArray(p.collections) ? p.collections : [],
    metrics: p.metrics || null,
    totalCount,
    targetWear,
    materials: [...merged.values()],
    outputs,
    raw: p,
  };
}
