USE vendor_onboarding;

-- Runtime inserts already set these values explicitly. This migration keeps the
-- existing database defaults aligned with new installations.
ALTER TABLE document_translations
  ALTER COLUMN target_language SET DEFAULT 'en',
  ALTER COLUMN provider SET DEFAULT 'LIBRETRANSLATE';
