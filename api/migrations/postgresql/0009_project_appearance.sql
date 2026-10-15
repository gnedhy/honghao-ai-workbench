ALTER TABLE projects
    ADD COLUMN icon text NOT NULL DEFAULT 'folder' CHECK (icon IN ('folder','briefcase','flask','chart','code','book','lightbulb','palette')),
    ADD COLUMN color text NOT NULL DEFAULT 'blue' CHECK (color IN ('blue','green','amber','violet','rose','slate')),
    ADD COLUMN creation_icon text,
    ADD COLUMN creation_color text;
UPDATE projects SET creation_icon=icon,creation_color=color WHERE creation_key IS NOT NULL;
ALTER TABLE projects ADD CHECK ((creation_key IS NULL) = (creation_icon IS NULL) AND (creation_key IS NULL) = (creation_color IS NULL));
UPDATE schema_metadata SET value=9 WHERE key='schema_version';
