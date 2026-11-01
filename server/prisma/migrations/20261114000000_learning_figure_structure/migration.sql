-- Historical figures need an explicit refresh before their structure can be verified.
ALTER TABLE "learning_figures" ADD COLUMN "structure_hash" TEXT NOT NULL DEFAULT '';
