ALTER TABLE conversations ADD COLUMN trashed boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT conversations_trash_requires_archive CHECK (NOT trashed OR archived);
UPDATE schema_metadata SET value=11 WHERE key='schema_version';
