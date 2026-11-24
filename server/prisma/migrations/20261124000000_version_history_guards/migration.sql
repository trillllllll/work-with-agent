-- A version history page must never run ahead of the body row it describes.
-- A merge that keeps a stale body while importing newer pages splits the pair;
-- the next write then fails on the (bodyId, revision) unique key. The runtime
-- always writes the body first, so these triggers only reject bad imports.
CREATE TRIGGER "MemoryVersion_not_ahead_of_Memory"
BEFORE INSERT ON "MemoryVersion"
WHEN EXISTS (SELECT 1 FROM "Memory" WHERE "id" = NEW."memoryId" AND "revision" < NEW."revision")
BEGIN
  SELECT RAISE(ABORT, 'MemoryVersion revision is ahead of Memory');
END;
CREATE TRIGGER "MaterialVersion_not_ahead_of_Material"
BEFORE INSERT ON "MaterialVersion"
WHEN EXISTS (SELECT 1 FROM "Material" WHERE "id" = NEW."materialId" AND "revision" < NEW."revision")
BEGIN
  SELECT RAISE(ABORT, 'MaterialVersion revision is ahead of Material');
END;
CREATE TRIGGER "SkillVersion_not_ahead_of_Skill"
BEFORE INSERT ON "SkillVersion"
WHEN EXISTS (SELECT 1 FROM "Skill" WHERE "id" = NEW."skillId" AND "revision" < NEW."revision")
BEGIN
  SELECT RAISE(ABORT, 'SkillVersion revision is ahead of Skill');
END;
