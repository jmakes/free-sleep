-- sleep_score_v1 persistence on sleep_records (mirrors Sleep UI formula).
-- Idempotent-ish for SQLite: Pod dry-run may have created via ensure_sleep_score_schema.

ALTER TABLE "sleep_records" ADD COLUMN "sleep_score_v1" INTEGER;
ALTER TABLE "sleep_records" ADD COLUMN "sleep_score_v1_json" TEXT;
