/** 搜索锁归属于具体任务，旧任务结束时不能释放新任务的锁。 */
export class SearchTasks {
  active = null;

  get busy() { return this.active !== null; }

  start(res, id) {
    if (this.busy || res.destroyed || res.writableEnded) return null;
    const controller = new AbortController();
    const task = {
      id: id || `${Date.now()}-${Math.random().toString(36).slice(2)}`, signal: controller.signal,
      skipRequested: false,
      currentMaterialId: null,
      skip: materialId => {
        if (!task.currentMaterialId || materialId !== task.currentMaterialId || task.skipRequested) return false;
        task.skipRequested = true; return true;
      },
      consumeSkip: () => { const requested = task.skipRequested; task.skipRequested = false; return requested; },
      check: () => controller.signal.throwIfAborted(),
      finish: () => {
        res.off('close', disconnect);
        if (this.active === task) this.active = null;
        if (!res.destroyed && !res.writableEnded) res.end();
      },
      cancel: () => {
        controller.abort(new DOMException('搜索已停止', 'AbortError'));
        task.finish();
      },
      // 取消/超时都终止当前流程，同时把 signal 交给底层 HTTP 客户端。
      run: async (work, timeoutMs) => {
        let timer;
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        if (timeoutMs) timer = setTimeout(() => {
          controller.abort(new DOMException('搜索超时', 'TimeoutError'));
        }, timeoutMs);
        try {
          task.check();
          return await Promise.race([Promise.resolve().then(() => {
            task.check();
            return work();
          }), aborted]);
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
        }
      },
    };
    const disconnect = () => task.cancel();
    res.once('close', disconnect);
    this.active = task;
    return task;
  }

  cancel(id) {
    if (!this.active || this.active.id !== id) return false;
    this.active.cancel();
    return true;
  }
}
