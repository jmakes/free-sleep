-- Snore heuristic persistence (mirrors movement). Values are NOT OEM/clinical.
-- Idempotent-ish for SQLite: recreate only if missing (Pod dry-run may have created via ensure_snore_schema).

-- Night-level heuristic total on sleep_records (ignore error if column already exists — applied via Python ensure on dry-run)
-- Prisma SQLite cannot IF NOT EXISTS for columns; deploy note: if ALTER fails, mark migration applied.
ALTER TABLE "sleep_records" ADD COLUMN "snore_minutes" INTEGER;

-- Per-minute timeline
CREATE TABLE IF NOT EXISTS "snore" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "snore" INTEGER NOT NULL,
    "likelihood" REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS "snore_side_timestamp_idx" ON "snore"("side", "timestamp");
CREATE UNIQUE INDEX IF NOT EXISTS "snore_side_timestamp_key" ON "snore"("side", "timestamp");
