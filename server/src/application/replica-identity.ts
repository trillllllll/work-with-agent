import type { Request } from 'express';

// A request can only acquire this proof after the relay authenticates a paired device.
// No caller-controlled header or cookie can manufacture it.
const trusted = new WeakSet<Request>();
export function markReplicaRequest(request: Request) { trusted.add(request); }
export function isReplicaRequest(request: Request) { return trusted.has(request); }
