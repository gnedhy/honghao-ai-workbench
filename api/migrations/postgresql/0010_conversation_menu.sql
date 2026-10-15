ALTER TABLE conversations ADD COLUMN pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN archived boolean NOT NULL DEFAULT false;
UPDATE schema_metadata SET value=10 WHERE key='schema_version';
