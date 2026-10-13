/**
 * CS2 检视链接解码器（零依赖，纯 protobuf 解析）。
 *
 * 背景：CSGOFloat 官方仓库已声明自 2026-03 起废弃其解码服务，因为
 * 「所有 CS2 检视链接现在自包含物品信息」。也就是说，
 * 形如 steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20M<listingid>A<assetid>D<protobuf>
 * 的链接里，末尾 D 参数就是 CEconItemPreviewDataBlock 的 protobuf 编码，
 * 其中 paintwear 字段（field 7, float）就是该饰品的精确磨损。
 *
 * 于是不需要任何 bot 账号或第三方服务，直接本地解码即可。
 *
 * 关键实现细节：protobuf 的 `float` 是 4 字节 **小端** 的 IEEE754 单精度。
 * 而 field 7 是 float 类型，按其 wire type（5 = 32-bit）读取，
 * **不能**当 varint 解 —— 这是最容易写错的地方。
 */

/** protobuf wire types */
const WT_VARINT = 0, WT_64BIT = 1, WT_LEN = 2, WT_32BIT = 5;

/**
 * 十六进制字符串 → Buffer
 */
export function hexToBuffer(hex) {
  const s = String(hex).trim();
  if (s.length % 2) throw new Error('十六进制长度必须是偶数');
  return Buffer.from(s, 'hex');
}

/** 从 Buffer 读一个 varint，返回 [值, 新偏移] */
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint 过长');
  }
  return [result, p];
}

/** 用 BigInt 安全转 Number（这些字段都远小于 2^53） */
function toNum(big) {
  if (big <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(big);
  return big.toString();
}

/**
 * 解析 CEconItemPreviewDataBlock。
 * 字段号（来自 SteamDatabase/GameTracking-CS2 的 cstrike15_gcmessages.proto）：
 *   1  itemid           uint64
 *   2  defindex         uint32
 *   3  paintindex       uint32
 *   4  rarity           uint32
 *   5  quality          uint32
 *   6  paintwear        uint32（已废弃，早期存的是位模式）
 *   7  paintseed        uint32
 *   8  killeaterscoretype uint32
 *   9  killeatervalue   uint32
 *   10 customname       string
 *   11 stickers         repeated
 *   12 inventory        uint32
 *   13 origin           uint32
 *   14 questid          uint32
 *   15 dropreason       uint32
 *   16 musicindex       uint32
 *   17 entindex         int32
 *   18 petindex         uint32
 *   19 keychains        repeated
 *   20 style            uint32
 *   21 variations       repeated
 * 注意：不同版本里 paintwear 的字段号有变动，所以这里**同时**对
 * 「float 类型字段」和已知候选字段号做提取，并用合理性（0..1）交叉验证。
 */
export function parseInspectProtobuf(buf) {
  const out = {};
  const floats = [];
  let pos = 0;

  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wt = Number(key & 7n);

    if (wt === WT_VARINT) {
      let v;
      [v, pos] = readVarint(buf, pos);
      out[field] = toNum(v);
    } else if (wt === WT_32BIT) {
      const raw = buf.readUInt32LE(pos);
      const asFloat = buf.readFloatLE(pos);
      floats.push({ field, raw, asFloat });
      if (out[field] === undefined) out[field] = raw;
      pos += 4;
    } else if (wt === WT_64BIT) {
      const raw = buf.readBigUInt64LE(pos);
      if (out[field] === undefined) out[field] = raw.toString();
      pos += 8;
    } else if (wt === WT_LEN) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      out[field] = buf.subarray(pos, pos + n).toString('utf8');
      pos += n;
    } else {
      throw new Error(`不支持的 wire type ${wt}（字段 ${field}）`);
    }
  }

  // 找出磨损值：优先取「落在 (0,1] 的 float 字段」
  const wearCandidates = floats.filter(f => f.asFloat > 0 && f.asFloat <= 1);
  let floatvalue = null;
  let wearField = null;
  if (wearCandidates.length) {
    // 取字段号最大的那个作为磨损（实际协议里 paintwear 排在 seed 之后的新版本）
    const pick = wearCandidates[wearCandidates.length - 1];
    floatvalue = pick.asFloat;
    wearField = pick.field;
  }

  return {
    fields: out,
    floats,
    floatvalue,
    wearField,
    defindex: typeof out[2] === 'number' ? out[2] : null,
    paintindex: typeof out[3] === 'number' ? out[3] : null,
    paintseed: typeof out[7] === 'number' ? out[7] : null,
    itemid: out[1] != null ? String(out[1]) : null,
    raw: buf.toString('hex'),
  };
}

/**
 * 从检视链接里抽出 D 参数并解码。
 * 支持完整 URL，也支持只有 D 后面的 hex。
 */
export function decodeInspectLink(link) {
  const s = String(link || '').trim();
  if (!s) return { ok: false, error: 'empty' };

  // D 参数出现在链接末尾，但可能后面还跟别的东西，所以不强求 $；
  // 取最后一个 D 后面的连续 hex（链接里 S/A/D/M 都用十六进制）
  let hex = null;
  const all = [...s.matchAll(/[Dd]([0-9A-Fa-f]{8,})/g)];
  if (all.length) hex = all[all.length - 1][1];
  else if (/^[0-9A-Fa-f]{16,}$/.test(s)) hex = s;
  if (!hex) return { ok: false, error: 'no_D_param' };

  try {
    const buf = hexToBuffer(hex);
    const parsed = parseInspectProtobuf(buf);
    return {
      ok: true,
      hex,
      byteLength: buf.length,
      ...parsed,
    };
  } catch (e) {
    return { ok: false, error: e.message, hex };
  }
}

/**
 * 从检视链接里抽出 S/A/D/M 四个参数。
 *
 * 坑：S/A/D/M 本身就是十六进制字母，用 [0-9A-Fa-f]+ 贪心匹配会把下一个参数一起吞掉
 * （例如 A 会把后面的 D 和它的值也算进去）。而且 D 的值里本身就可能含 D/E/F。
 *
 * 处理办法：**D 永远在最后**，所以先把 D 用 `D([0-9A-Fa-f]+)$` 从尾部摘掉，
 * 剩下的前缀里再按顺序找 S / A / M。
 */
export function parseInspectIds(link) {
  const s = String(link || '');
  const body = s.replace(/^.*csgo_econ_action_preview(%20|\s)?/i, '');
  const out = { s: null, a: null, d: null, m: null };

  let rest = body;
  const dm = body.match(/D([0-9A-Fa-f]+)\s*$/i);
  if (dm) {
    out.d = dm[1];
    rest = body.slice(0, body.length - dm[0].length);
  }
  for (const key of ['S', 'A', 'M']) {
    const others = ['S', 'A', 'M'].filter(k => k !== key).join('');
    const re = new RegExp(`${key}([0-9A-Fa-f]*?)(?=[${others}]|$)`, 'i');
    const m = rest.match(re);
    if (m && m[1]) out[key.toLowerCase()] = m[1];
  }
  return out;
}

/**
 * 构造 Steam 市场「直接指向该笔挂单」的链接。
 * 新版 Steam 用 detail 参数加载 initialSelectedListing，打开该笔挂单详情。
 * listing 参数会被忽略，只显示商品的所有出售单。
 */
export function steamListingUrl(marketHashName, listingId) {
  const base = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHashName)}`;
  return listingId ? `${base}?detail=${encodeURIComponent(listingId)}` : base;
}
