// 只用已经测量的分页耗时和实际工作量估算。总页数未知时，外推已完成档位的页数。
export class SearchEta {
  constructor({ now = Date.now, solverMs = 40000 } = {}) {
    this.now = now; this.started = now(); this.solverMs = solverMs;
    this.total = 0; this.completed = 0; this.pages = 0; this.samples = [];
    this.tierPages = []; this.current = null; this.phase = 'prepare';
    this.lastActivity = this.started;
  }
  update(event) {
    const now = this.now();
    this.lastActivity = now;
    if (event.type === 'plan') { this.total = event.total; this.phase = 'fetch'; }
    if (event.type === 'tierStart') this.current = { started: now, pageStarted: now, pages: 0, totalPages: null };
    if (event.type === 'pageStart' && this.current) this.current.pageStarted = now;
    if (event.type === 'pageDone' && this.current) {
      this.samples.push(Math.max(1, now - this.current.pageStarted));
      this.current.pageStarted = now; this.current.pages++; this.pages++;
      if (event.totalPages != null) this.current.totalPages = event.totalPages;
    }
    if (event.type === 'tierDone') {
      this.completed++;
      if (this.current?.pages) this.tierPages.push(this.current.pages);
      this.current = null;
    }
    if (event.type === 'solver') { this.phase = 'solver'; this.solverStarted = now; }
    if (event.type === 'done') this.phase = 'done';
  }
  snapshot() {
    const now = this.now(), elapsedMs = now - this.started;
    const base = { elapsedMs, completed: this.completed, total: this.total, pages: this.pages };
    if (this.phase === 'done') return { ...base, etaMs: 0, etaState: 'done' };
    if (this.phase === 'solver') {
      const left = this.solverMs - (now - this.solverStarted);
      return { ...base, etaMs: left > 0 ? left : null, etaState: left > 0 ? 'solver' : 'reestimating' };
    }
    if (!this.samples.length || !this.total) return { ...base, etaMs: null, etaState: 'estimating' };
    const recent = this.samples.slice(-20);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const waiting = now - (this.current?.pageStarted ?? this.lastActivity);
    // 请求超出观察值时，不能继续显示过期的“快完成”；下一页到达后再恢复估算。
    if (waiting > Math.max(15000, mean * 2)) return { ...base, etaMs: null, etaState: 'reestimating' };
    if (!this.tierPages.length && !this.current?.totalPages) return { ...base, etaMs: null, etaState: 'estimating' };
    const typicalPages = Math.max(1, this.tierPages.length
      ? this.tierPages.reduce((a, b) => a + b, 0) / this.tierPages.length : this.current.totalPages);
    const unfinished = Math.max(0, this.total - this.completed - (this.current ? 1 : 0));
    const currentPages = this.current ? Math.max(1, (this.current.totalPages ?? Math.max(typicalPages, this.current.pages + 1)) - this.current.pages) : 0;
    const etaMs = Math.ceil(unfinished * typicalPages * mean + currentPages * mean - Math.min(waiting, mean) + this.solverMs);
    return { ...base, etaMs: Math.max(this.solverMs, etaMs), etaState: 'estimated' };
  }
}
