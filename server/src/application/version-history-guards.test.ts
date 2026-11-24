import { describe, it, expect } from 'vitest';
import { prisma } from '../infrastructure/prisma.js';

const stamp = '2026-01-01T00:00:00.000Z';
const uid = Math.random().toString(36).slice(2, 10);

async function seedMemory(id: string) {
  await prisma.memory.create({ data: { id, kind: 'fact', title: `守卫测试 ${id}`, content: '正文', createdAt: stamp, updatedAt: stamp } });
}

async function seedMaterial(id: string) {
  await prisma.material.create({ data: { id, kind: 'text', title: `守卫测试 ${id}`, createdAt: stamp, updatedAt: stamp } });
}

async function seedSkill(id: string) {
  await prisma.skill.create({ data: { id, name: `守卫测试 ${id}`, description: '', instructions: 'fixture', enabled: true, origin: 'manual', createdAt: stamp, updatedAt: stamp } });
}

describe('version history guards', () => {
  it('rejects a memory page ahead of the body and allows one at the body revision', async () => {
    const id = `guard-memory-${uid}`;
    await seedMemory(id);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "MemoryVersion" ("id","memoryId","revision","title","content","kind","status","health","evidence","reason","createdAt") VALUES ('${id}-page-2','${id}',2,'t','c','fact','active','current','[]','guard','${stamp}')`)).rejects.toThrow(/ahead of Memory/);
    await prisma.$executeRawUnsafe(`INSERT INTO "MemoryVersion" ("id","memoryId","revision","title","content","kind","status","health","evidence","reason","createdAt") VALUES ('${id}-page-1','${id}',1,'t','c','fact','active','current','[]','guard','${stamp}')`);
    expect((await prisma.memoryVersion.findMany({ where: { memoryId: id } })).map((row) => row.revision)).toEqual([1]);
  });

  it('rejects a material page ahead of the body and allows one at the body revision', async () => {
    const id = `guard-material-${uid}`;
    await seedMaterial(id);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "MaterialVersion" ("id","materialId","revision","contentHash","createdAt") VALUES ('${id}-page-2','${id}',2,'${'a'.repeat(64)}','${stamp}')`)).rejects.toThrow(/ahead of Material/);
    await prisma.$executeRawUnsafe(`INSERT INTO "MaterialVersion" ("id","materialId","revision","contentHash","createdAt") VALUES ('${id}-page-1','${id}',1,'${'b'.repeat(64)}','${stamp}')`);
    expect((await prisma.materialVersion.findMany({ where: { materialId: id } })).map((row) => row.revision)).toEqual([1]);
  });

  it('rejects a skill page ahead of the body and allows one at the body revision', async () => {
    const id = `guard-skill-${uid}`;
    await seedSkill(id);
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "SkillVersion" ("id","skillId","revision","name","description","instructions","enabled","reason","source","createdAt") VALUES ('${id}-page-2','${id}',2,'t','','x',1,'guard','manual','${stamp}')`)).rejects.toThrow(/ahead of Skill/);
    await prisma.$executeRawUnsafe(`INSERT INTO "SkillVersion" ("id","skillId","revision","name","description","instructions","enabled","reason","source","createdAt") VALUES ('${id}-page-1','${id}',1,'t','','x',1,'guard','manual','${stamp}')`);
    expect((await prisma.skillVersion.findMany({ where: { skillId: id } })).map((row) => row.revision)).toEqual([1]);
  });
});
