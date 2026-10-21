CREATE OR REPLACE FUNCTION research_refresh_history(target TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE item RECORD; value JSONB; previous JSONB; basis JSONB; current_price NUMERIC; old_price NUMERIC; movement JSONB; period JSONB; event_inputs JSONB; snapshot JSONB; candidate RECORD; counter BIGINT:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(target,83124));
 INSERT INTO research_history_versions(product_id,revision) VALUES(target,1) ON CONFLICT(product_id) DO UPDATE SET revision=research_history_versions.revision+1;
 DELETE FROM research_history_reads WHERE product_id=target;
 FOR item IN
   SELECT summary_payload::jsonb AS value,research_line_prices(payload::jsonb) AS prices,research_visibility(payload::jsonb) AS visibility,0 AS category,purchase_version AS ordering FROM research_backfill_records WHERE product_id=target
   UNION ALL
   SELECT summary_payload::jsonb || jsonb_build_object('record_type','formal','product_id',product_id,'effective_date',substring(summary_payload::jsonb->>'recorded_at',1,10)),research_line_prices(payload::jsonb),research_visibility(payload::jsonb),1,sequence FROM research_cost_records WHERE product_id=target
   ORDER BY category,ordering
 LOOP
   value:=item.value;
   IF value->>'record_type'='formal' THEN
     SELECT jsonb_build_object('purchase_period',read_period,'prices',read_prices) INTO event_inputs FROM research_events WHERE id=value->>'event_id' AND reason='采购正式价格更新';
     period:=event_inputs->'purchase_period';
     IF NULLIF(period->>'price_date','') IS NULL AND event_inputs IS NOT NULL THEN
       SELECT id,version,price_date INTO candidate FROM procurement_price_batches WHERE published_at::timestamptz<=(value->>'recorded_at')::timestamptz ORDER BY version DESC LIMIT 1;
       IF candidate.id IS NOT NULL THEN
         SELECT jsonb_object_agg(code,latest_price) INTO snapshot FROM procurement_price_batch_items WHERE batch_id=candidate.id;
         IF snapshot IS NOT NULL AND event_inputs->'prices' IS NOT NULL AND event_inputs->'prices' NOT IN ('{}'::jsonb,'null'::jsonb) AND NOT EXISTS(
           SELECT 1 FROM jsonb_each(event_inputs->'prices') price WHERE (price.value->>'latest_price')::numeric IS DISTINCT FROM (snapshot->>price.key)::numeric
         ) THEN period:=jsonb_build_object('id',candidate.id,'version',candidate.version,'price_date',candidate.price_date); END IF;
       END IF;
     END IF;
     IF NULLIF(period->>'price_date','') IS NOT NULL THEN value:=value || jsonb_build_object('effective_date',period->>'price_date','purchase_version',period->'version'); END IF;
   END IF;
   current_price:=round((value->>'latest_cost')::numeric,2);
   IF previous IS NOT NULL AND (basis IS NULL OR basis->>'latest_cost' IS NULL OR current_price IS NULL OR current_price IS DISTINCT FROM round((previous->>'latest_cost')::numeric,2)) THEN basis:=previous; END IF;
   old_price:=round((basis->>'latest_cost')::numeric,2);
   IF basis IS NULL THEN movement:=jsonb_build_object('percent',NULL,'reason','首次正式记录，暂无上期成本');
   ELSIF current_price IS NULL OR old_price IS NULL THEN movement:=jsonb_build_object('percent',NULL,'reason','本期或上期缺少价格，暂无对比');
   ELSIF old_price=0 THEN movement:=jsonb_build_object('percent',NULL,'reason','上期成本为零，无法计算百分比');
   ELSE movement:=jsonb_build_object('percent',(current_price-old_price)/old_price*100,'reason','行情优先成本（按两位小数比较）：' || old_price::text || ' → ' || current_price::text); END IF;
   counter:=counter+1;
   INSERT INTO research_history_reads(product_id,event_id,record_type,effective_date,recorded_at,purchase_version,ordinal,payload,line_prices) VALUES(target,COALESCE(value->>'event_id','backfill:'||item.ordering),COALESCE(value->>'record_type','backfill'),COALESCE(value->>'effective_date',''),COALESCE(value->>'recorded_at',''),(value->>'purchase_version')::bigint,counter,
     (value-ARRAY['graph','calculations','formula','source_hashes','latest','inventory','lines']) || jsonb_build_object('_visibility',item.visibility,'change',movement,'comparison_basis',CASE WHEN basis IS NULL THEN NULL ELSE jsonb_build_object('record_type',basis->'record_type','purchase_version',basis->'purchase_version','effective_date',basis->'effective_date','event_id',basis->'event_id','latest_cost',basis->'latest_cost') END),item.prices);
   previous:=value;
 END LOOP;
END $$;

-- Backfill summaries intentionally omit calculation lines; derive masking context from evidence.
UPDATE research_history_reads h SET payload=h.payload || jsonb_build_object('_visibility',research_visibility(source.value))
FROM (SELECT product_id,event_id,payload::jsonb AS value FROM research_cost_records
 UNION ALL SELECT product_id,'backfill:'||purchase_version,payload::jsonb FROM research_backfill_records) source
WHERE h.product_id=source.product_id AND h.event_id=source.event_id;
