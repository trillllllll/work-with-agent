export type Connection = {
  id: string;
  name: string;
  host: string;
  status: string;
  revision: number;
  topicIds: string[] | string;
  includeInbox: boolean;
  autoActions: string[] | string;
  createdAt: string;
  lastUsedAt?: string | null;
  lastCommandAt?: string | null;
  lastWriteAt?: string | null;
  lastWriteOperation?: string | null;
  healthy?: boolean;
  missingTopicIds?: string[];
};

export type ConnectionStatus = 'revoked' | 'unhealthy' | 'connected' | 'waiting';

/** Badge order: revoked, then missing lists, then a recorded host call, otherwise waiting. */
export function connectionStatus(conn: Pick<Connection, 'status' | 'missingTopicIds' | 'lastCommandAt'>): ConnectionStatus {
  if (conn.status === 'revoked') return 'revoked';
  if ((conn.missingTopicIds?.length ?? 0) > 0) return 'unhealthy';
  if (conn.lastCommandAt) return 'connected';
  return 'waiting';
}

const hostNames: Record<string, string> = { grok: 'Grok', codex: 'Codex', claude: 'Claude Code' };
const hostMarks: Record<string, string> = { grok: 'Gk', codex: 'Cx', claude: 'Cc' };

export function hostLabel(host: string) {
  return hostNames[host] ?? host;
}

/** Known hosts use a fixed mark. Anything else uses its first two characters. */
export function hostInitials(host: string) {
  const known = hostMarks[host];
  if (known) return known;
  const chars = [...host];
  return `${(chars[0] ?? '').toUpperCase()}${(chars[1] ?? '').toLowerCase()}`;
}
