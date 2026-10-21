-- Locate the last attribution event in each source before reconstructing its name.
CREATE INDEX procurement_saved_material_update ON procurement_saved_changes(material_id,update_id,created_at DESC,_order DESC);
CREATE INDEX procurement_history_material_import ON procurement_price_history(material_id,import_id);
CREATE INDEX procurement_batches_update_version ON procurement_price_batches(update_id,version DESC);
CREATE OR REPLACE FUNCTION procurement_price_modifier(material_key TEXT,target_version INTEGER) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
SELECT jsonb_build_object('kind',CASE WHEN kind='source' AND name='' THEN 'unknown' ELSE kind END,'name',name,'id',actor)
FROM (
    (SELECT b.version,3 AS priority,'system' AS kind,c.actor_name AS name,c.actor_id AS actor,c._order AS seq
    FROM procurement_saved_changes c JOIN procurement_updates u ON u.id=c.update_id JOIN procurement_price_batches b ON b.update_id=c.update_id
    WHERE c.material_id=material_key AND b.version<=target_version AND u.status!='cancelled'
    ORDER BY b.version DESC,c.created_at DESC,c._order DESC LIMIT 1)
    UNION ALL
    SELECT source.version,2,'source',COALESCE((SELECT string_agg(DISTINCT trim(ms.raw_json::jsonb->>0),'、' ORDER BY trim(ms.raw_json::jsonb->>0))
        FROM procurement_material_sources ms WHERE ms.material_id=material_key AND ms.sheet=source.sheet AND ms.sha256=source.sha256
        AND NULLIF(trim(ms.raw_json::jsonb->>0),'') IS NOT NULL),''),NULL,0
    FROM (SELECT b.version,s.sheet,s.sha256 FROM procurement_snapshot_sources s JOIN procurement_price_batches b ON b.id=s.batch_id
        WHERE s.material_id=material_key AND b.version<=target_version AND NULLIF(s.sha256,'') IS NOT NULL
        ORDER BY b.version DESC LIMIT 1) source
    UNION ALL
    (SELECT b.version,1,'unknown','',NULL,0 FROM procurement_price_history h JOIN procurement_imports imp ON imp.id=h.import_id
    JOIN procurement_price_batches b ON b.update_id=imp.update_id WHERE h.material_id=material_key AND b.version<=target_version
    ORDER BY b.version DESC LIMIT 1)
) attribution ORDER BY version DESC,priority DESC,seq DESC LIMIT 1;
$$;
-- History imports can insert frozen items before their batch header.
DROP TRIGGER procurement_read_point ON procurement_price_batches;
CREATE TRIGGER procurement_read_point AFTER INSERT OR UPDATE ON procurement_price_batches FOR EACH ROW EXECUTE FUNCTION procurement_price_read_changed();
SELECT refresh_procurement_price_read(id) FROM procurement_price_batches;
