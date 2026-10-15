-- Removing the recycle bin leaves all its conversations safely archived.
ALTER TABLE conversations DROP CONSTRAINT conversations_trash_requires_archive,
    DROP COLUMN trashed;
UPDATE schema_metadata SET value=12 WHERE key='schema_version';
