CREATE TABLE IF NOT EXISTS honghao_meta.read_versions (
    table_name text PRIMARY KEY,
    version bigint NOT NULL DEFAULT 0,
    transaction_id xid8
);
CREATE OR REPLACE FUNCTION honghao_meta.bump_read_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE honghao_meta.read_versions SET version=version+1, transaction_id=pg_current_xact_id()
    WHERE table_name=TG_TABLE_NAME AND transaction_id IS DISTINCT FROM pg_current_xact_id();
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION honghao_meta.bump_read_version() FROM PUBLIC;
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_formulas') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_formulas FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_drafts') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_drafts FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_cost_records') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_cost_records FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_events') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_events FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_backfill_records') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_backfill_records FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_backfill_runs') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_backfill_runs FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_meta') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_meta FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_price_batches') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_price_batches FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_price_batch_items') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_price_batch_items FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_materials') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_materials FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_departments') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_departments FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_department_materials') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_department_materials FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('identity_users') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON identity_users FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('identity_user_scopes') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON identity_user_scopes FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('organization_memberships') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_memberships FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('organization_departments') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON organization_departments FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('research_activation_grants') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON research_activation_grants FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_inventory') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_inventory FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_material_sources') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_material_sources FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_snapshot_sources') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_snapshot_sources FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_saved_changes') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_saved_changes FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_updates') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_updates FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_update_events') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_update_events FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_price_history') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_price_history FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();
INSERT INTO honghao_meta.read_versions(table_name) VALUES ('procurement_imports') ON CONFLICT (table_name) DO UPDATE SET version=honghao_meta.read_versions.version+1,transaction_id=NULL;
CREATE TRIGGER read_version AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON procurement_imports FOR EACH STATEMENT EXECUTE FUNCTION honghao_meta.bump_read_version();

DO $$ DECLARE reader record; BEGIN
    FOR reader IN SELECT rolname FROM pg_roles WHERE has_table_privilege(rolname, 'honghao_meta.database_identity', 'SELECT') LOOP
        EXECUTE format('GRANT SELECT ON honghao_meta.read_versions TO %I',reader.rolname);
    END LOOP;
END $$;
