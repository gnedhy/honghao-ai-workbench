ALTER TABLE projects ADD COLUMN removed boolean NOT NULL DEFAULT false;
UPDATE schema_metadata SET value=14 WHERE key='schema_version';
