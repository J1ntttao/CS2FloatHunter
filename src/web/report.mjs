/**
 * 生成自包含的可视化 HTML（无外部依赖，可直接双击打开）。
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => (v == null || !Number.isFinite(v)) ? '-' : '¥' + Number(v).toFixed(2);
const wear = v => (v == null || !Number.isFinite(v)) ? '-' : Number(v).toFixed(10);

const RARITY_LABEL = {
  consumer: '消费级', industrial: '工业级', milspec: '军规级',
  restricted: '受限', classified: '保密', covert: '隐秘',
};

function materialRow(m, idx) {
  const name = esc(m.name || m.marketHashName || '未知');
  const rg = Array.isArray(m.matRange) ? `[${m.matRange[0]} ~ ${m.matRange[1]}]` : '-';
  const links = [];
  if (m.buyUrl || m.url) links.push(`<a class="buy" href="${esc(m.buyUrl || m.url)}" target="_blank" rel="noopener">购买</a>`);
  if (m.inspectUrl) links.push(`<a class="insp" href="${esc(m.inspectUrl)}" target="_blank" rel="noopener">检视</a>`);
  const coll = m.collectionName ? `<div class="coll">${esc(m.collectionName)}</div>` : '';
  return `<tr>
    <td class="idx">${idx + 1}</td>
    <td class="nm">${name}${coll}</td>
    <td class="fl">${wear(m.paintwear)}</td>
    <td class="rg">${rg}</td>
    <td class="nr">${m.norm != null ? Number(m.norm).toFixed(10) : '-'}</td>
    <td class="pr">${money(m.price)}</td>
    <td class="mk">${esc(m.market)}</td>
    <td class="lnk">${links.join(' ') || '-'}</td>
  </tr>`;
}

function outputsBlock(r) {
  if (!r.outputs || !r.outputs.length) return '';
  const multi = r.outputs.length > 1;
  const rows = r.outputs.map(o => `<tr>
      <td class="onm">${esc(o.collectionName || o.collection)}</td>
      <td class="ocnt">${o.count} 把</td>
      <td class="oprob">${(o.probability * 100).toFixed(1)}%</td>
      <td class="owear">${wear(o.wear)}</td>
    </tr>`).join('');
  return `<div class="dist${multi ? '' : ' single'}">
    <div class="dist-h">${multi ? `产物分布（${r.outputs.length} 个收藏品随机出）` : '产物（确定）'}</div>
    <table class="dist-t">
      <thead><tr><th>产物收藏品</th><th>投入</th><th>概率</th><th>产物磨损</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function recipeCard(r, i) {
  const badge = r.exact
    ? '<span class="badge exact">★ 精确命中</span>'
    : `<span class="badge near">误差 ${r.score.toExponential(2)}</span>`;
  return `<section class="card">
    <header class="card-h">
      <h2>配方 #${i + 1}</h2>
      ${badge}
      <div class="kpis">
        <div><span>产物磨损</span><strong>${wear(r.outputWear)}</strong></div>
        <div><span>材料总价</span><strong>${money(r.cost)}</strong></div>
        <div><span>材料数</span><strong>${r.materials.length}</strong></div>
      </div>
    </header>
    ${outputsBlock(r)}
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>材料</th><th>磨损值 (float32)</th><th>材料区间</th><th>归一化值</th><th>价格</th><th>平台</th><th>链接</th></tr></thead>
        <tbody>${r.materials.map(materialRow).join('')}</tbody>
      </table>
    </div>
    <div class="order">按此顺序依次放入炉子：${r.materials.map((m, k) => `<b>${k + 1}</b>`).join(' → ')}</div>
  </section>`;
}

export function renderHtml(payload) {
  const { request, ieee754, requiredAvgWear, recipes, poolSize, exactFound, generatedAt } = payload;
  const rl = RARITY_LABEL[request.rarity] || request.rarity;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CS2 炼金配方 · 目标磨损 ${esc(request.target)}</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --line:#2a3240;
    --fg:#e6edf3; --dim:#8b98a8; --acc:#f0a020; --ok:#3fb950; --warn:#d29922;
    --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
  h1{margin:0 0 4px;font-size:22px;letter-spacing:.5px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .hero{background:linear-gradient(135deg,#1a2130,#12161d);border:1px solid var(--line);
    border-radius:12px;padding:20px;margin-bottom:22px}
  .hero-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px}
  .kv span{display:block;color:var(--dim);font-size:12px;margin-bottom:3px}
  .kv strong{font-family:var(--mono);font-size:15px;font-weight:600}
  .kv strong.big{font-size:19px;color:var(--acc)}
  .note{margin-top:14px;padding:10px 12px;border-radius:8px;font-size:12.5px;
    background:#3a2d10;border:1px solid #6b5316;color:#f2cc60}
  .note.ok{background:#0f2a17;border-color:#1c5b2c;color:#7ee787}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    margin-bottom:18px;overflow:hidden}
  .card-h{padding:14px 18px;background:var(--panel2);border-bottom:1px solid var(--line);
    display:flex;flex-wrap:wrap;align-items:center;gap:14px}
  .card-h h2{margin:0;font-size:16px}
  .badge{font-size:12px;padding:3px 9px;border-radius:999px;font-weight:600}
  .badge.exact{background:#0f2a17;color:#7ee787;border:1px solid #238636}
  .badge.near{background:#3a2d10;color:#f2cc60;border:1px solid #6b5316}
  .kpis{margin-left:auto;display:flex;gap:22px}
  .kpis div{text-align:right}
  .kpis span{display:block;color:var(--dim);font-size:11px}
  .kpis strong{font-family:var(--mono);font-size:13.5px}
  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:9px 14px;color:var(--dim);font-weight:500;font-size:12px;
    border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:9px 14px;border-bottom:1px solid #1e2531}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#1a2130}
  td.idx{color:var(--dim);width:38px}
  td.nm{font-weight:500}
  td.fl,td.pr,td.nr{font-family:var(--mono);white-space:nowrap}
  td.pr{color:var(--acc);text-align:right}
  td.nr{color:#7ee787}
  td.rg{color:var(--dim);font-family:var(--mono);font-size:11.5px;white-space:nowrap}
  td.mk{color:var(--dim);font-size:12px}
  .order{padding:11px 18px;background:#101620;color:var(--dim);font-size:12px;
    border-top:1px solid var(--line);font-family:var(--mono)}
  .order b{color:var(--acc)}
  td.lnk{white-space:nowrap}
  td.lnk a{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;
    text-decoration:none;margin-right:4px;border:1px solid transparent}
  a.buy{background:#12351f;color:#7ee787;border-color:#238636}
  a.buy:hover{background:#1a4d2c}
  a.insp{background:#1a2436;color:#79c0ff;border-color:#1f6feb}
  a.insp:hover{background:#22304a}
  td.nm .coll{color:var(--dim);font-size:11px;font-weight:400;margin-top:2px}
  .dist{border-bottom:1px solid var(--line);background:#101620;padding:12px 18px}
  .dist.single{background:#0f1a14}
  .dist-h{color:var(--dim);font-size:12px;margin-bottom:8px}
  .dist-t{width:100%;border-collapse:collapse;font-size:12.5px}
  .dist-t th{text-align:left;padding:4px 10px;color:var(--dim);font-weight:500;
    font-size:11px;border-bottom:1px solid var(--line)}
  .dist-t td{padding:5px 10px;border-bottom:1px solid #1a2130}
  .dist-t tr:last-child td{border-bottom:none}
  td.oprob{color:var(--acc);font-family:var(--mono);font-weight:600}
  td.owear,td.ocnt{font-family:var(--mono);color:var(--dim)}
  td.onm{font-weight:500}
  footer{color:var(--dim);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:14px}
  .empty{color:var(--dim);text-align:center;padding:40px}
</style>
</head>
<body>
<div class="wrap">
  <h1>CS2 目标磨损炼金配方</h1>
  <div class="sub">生成于 ${esc(generatedAt)} · 数据源：BUFF163 实时挂单</div>

  <div class="hero">
    <div class="hero-grid">
      <div class="kv"><span>目标产物磨损</span><strong class="big">${esc(request.target)}</strong></div>
      <div class="kv"><span>产物磨损区间</span><strong>[${esc(request.outMin)}, ${esc(request.outMax)}]</strong></div>
      <div class="kv"><span>材料稀有度</span><strong>${esc(rl)}</strong></div>
      <div class="kv"><span>材料数量</span><strong>${esc(request.count)}</strong></div>
      <div class="kv"><span>需要材料平均磨损</span><strong>${Number(requiredAvgWear).toFixed(10)}</strong></div>
      <div class="kv"><span>目标归一化总和</span><strong>${payload.requiredNormalizedSum != null ? Number(payload.requiredNormalizedSum).toFixed(10) : '-'}</strong></div>
      <div class="kv"><span>候选挂单池</span><strong>${esc(poolSize)}</strong></div>
      <div class="kv"><span>float32 可表示值</span><strong>${esc(ieee754.asFloat32)}</strong></div>
      <div class="kv"><span>求解结果</span><strong>${exactFound ? '精确命中' : '近似最优'}</strong></div>
    </div>
    ${ieee754.exact
      ? `<div class="note ok">你输入的目标磨损在 IEEE754 单精度下可精确表示。</div>`
      : `<div class="note">注意：你输入的目标磨损在 IEEE754 单精度下<b>不存在</b>，游戏里实际会被吸附到
         <b>${esc(ieee754.asFloat32)}</b>（可表示间距约 ${Number(ieee754.spacing).toExponential(3)}）。本页按该可表示值求解。</div>`}
  </div>

  ${recipes.length
    ? recipes.map(recipeCard).join('')
    : '<div class="empty">没有找到可用配方。</div>'}

  <footer>
    计算引擎：<b>西林磨损计算器</b>（68688888.github.io）的官方算法，已与其源码逐位对齐
    （<code>tests/test-vs-site.mjs</code>，46,000 组随机用例零偏差）。<br>
    每把材料先按<b>它自己的磨损区间</b>归一化，再取平均：
    <code>normalized = (wear − 材料min) / (材料max − 材料min)</code>，
    然后 <code>产物磨损 = float32(产物min + float32(平均归一化值 × float32(产物max − 产物min)))</code>。<br>
    材料磨损取自平台挂单的实际字段（BUFF 的 <code>asset_info.paintwear</code> / 悠悠的 <code>Abrade</code>）。
    市场有手续费与成交滑点，且挂单可能随时被别人买走，请尽快按顺序购入。
  </footer>
</div>
</body>
</html>`;
}
