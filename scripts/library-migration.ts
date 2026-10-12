import { rehearseLibraryMigration } from '../server/src/application/library/migration-rehearsal.ts';

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    },
    toContain(expected: unknown) {
      if (!Array.isArray(actual) || !actual.includes(expected)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`expected null, received ${JSON.stringify(actual)}`);
    },
  };
}

async function main() {
  const rehearsal = await rehearseLibraryMigration();
  expect(rehearsal.report.materialCountBefore).toBe(rehearsal.report.materialCountAfter);
  expect(rehearsal.report.versionCountBefore).toBe(rehearsal.report.versionCountAfter);
  expect(rehearsal.report.migratedLinkCount).toBe(1);
  expect(rehearsal.report.danglingLegacyTaskIds).toContain('missing-legacy-task');
  expect(rehearsal.secondRun.migratedLinkCount).toBe(0);
  expect(rehearsal.thirdRun).toBeNull();
  expect(rehearsal.folderCountAfter).toBe(rehearsal.folderCountBefore);
  expect(rehearsal.linkCountAfter).toBe(rehearsal.linkCountBefore);
  console.log(JSON.stringify({
    ok: true,
    materialCount: rehearsal.report.materialCountAfter,
    versionCount: rehearsal.report.versionCountAfter,
    migratedLinkCount: rehearsal.report.migratedLinkCount,
    danglingLegacyTaskIds: rehearsal.report.danglingLegacyTaskIds,
    missingBlobHashes: rehearsal.report.missingBlobHashes,
    folderCount: rehearsal.folderCountAfter,
    linkCount: rehearsal.linkCountAfter,
  }, null, 2));
}

main();
