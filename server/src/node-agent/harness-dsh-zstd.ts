import { decompress } from 'fzstd';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// The magic can occur inside compressed data. A frame cut at such a position never decodes, so extend it a bounded
// number of times before treating the tail as incomplete.
const MAX_EXTENSIONS = 8;

function wholeFrames(buffer: Buffer) {
  const output: Uint8Array[] = [];
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const starts: number[] = [];
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + MAGIC.length)) starts.push(at);
  let index = 0;
  while (index < starts.length) {
    let decoded: Uint8Array | undefined;
    let end = buffer.length;
    for (let next = index + 1; next <= Math.min(starts.length, index + 2 + MAX_EXTENSIONS) && !decoded; next++) {
      end = next < starts.length ? starts[next] : buffer.length;
      try { decoded = decompress(view.subarray(starts[index], end)); } catch { /* extend to the next boundary */ }
    }
    // Nothing after an incomplete or unsupported frame can be trusted.
    if (!decoded) break;
    output.push(decoded);
    index = starts.findIndex((start, position) => position > index && start >= end);
    if (index === -1 || starts[index] !== end) break;
  }
  return output;
}

/** One session log is a concatenation of zstd frames, one per append. A frame a live writer has not finished is dropped. */
export function decodeZstd(buffer: Buffer): Buffer {
  try { return Buffer.from(decompress(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))); }
  catch { return Buffer.concat(wholeFrames(buffer).map((frame) => Buffer.from(frame))); }
}

/** Only the first frame, which holds the header line. Decoding a partial second frame first would waste most of the read. */
export function decodeFirstZstdFrame(buffer: Buffer): Buffer {
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const next = buffer.indexOf(MAGIC, MAGIC.length);
  try { return Buffer.from(decompress(view.subarray(0, next === -1 ? buffer.length : next))); }
  catch { return Buffer.from(wholeFrames(buffer)[0] ?? new Uint8Array()); }
}
