-- 学习助手对话绑定的当前主题
ALTER TABLE "conversations" ADD COLUMN "learning_map_id" TEXT;

CREATE INDEX "conversations_identity_id_learning_map_id_idx" ON "conversations"("identity_id", "learning_map_id");
