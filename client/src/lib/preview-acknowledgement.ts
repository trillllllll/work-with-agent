/** One budget per mounted block, independent of the number of source/render updates. */
export class PreviewAcknowledgement {
  private source = '';
  private attempts = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private write: (source: string) => Promise<unknown>) {}
  update(source: string) {
    this.source = source;
    if (!this.closed && !this.attempts) void this.send();
  }
  private async send() {
    if (this.closed) return;
    this.attempts++;
    try { await this.write(this.source); }
    catch { if (!this.closed && this.attempts < 3) this.timer = setTimeout(() => void this.send(), 500 * this.attempts); }
  }
  dispose() { this.closed = true; if (this.timer) clearTimeout(this.timer); }
}
