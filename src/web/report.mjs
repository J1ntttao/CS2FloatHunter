/**
 * 生成自包含的可视化 HTML（无外部依赖，可直接双击打开）。
 * Dark Gallery 风格：#0A0A0A 暗场 / #1A1A1A 面 / #2A2A2A 线 / #C4956A 琥珀元信息
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
  return `<div class="dist">
    <div class="dist-h">${multi ? `产物分布（${r.outputs.length} 个收藏品随机出）` : '产物（确定）'}</div>
    <table class="dist-t"><thead><tr>
      <th>产物收藏品</th><th>投入</th><th>概率</th><th>产物磨损</th>
    </tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function recipeCard(r, i) {
  const badge = r.exact
    ? '<span class="badge exact">精确命中</span>'
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
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>材料</th><th>磨损值</th><th>材料区间</th><th>归一化值</th><th>价格</th><th>平台</th><th>链接</th></tr></thead>
      <tbody>${r.materials.map(materialRow).join('')}</tbody>
    </table></div>
    <div class="order">入炉顺序：${r.materials.map((m, k) => `<b>${k + 1}</b>`).join(' → ')}</div>
  </section>`;
}
export function renderHtml(payload) {
  const { request, ieee754, requiredAvgWear, recipes, poolSize, exactFound, generatedAt } = payload;
  const rl = RARITY_LABEL[request.rarity] || request.rarity;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CS2 炼金配方 · ${esc(request.target)}</title>
<style>
:root{--bg:#0A0A0A;--sf:#1A1A1A;--ln:#2A2A2A;--am:#C4956A;--fg:#fff;--dm:#8A8A8A;--mt:#828282;--ok:#6ECF8E;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 system-ui,sans-serif;font-weight:300}
.w{max-width:1180px;margin:0 auto;padding:32px 24px 60px}
h1{margin:0;font-size:28px;font-weight:300;letter-spacing:-.02em}
.sub{color:var(--dm);font-size:11px;margin:6px 0 28px;letter-spacing:.04em}
.sl{color:var(--am);font-size:10px;text-transform:uppercase;letter-spacing:.15em;font-weight:300;margin:0 0 12px;display:block}
.pn{background:var(--bg);border:1px solid var(--ln);border-radius:2px;padding:24px;margin-bottom:20px}
.hg{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:1px;background:var(--ln);border:1px solid var(--ln);border-radius:2px;overflow:hidden}
.kv{background:var(--bg);padding:14px 16px}
.kv span{display:block;font-size:10px;color:var(--am);margin-bottom:4px;text-transform:uppercase;letter-spacing:.15em;font-weight:300}
.kv strong{font-family:var(--mono);font-size:13px;font-weight:300}
.kv.hero strong{font-size:18px;color:var(--am)}
.msg{border:1px solid var(--ln);border-radius:2px;padding:12px 16px;font-size:11px;margin-top:16px;line-height:1.8;font-weight:300}
.msg.ok{border-color:#2a3a2a;color:var(--ok)}.msg.wn{border-color:#3a2a1a;color:var(--am)}
code{background:var(--sf);border:1px solid var(--ln);border-radius:2px;padding:1px 6px;font-family:var(--mono);font-size:11px;color:var(--am)}
.card{background:var(--sf);border:1px solid var(--ln);border-radius:2px;margin-bottom:16px;overflow:hidden}
.card-h{padding:14px 18px;border-bottom:1px solid var(--ln);display:flex;flex-wrap:wrap;align-items:center;gap:14px}
.card-h h2{margin:0;font-size:14px;font-weight:300}
.badge{font-size:10px;padding:3px 10px;border:1px solid var(--ln);border-radius:2px;font-weight:300}
.badge.exact{border-color:#2a3a2a;color:var(--ok)}.badge.near{border-color:#3a2a1a;color:var(--am)}
.kpis{margin-left:auto;display:flex;gap:22px;flex-wrap:wrap}
.kpis div{text-align:right}.kpis span{display:block;font-size:10px;color:var(--am);text-transform:uppercase;letter-spacing:.12em;font-weight:300}
.kpis strong{font-family:var(--mono);font-size:12px;font-weight:300}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:10px 14px;font-size:10px;font-weight:300;color:var(--am);text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid var(--ln);white-space:nowrap}
td{padding:10px 14px;border-bottom:1px solid var(--ln);font-weight:300}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg)}
td.idx{color:var(--mt);width:38px;font-family:var(--mono)}
td.fl,td.pr,td.nr{font-family:var(--mono);white-space:nowrap}
td.pr{color:var(--am);text-align:right}td.nr{color:var(--ok)}
td.rg{color:var(--mt);font-family:var(--mono);font-size:11px;white-space:nowrap}
td.mk{color:var(--mt);font-size:11px}
.order{padding:12px 18px;border-top:1px solid var(--ln);font-size:11px;color:var(--mt);font-weight:300}
.order b{color:var(--am);font-family:var(--mono)}
td.lnk{white-space:nowrap}
td.lnk a{display:inline-block;padding:3px 10px;border:1px solid var(--ln);border-radius:2px;font-size:10px;text-decoration:none;color:var(--dm);transition:all .3s ease-out}
td.lnk a:hover{border-color:var(--am);color:var(--am)}
td.nm .coll{color:var(--mt);font-size:10px;margin-top:2px}
.dist{border-bottom:1px solid var(--ln);padding:14px 18px}
.dist-h{color:var(--am);font-size:10px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.12em;font-weight:300}
.dist-t{width:100%;border-collapse:collapse;font-size:12px}
.dist-t th{padding:4px 10px;font-size:10px;color:var(--am);text-transform:uppercase;letter-spacing:.1em;font-weight:300}
.dist-t td{padding:5px 10px;border-bottom:1px solid var(--ln)}
.dist-t tr:last-child td{border-bottom:none}
td.oprob{color:var(--am);font-family:var(--mono)}
td.owear,td.ocnt{font-family:var(--mono);color:var(--mt)}
footer{color:var(--mt);font-size:11px;line-height:1.9;font-weight:300;border-top:1px solid var(--ln);padding-top:20px;margin-top:28px}
.empty{color:var(--mt);text-align:center;padding:40px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<div class="w">
  <h1>CS2 目标磨损炼金配方</h1>
  <div class="sub">${esc(generatedAt)} · BUFF163</div>
  <div class="pn"><div class="hg">
    <div class="kv hero"><span>目标磨损</span><strong>${esc(request.target)}</strong></div>
    <div class="kv"><span>产物区间</span><strong>[${esc(request.outMin)}, ${esc(request.outMax)}]</strong></div>
    <div class="kv"><span>稀有度</span><strong>${esc(rl)}</strong></div>
    <div class="kv"><span>材料数</span><strong>${esc(request.count)}</strong></div>
    <div class="kv"><span>平均磨损</span><strong>${Number(requiredAvgWear).toFixed(10)}</strong></div>
    <div class="kv"><span>归一化总和</span><strong>${payload.requiredNormalizedSum != null ? Number(payload.requiredNormalizedSum).toFixed(10) : '-'}</strong></div>
    <div class="kv"><span>候选</span><strong>${esc(poolSize)}</strong></div>
    <div class="kv"><span>float32</span><strong>${esc(ieee754.asFloat32)}</strong></div>
    <div class="kv"><span>结果</span><strong>${exactFound ? '精确命中' : '近似最优'}</strong></div>
  </div>
  ${ieee754.exact ? '<div class="msg ok">目标磨损在单精度下可精确表示。</div>'
    : `<div class="msg wn">目标磨损在单精度下不存在，游戏里落到 ${esc(ieee754.asFloat32)}（间距 ${Number(ieee754.spacing).toExponential(3)}），本页按该值求解。</div>`}
  </div>
  <span class="sl">推荐配方 ${recipes.length} 组</span>
  ${recipes.length ? recipes.map(recipeCard).join('') : '<div class="pn"><div class="empty">没有找到可用配方。</div></div>'}
  <footer>算法取自西林磨损计算器（68688888.github.io），已与其源码逐位对齐。材料磨损取自 BUFF <code>asset_info.paintwear</code>。挂单随时被买走，请尽快按顺序购入。</footer>
</div></body></html>`;
}