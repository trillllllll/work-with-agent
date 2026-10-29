import { z } from 'zod';
import { assertWritableContent, type DocumentContent } from '../../domain/document-content.js';
import { canonical, registerCommandHandler, type Command } from '../commands.js';
import { jsonSchema } from '../command-catalog.js';
import { actorFromConnection, type Actor } from '../security.js';
import { knowledgeHash } from '../knowledge-blobs.js';
import { assertExpected, assertWritableTopic, libraryError, writableMaterial, type LibraryDb } from '../library/access.js';
import { createResourceSchema, referencesFor, ResourceService, saveResourceSchema } from './service.js';
import { versionFormat, versionSupported } from './version.js';

const createInput = createResourceSchema.omit({ requestId: true });
const saveInput = saveResourceSchema.omit({ requestId: true, expectedRevision: true });

async function currentActor(tx: LibraryDb, actor: Actor) {
  if (actor.kind !== 'connection' || !actor.connectionId) return actor;
  const connection = await tx.connection.findUnique({ where: { id: actor.connectionId } });
  if (!connection || connection.status !== 'active') throw libraryError('CONNECTION_REVOKED', '连接已撤销', 401);
  return actorFromConnection(connection);
}

async function inspect(tx: LibraryDb, actor: Actor, command: Command) {
  const current = await currentActor(tx, actor);
  const input = (command.kind === 'resource.create' ? createInput : saveInput).parse(command.input);
  try { assertWritableContent(input.format, input.content, input.schemaVersion); }
  catch (error) { throw libraryError('UNSUPPORTED_CONTENT', error instanceof Error ? error.message : '不支持此正文格式', 400); }
  const targets = await referencesFor(tx, current, input.format, input.content as DocumentContent, input.relativeReferences);
  if (command.kind === 'resource.create') {
    const creation = createInput.parse(input);
    const topic = await assertWritableTopic(tx, current, creation.topicId);
    return { preconditions: { topicId: creation.topicId, topicRevision: topic?.revision ?? null, targets }, preview: { kind: command.kind, format: input.format, title: creation.title } };
  }
  const resource = await writableMaterial(tx, current, command.targetId ?? '');
  assertExpected(resource.revision, command.expectedRevision);
  const version = await tx.materialVersion.findUniqueOrThrow({ where: { materialId_revision: { materialId: resource.id, revision: resource.revision } } });
  if (!versionSupported(resource.kind, version) || versionFormat(resource.kind, version) !== input.format) throw libraryError('UNSUPPORTED_FORMAT_WRITE', '此版本不能用该格式覆盖，请另存为新文档');
  return { preconditions: { resourceId: resource.id, revision: resource.revision, contentHash: version.contentHash, targets }, preview: { kind: command.kind, title: resource.title, format: input.format } };
}

/** AI and MCP retain the existing proposal/confirmation gate; only the UI REST path writes as owner directly. */
export function registerResourceCommands() {
  for (const [kind, schema] of Object.entries({ 'resource.create': createInput, 'resource.save': saveInput }) as Array<[string, z.ZodTypeAny]>) {
    registerCommandHandler(kind, {
      forceProposal: true,
      description: kind === 'resource.create' ? 'Create a versioned text, Markdown or richdoc-v1 resource. Rich documents use schemaVersion=1 and stable blocks; attachments reference exact resourceId/revision.' : 'Save a resource against expectedRevision using its original format and complete product-schema content. Never write a plain-text projection over richdoc-v1.',
      inputSchema: jsonSchema(schema),
      inspect,
      execute: async (tx, actor, command, context) => {
        const current = await currentActor(tx, actor);
        const requestId = `command:${knowledgeHash(canonical({ requestId: context.requestId, proposalId: context.proposalId, entityId: command.entityId, targetId: command.targetId, expectedRevision: command.expectedRevision, kind, input: command.input }))}`;
        const service = new ResourceService({ tx, context: { ...context, entityId: context.entityId ?? command.entityId } });
        return kind === 'resource.create'
          ? service.create(current, { ...createInput.parse(command.input), requestId })
          : service.save(current, command.targetId ?? '', { ...saveInput.parse(command.input), requestId, expectedRevision: command.expectedRevision });
      },
    });
  }
}
