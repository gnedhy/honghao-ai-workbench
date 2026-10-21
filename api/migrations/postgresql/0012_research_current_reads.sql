-- Keep the current ledger independent of per-record calculation detail size.
CREATE FUNCTION research_current_payload(value JSONB) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$ SELECT
 ((value - ARRAY['graph','calculations','formula','source_hashes','latest','inventory','lines']) ||
  jsonb_build_object('lines',jsonb_array_length(COALESCE(value->'lines','[]'::jsonb)),
    'cost_details',jsonb_build_object(
      'latest',jsonb_build_object('cost_source',value->'latest'->'cost_source','auto_cost',value->'latest'->'auto_cost','difference',value->'latest'->'difference'),
      'inventory',jsonb_build_object('cost_source',value->'inventory'->'cost_source','auto_cost',value->'inventory'->'auto_cost','difference',value->'inventory'->'difference'))))::text
$$;
ALTER TABLE research_cost_records ADD COLUMN current_payload TEXT GENERATED ALWAYS AS (research_current_payload(payload::jsonb)) STORED;
