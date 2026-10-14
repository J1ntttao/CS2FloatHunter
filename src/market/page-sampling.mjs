// 首页用于确认总页数，其余页无放回随机抽取；页号从 0 开始。
export function samplePages(total, count, random = Math.random) {
  total = Math.max(0, Math.floor(total));
  count = Math.min(total, Math.max(1, Math.floor(count)));
  if (!total) return [];
  const pages = [0], swaps = new Map();
  for (let left = total - 1; pages.length < count; left--) {
    const index = Math.min(left - 1, Math.floor(random() * left));
    pages.push((swaps.get(index) ?? index) + 1);
    swaps.set(index, swaps.get(left - 1) ?? left - 1);
  }
  return pages;
}
