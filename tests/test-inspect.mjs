/**
 * 检视链接解码器测试。
 *
 * 重要：CSGOFloat 官方 README 里给的示例链接（如 `...D9403672490970763167`）
 * **是示意性的**，其 D 参数长度为奇数、不是合法十六进制，无法解码。
 * 所以这里不拿它们当"真值"，而是：
 *   1. 用逐字段构造的合法 protobuf 验证解码正确性
 *   2. 覆盖官方 README 明确给出的那个已知结果 0.22740158438682556
 *   3. 覆盖几个"著名特殊磨损"，确认 float32 语义正确
 */

import { decodeInspectLink, parseInspectIds, parseInspectProtobuf, steamListingUrl, hexToBuffer } from '../src/market/inspect.mjs';
import { f32 } from '../src/tradeup/float.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  cond ? pass++ : fail++;
};

/** 构造一个合法的 CEconItemPreviewDataBlock */
function buildInspectHex({ itemid = 13874827217, defindex, paintindex, rarity = 5, quality = 4, paintseed, paintwear }) {
  const parts = [];
  // 注意：itemid 会超过 2^32，不能用 >>> 位移，必须走 BigInt，否则被截断
  const varintBig = n => {
    let v = BigInt(n);
    const o = [];
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v);
    return o;
  };
  const pushV = (f, v) => parts.push(...varintBig((BigInt(f) << 3n) | BigInt(v >= 0 && v < 128 ? 0 : 0)), ...varintBig(v));
  // 上面那种写法容易绕，改成直白的：key = (field<<3)|wiretype
  parts.length = 0;
  const pushField = (field, wireType, value) => {
    parts.push(...varintBig((BigInt(field) << 3n) | BigInt(wireType)));
    if (wireType === 0) parts.push(...varintBig(value));
  };
  pushField(1, 0, itemid);
  pushField(2, 0, defindex);
  pushField(3, 0, paintindex);
  pushField(4, 0, rarity);
  pushField(5, 0, quality);
  pushField(7, 0, paintseed);
  parts.push(...varintBig((8n << 3n) | 5n));   // field 8, wire type 5 = 32-bit
  const fb = Buffer.alloc(4); fb.writeFloatLE(f32(paintwear), 0);
  parts.push(...fb);
  return Buffer.from(parts).toString('hex');
}

console.log('=== 1. 已知结果：官方 README 的示例值 0.22740158438682556 ===');
{
  const hex = buildInspectHex({ defindex: 7, paintindex: 282, paintseed: 361, paintwear: 0.22740158438682556 });
  const p = parseInspectProtobuf(hexToBuffer(hex));
  check('floatvalue 精确等于 0.22740158438682556', p.floatvalue === 0.22740158438682556, `got=${p.floatvalue}`);
  check('defindex = 7', p.defindex === 7);
  check('paintindex = 282', p.paintindex === 282);
  check('paintseed = 361', p.paintseed === 361);
}

console.log('\n=== 2. 著名特殊磨损（float32 语义）===');
{
  for (const target of [0.06666666, 0.008888888, 0.9999999, 0.0000001, 0.5]) {
    const hex = buildInspectHex({ defindex: 60, paintindex: 1143, paintseed: 1, paintwear: target });
    const p = parseInspectProtobuf(hexToBuffer(hex));
    const want = f32(target);
    check(`paintwear ${target} → ${want}`, p.floatvalue === want, `got=${p.floatvalue}`);
  }
}

console.log('\n=== 3. protobuf 边界：大数值字段不被截断 ===');
{
  const parts2 = [];
  const hex = buildInspectHex({ itemid: 13874827217, defindex: 7, paintindex: 282, paintseed: 65535, paintwear: 0.25 });
  const p = parseInspectProtobuf(hexToBuffer(hex));
  check('大 varint（itemid）正确解出', String(p.itemid) === '13874827217', `got=${p.itemid}`);
  check('seed=65535（两字节 varint）', p.paintseed === 65535, `got=${p.paintseed}`);
}

console.log('\n=== 4. D/A/M 参数抽取（十六进制锚点不能贪心）===');
{
  const hex = buildInspectHex({ defindex: 7, paintindex: 282, paintseed: 1, paintwear: 0.25 });
  const link = `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20M2906459769049600931A18971892678D${hex}`;
  const ids = parseInspectIds(link);
  check('M 正确（不含 A/D）', ids.m === '2906459769049600931', `got=${ids.m}`);
  check('A 正确（不含 D）', ids.a === '18971892678', `got=${ids.a}`);
  check('D 正确', ids.d === hex, `got=${ids.d}`);
  const dec = decodeInspectLink(link);
  check('整条链接解码成功', dec.ok === true, dec.error || '');
  check('解码 float = 0.25', dec.floatvalue === 0.25, `got=${dec.floatvalue}`);
}

console.log('\n=== 5. Steam 购买链接构造 ===');
{
  const u = steamListingUrl('AK-47 | Redline (Field-Tested)', '2906459769049600931');
  check('包含 URL 编码的商品名', u.includes('AK-47%20%7C%20Redline%20(Field-Tested)'), u);
  const parsedUrl = new URL(u);
  check('detail 参数保留完整挂单 ID，打开该笔详情',
    parsedUrl.searchParams.get('detail') === '2906459769049600931' && !parsedUrl.searchParams.has('listing'), u);
}

console.log('\n=== 6. 异常输入不崩、不静默出错 ===');
{
  check('空串', decodeInspectLink('').ok === false);
  check('无 D 参数', decodeInspectLink('steam://rungame/730/1/+csgo_econ_action_preview%20M123A456').ok === false);
  check('奇数长度 hex（README 里的示意值）明确报错',
    decodeInspectLink('...D9403672490970763167').ok === false);
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
