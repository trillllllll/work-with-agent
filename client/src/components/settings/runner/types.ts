export type ProviderCapability = { provider: string; available: boolean; version?: string; path?: string };

export type NodeCapabilities = {
  providers?: ProviderCapability[];
  allowedRoots?: string[];
  maxConcurrent?: number;
  freeBytes?: number | null;
  gh?: boolean;
  managedBy?: string;
  logPath?: string | null;
  lastError?: string | null;
  version?: string;
  platform?: string;
};

export type ComputerLocation = { id: string; projectId: string; projectName: string; path: string; status: string };

export type Computer = {
  id: string;
  name: string;
  status: string;
  platform: string;
  version: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  online: boolean;
  capabilities: NodeCapabilities;
  locations: ComputerLocation[];
  activeJobs: number;
};

export type IssuedNode = { nodeId: string; name: string; command: string; token: string; serverUrl: string };

export type ProjectLocationRow = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeOnline: boolean;
  nodeStatus: string;
  path: string;
  status: string;
  error: string | null;
};

export type ProjectRow = {
  id: string;
  name: string;
  defaultBranch: string;
  defaultProvider: string;
  defaultParallel: number;
  revision: number;
  archivedAt?: string | null;
  topicIds?: string[];
  locations: ProjectLocationRow[];
};

export type TopicRow = { id: string; name: string };

export type TopicBindingItem = { scopeId: string; projectId: string; projectName: string; projectArchived: boolean };
