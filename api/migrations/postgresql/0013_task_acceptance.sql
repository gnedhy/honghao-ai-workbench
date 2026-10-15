ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('created','running','waiting','review','completed','stopped','failed','blocked'));
ALTER TABLE task_runs ADD COLUMN accepted_at text,
    ADD COLUMN accepted_by text REFERENCES identity_users(id),
    ADD CONSTRAINT task_run_acceptance CHECK (
        (accepted_at IS NULL AND accepted_by IS NULL) OR
        (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND accepted_by=owner_id
         AND task_id IS NOT NULL AND status='completed' AND phase='ended')
    );
-- Historical run success is not evidence of human acceptance.
UPDATE tasks SET status='review',revision=revision+1 WHERE status='completed';
UPDATE schema_metadata SET value=13 WHERE key='schema_version';
