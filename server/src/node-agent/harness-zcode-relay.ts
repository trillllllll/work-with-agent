import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { asObject, CodexRejected } from './harness-codex.js';
import { codexItems, codexText } from './harness-history.js';
import { openZCodeRemoteSocket } from './harness-zcode-account.js';
import { zcodeWorkspace } from './harness-zcode-client.js';

type Wire = Record<string, unknown>;
type Waiter = {
  matches: (message: Wire) => boolean;
  settle: (value: Wire | Error) => void;
};
const closed = () => new Error('ZCode 桌面连接中断，操作结果待核实');
const invalid = () => new Error('ZCode 桌面返回了不支持的会话数据');
const second = () => Math.floor(Date.now() / 1_000);
const crc = (bytes: Buffer) => crc32(bytes).toString(16).padStart(8, '0');
const MAX_MESSAGE = 16 * 1024 * 1024;

// ZCode's ChannelClient protocol sends two tagged values: header and arguments.
function encodeNumber(value: number) {
  const bytes: number[] = [];
  do {
    const rest = value >>> 7;
    bytes.push((value & 127) | (rest ? 128 : 0));
    value = rest;
  } while (value);
  return Buffer.from(bytes);
}

function encode(value: unknown): Buffer {
  if (value === undefined) return Buffer.from([0]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), encodeNumber(value.length), ...value.map(encode)]);
  if (typeof value === 'number' && Number.isInteger(value)) return Buffer.concat([Buffer.from([6]), encodeNumber(value)]);
  const isText = typeof value === 'string';
  const bytes = Buffer.from(isText ? value : JSON.stringify(value));
  return Buffer.concat([Buffer.from([isText ? 1 : 5]), encodeNumber(bytes.length), bytes]);
}

function readPacket(bytes: Buffer) {
  let offset = 0;
  function integer() {
    let value = 0;
    for (let i = 0; i < 5 && offset < bytes.length; i++) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) return value;
    }
    throw invalid();
  }
  function read(depth = 0): unknown {
    if (offset >= bytes.length || depth > 20) throw invalid();
    const type = bytes[offset++];
    if (type === 0) return undefined;
    const length = integer();
    if (type === 6) return length;
    if (length > bytes.length - offset) throw invalid();
    if (type === 4) {
      if (length > 100_000) throw invalid();
      return Array.from({ length }, () => read(depth + 1));
    }
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    if (type === 1) return value.toString('utf8');
    if (type === 5) return JSON.parse(value.toString('utf8'));
    if (type === 2 || type === 3) return value;
    throw invalid();
  }
  const header = read();
  if (!Array.isArray(header)) throw invalid();
  return { code: header[0] as number, id: header[1] as number, value: offset < bytes.length ? read() : undefined };
}

export class ZCodeDesktopRelay {
  readonly clientId: string;
  readonly workspace;
  private readonly identity = { bridgeSessionId: randomUUID(), bridgeGeneration: 1, recoveryId: randomUUID() };
  private readonly mobileSession = randomUUID();
  private readonly waiting = new Set<Waiter>();
  private readonly handlers = new Map<number, (value: Wire) => void>();
  private readonly backlog: Wire[] = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastAck = Date.now();
  private nextId = 0;
  private sent = 0;
  private received = 0;
  private physical = 0;
  private assembly?: { count: number; length: number; checksum: string; parts: Buffer[]; bytes: number };
  private paired = false;
  private ended = false;
  private readonly disconnected = new Set<() => void>();

  private constructor(private readonly socket: WebSocket, cwd: string, sid: string) {
    this.clientId = createHash('sha256').update('dovun:'+sid).digest('hex').slice(0, 32);
    this.workspace = zcodeWorkspace(cwd);
    socket.addEventListener('message', ({ data }) => {
      try {
        if (typeof data !== 'string' || Buffer.byteLength(data) > 1_048_576) throw invalid();
        this.incoming(asObject(JSON.parse(data)));
      } catch { this.close(); }
    });
    socket.addEventListener('close', () => this.close(), { once: true });
    socket.addEventListener('error', () => this.close(), { once: true });
  }

