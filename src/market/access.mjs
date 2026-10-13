/**
 * 市场模式的前置依赖。
 *
 * 仅 Steam 使用 Steam 中文商品搜索确认英文名，不依赖 BUFF 登录态。
 * BUFF/比价模式需要 BUFF 登录态。
 */
export function normalizeMarket(market) {
  const value = String(market || 'buff').toLowerCase();
  return value === 'steam' || value === 'both' ? value : 'buff';
}

export function marketAccess(market, { hasBuff = false } = {}) {
  const mode = normalizeMarket(market);
  if (mode !== 'steam' && !hasBuff) {
    return {
      ok: false,
      code: 'no_cookie',
      message: 'BUFF 登录态缺失。请先运行：powershell -File scripts\\set-cookies.ps1 -Site buff',
    };
  }
  return { ok: true, mode };
}
