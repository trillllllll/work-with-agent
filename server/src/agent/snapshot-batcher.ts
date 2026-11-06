/** Coalesce snapshots both before a write and while a slow write is in flight. */
export class SnapshotBatcher<T> {
  private pending?: T;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private failure?: unknown;
  private closed = false;
  constructor(private write: (value: T) => Promise<void>, private abort: () => void, private intervalMs = 100) {}
  add(value: T) {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Preview batcher is closed');
    this.pending = value;
    if (!this.timer && !this.writing) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.intervalMs); this.timer.unref?.();
    }
  }
  private flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = Promise.resolve().then(async () => {
      while (this.pending !== undefined && !this.failure) {
        const value = this.pending; this.pending = undefined;
        try { await this.write(value); } catch (error) { this.failure = error; this.pending = undefined; this.abort(); }
      }
    }).finally(() => { this.writing = undefined; });
    return this.writing;
  }
  async finish() {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await this.flush(); if (this.failure) throw this.failure;
  }
}