  static async open(cwd: string) {
    const { socket, sid, appVersion } = await openZCodeRemoteSocket();
    const relay = new ZCodeDesktopRelay(socket, cwd, sid);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(closed()), 8_000);
        const unsubscribe = relay.onDisconnect(() => { clearTimeout(timer); reject(closed()); });
        socket.addEventListener('open', () => { clearTimeout(timer); unsubscribe(); resolve(); }, { once: true });
      });
      const paired = relay.wait((value) => value.pair_status === 'matched', 13_000);
      void paired.catch(() => undefined);
      relay.send({ type: 'auth_init', device_sid: sid, meta: { name: 'Dovun', platform: 'macOS', version: appVersion } });
      relay.heartbeat = setInterval(() => {
        if (Date.now() - relay.lastAck > 15_000) relay.close();
        else {
          try { relay.send({ type: 'pair_status_query' }); }
          catch { relay.close(); }
        }
      }, 5_000);
      relay.heartbeat.unref();
      await paired;
      await relay.appRequest('bootstrap-request', 'bootstrap-response', { terminalClientSessionId: relay.mobileSession });
      const list = asObject((await relay.appRequest('workspace-list-request', 'workspace-list-response')).result);
      if (!codexItems(list.workspaces).some((item) => item.kind === 'local' && item.workspacePath === cwd && !item.workspaceIdentity && !item.remoteSessionId)) {
        throw new CodexRejected('该项目未加入 Mac 上 ZCode 的网页远控');
      }
      const ready = await relay.appRequest('workspace-bridge-open', 'workspace-bridge-ready', {
        ...relay.identity, workspaceKey: cwd, terminalClientSessionId: relay.mobileSession,
      });
      const bridge = asObject(ready.bridge);
      if (!relay.matches(ready) || bridge.kind !== 'local' || bridge.workspacePath !== cwd || bridge.workspaceKey !== cwd) throw invalid();
      await relay.wait((value) => value.code === 200);
      const hello = asObject(await relay.call('helloConversationV4'));
      if (hello.kind !== 'hello' || hello.protocolVersion !== 3 || hello.clientMode !== 'web-remote-replayable'
          || hello.deliveryProfile !== 'replayable') throw invalid();
      await relay.call('initializeConversationV4', {
        kind: 'clientHello', protocolVersion: 3, clientId: relay.clientId, clientKind: 'mobileRemote', appVersion,
        capabilities: { historyFirst: true },
      });
      return relay;
    } catch (error) {
      relay.close();
      throw error instanceof CodexRejected ? error : new CodexRejected('无法连接 Mac 上 ZCode 的原会话');
    }
  }

  get closed() { return this.ended; }

  onDisconnect(listener: () => void) {
    this.disconnected.add(listener);
    return () => { this.disconnected.delete(listener); };
  }

  private send(payload: Wire) {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) throw closed();
    this.socket.send(JSON.stringify({ ...payload, client_ts: second() }));
  }

  private data(payload: Wire) { this.send({ type: 'data', payload }); }

  private async appRequest(type: string, expected: string, fields?: Wire) {
    const requestId = randomUUID();
    const pending = this.wait((value) => value.requestId === requestId);
    void pending.catch(() => undefined);
    this.data({ zcode_type: type, requestId, ...fields });
    const result = await pending;
    if (result.zcode_type !== expected) throw invalid();
    return result;
  }

  private wait(matches: Waiter['matches'], timeout = 7_000) {
    const cached = this.backlog.findIndex(matches);
    if (cached !== -1) return Promise.resolve(this.backlog.splice(cached, 1)[0]);
    if (this.ended) return Promise.reject(closed());
    return new Promise<Wire>((resolve, reject) => {
      const waiter: Waiter = { matches, settle: (value) => {
        clearTimeout(timer);
        this.waiting.delete(waiter);
        if (value instanceof Error) reject(value); else resolve(value);
      } };
      const timer = setTimeout(() => waiter.settle(closed()), timeout);
      this.waiting.add(waiter);
    });
  }

  private deliver(value: Wire) {
    for (const waiter of this.waiting) if (waiter.matches(value)) { waiter.settle(value); return; }
    if (value.code === 200 && !this.backlog.length) this.backlog.push(value);
  }

  private matches(payload: Wire) {
    return payload.bridgeSessionId === this.identity.bridgeSessionId
      && payload.bridgeGeneration === this.identity.bridgeGeneration && payload.recoveryId === this.identity.recoveryId;
  }

  private incoming(message: Wire) {
    if (message.type === 'error') { this.close(); return; }
    if (message.type === 'auth_ack' || message.type === 'pair_status_ack') {
      this.lastAck = Date.now();
      if (message.pair_status === 'matched') {
        this.paired = true;
        this.deliver(message);
      } else if (this.paired) this.close();
      return;
    }
    if (!this.paired || message.type !== 'data') return;
    const payload = asObject(message.payload);
    if (payload.zcode_type === 'rpc-frame') {
      if (this.matches(payload)) this.readFrame(payload);
    } else if (payload.zcode_type === 'bridge-degraded' && this.matches(payload)) {
      this.close();
    } else if (payload.requestId) this.deliver(payload);
  }

  private readFrame(frame: Wire) {
    if (typeof frame.messageSeq !== 'number' || !Number.isSafeInteger(frame.messageSeq)) throw invalid();
    if (frame.messageSeq <= this.received) { this.ack(); return; }
    const count = frame.fragmentCount;
    const length = frame.messageBytes;
    const checksum = asObject(frame.checksum);
    const encoded = codexText(frame.dataBase64);
    if (frame.messageSeq !== this.received + 1 || frame.seq !== this.physical + 1
        || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 64
        || typeof length !== 'number' || !Number.isInteger(length) || length < count || length > MAX_MESSAGE
        || checksum.algorithm !== 'crc32' || typeof checksum.value !== 'string' || !/^[a-f0-9]{8}$/.test(checksum.value)
        || !encoded) throw invalid();
    const current = this.assembly ??= { count, length, checksum: checksum.value, parts: [], bytes: 0 };
    if (current.count !== count || current.length !== length || current.checksum !== checksum.value
        || frame.fragmentIndex !== current.parts.length) throw invalid();
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded || current.bytes + bytes.length > length) throw invalid();
    current.bytes += bytes.length;
    current.parts.push(bytes);
    this.physical++;
    if (current.parts.length < current.count) return;
    const body = Buffer.concat(current.parts, current.bytes);
    if (current.bytes !== length || crc(body) !== current.checksum) throw invalid();
    const packet = readPacket(body);
    this.assembly = undefined;
    this.received++;
    this.ack();
    if (packet.code === 204) this.handlers.get(packet.id)?.(asObject(packet.value));
    else if (packet.code === 205) this.close();
    else this.deliver(packet);
  }

  private ack() { this.data({ zcode_type: 'rpc-frame-ack', ...this.identity, ackMessageSeq: this.received }); }

  private rpc(header: unknown[], body: unknown) {
    const bytes = Buffer.concat([encode(header), encode(body)]);
    if (!bytes.length || bytes.length > 512 * 1024) throw invalid();
    const seq = ++this.sent;
    this.data({
      zcode_type: 'rpc-frame', ...this.identity, seq, messageSeq: seq, fragmentIndex: 0, fragmentCount: 1,
      messageBytes: bytes.length, checksum: { algorithm: 'crc32', value: crc(bytes) }, dataBase64: bytes.toString('base64'),
    });
  }

  async call(name: string, arg?: Wire, channel = 'zcode-agent') {
    const id = ++this.nextId;
    const pending = this.wait((value) => value.id === id);
    void pending.catch(() => undefined);
    this.rpc([100, id, channel, name], arg ? [arg] : []);
    const packet = await pending;
    if (packet.code !== 201) throw closed();
    return packet.value;
  }

  listen(name: string, callback: (value: Wire) => void) {
    const id = ++this.nextId;
    this.handlers.set(id, callback);
    this.rpc([102, id, 'zcode-agent', name], this.workspace);
    return () => {
      if (this.handlers.delete(id) && !this.ended) {
        try { this.rpc([103, id], undefined); }
        catch { this.close(); }
      }
    };
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    this.socket.close();
    for (const waiter of this.waiting) waiter.settle(closed());
    this.handlers.clear();
    for (const listener of this.disconnected) listener();
    this.disconnected.clear();
  }
}

let attachment: { cwd: string; refs: number; opening: Promise<ZCodeDesktopRelay> } | undefined;

export async function acquireZCodeRelay(cwd: string) {
  if (attachment && attachment.cwd !== cwd) throw new CodexRejected('Mac 上另一个 ZCode 项目正在远控');
  const current = attachment ??= { cwd, refs: 0, opening: ZCodeDesktopRelay.open(cwd) };
  current.refs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--current.refs !== 0) return;
    if (attachment === current) attachment = undefined;
    void current.opening.then((relay) => relay.close(), () => undefined);
  };
  try {
    const relay = await current.opening;
    if (relay.closed) throw closed();
    relay.onDisconnect(() => { if (attachment === current) attachment = undefined; });
    return { relay, release };
  } catch (error) { release(); throw error; }
}
