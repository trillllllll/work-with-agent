import { Brain, Library, Plug, Sparkles, User, Workflow, type LucideIcon } from 'lucide-react';
import { t } from '../i18n/index.js';

export type ProposalSourceKey = 'connection' | 'deletedConnection' | 'autoMemory' | 'autoMemoryArchive' | 'organization' | 'learning' | 'assistant' | 'owner' | 'raw';

export type ProposalSource = { key: ProposalSourceKey; label: string; icon: LucideIcon | null };

export type ConnectionName = { id: string; name: string };

export type ProposalSourceOptions = {
  connectionId?: string | null;
  /** Pass the loaded list to resolve a name. Omit it while the list is still loading. */
  connections?: ConnectionName[] | null;
};

function connectionIdOf(actorId: string, connectionId?: string | null): string {
  return connectionId || actorId.slice('connection:'.length);
}

export function proposalSource(actorId: string, options: ProposalSourceOptions = {}): ProposalSource {
  if (actorId.startsWith('connection:')) {
    const id = connectionIdOf(actorId, options.connectionId);
    if (!options.connections) return { key: 'connection', label: t('proposals:source.connection'), icon: Plug };
    const found = options.connections.find((item) => item.id === id);
    if (!found) return { key: 'deletedConnection', label: t('proposals:source.deletedConnection'), icon: Plug };
    return { key: 'connection', label: found.name, icon: Plug };
  }
  if (actorId.startsWith('auto-memory:')) return { key: 'autoMemory', label: t('proposals:source.autoMemory'), icon: Brain };
  if (actorId === 'auto-memory-archive') return { key: 'autoMemoryArchive', label: t('proposals:source.autoMemoryArchive'), icon: Brain };
  if (actorId.startsWith('organization:')) return { key: 'organization', label: t('proposals:source.organization'), icon: Library };
  if (actorId === 'orchestration-learning') return { key: 'learning', label: t('proposals:source.learning'), icon: Workflow };
  if (actorId === 'builtin-agent') return { key: 'assistant', label: t('proposals:source.assistant'), icon: Sparkles };
  if (actorId === 'local-owner') return { key: 'owner', label: t('proposals:source.owner'), icon: User };
  return { key: 'raw', label: actorId, icon: null };
}

/** Stable filter id. Each connection is its own source; other actors collapse by prefix. */
export function sourceGroupKey(actorId: string, connectionId?: string | null): string {
  if (actorId.startsWith('connection:')) return `connection:${connectionIdOf(actorId, connectionId)}`;
  if (actorId.startsWith('auto-memory:')) return 'autoMemory';
  if (actorId === 'auto-memory-archive') return 'autoMemoryArchive';
  if (actorId.startsWith('organization:')) return 'organization';
  if (actorId === 'orchestration-learning') return 'learning';
  if (actorId === 'builtin-agent') return 'assistant';
  if (actorId === 'local-owner') return 'owner';
  return `raw:${actorId}`;
}
