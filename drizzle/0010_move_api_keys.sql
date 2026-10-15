-- Move each merchant's single API key into api_keys (keys keep working: same SHA-256 hash).
-- The raw key is not stored anywhere, so the displayable prefix is unknown: shown as a neutral "sk_…".
INSERT INTO "api_keys" ("id", "merchant_id", "prefix", "key_hash", "label", "created_at")
SELECT 'key_' || substr(md5(m."id"), 1, 16), m."id", 'sk_…', m."api_key_hash", 'Migrated key', m."created_at"
FROM "merchants" m
ON CONFLICT ("key_hash") DO NOTHING;
