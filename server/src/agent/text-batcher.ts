/** Coalesce stream chunks without queuing a transaction for every token. */
export class TextBatcher {
  private pending = '';
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private failure?: { error: unknown };
  private closed = false;

  constructor(
    private readonly write: (delta: string) => Promise<void>,
    private readonly onError: () => void,
    private readonly intervalMs = 100,
    private readonly maxChars = 2048,
  ) {}

  async add(text: string) {
    this.check();
    this.pending += text;
    if (this.pending.length >= this.maxChars) await this.flush();
    else this.schedule();
  }

  private check() {
    if (this.failure) throw this.failure.error;
  }

  private schedule() {
    if (this.closed || this.timer || this.writing || !this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => { /* failure is retained for finish/add */ });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing) {
      const writing = this.writing;
      await writing;
      if (this.writing === writing) this.writing = undefined;
    }
    this.check();
    if (!this.pending) return;
    const delta = this.pending;
    this.pending = '';
    const writing = this.write(delta).catch((error: unknown) => {
      this.failure = { error };
      this.onError();
    });
    this.writing = writing;
    await writing;
    if (this.writing === writing) this.writing = undefined;
    this.check();
    this.schedule();
  }

  async finish() {
    this.closed = true;
    await this.flush();
  }
}
