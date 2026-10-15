ALTER TABLE projects
    ADD COLUMN creation_key uuid,
    ADD COLUMN creation_title text,
    ADD CHECK ((creation_key IS NULL) = (creation_title IS NULL));
CREATE UNIQUE INDEX ai_project_creation ON projects(owner_id,creation_key) WHERE creation_key IS NOT NULL;
UPDATE schema_metadata SET value=8 WHERE key='schema_version';
