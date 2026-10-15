-- Keep the list projection derived from its frozen payload in the same write.
ALTER TABLE research_cost_records ADD COLUMN summary_payload TEXT GENERATED ALWAYS AS (
    (payload::jsonb - ARRAY['graph','calculations','formula','source_hashes'])::text
) STORED;

ALTER TABLE research_backfill_records ADD COLUMN summary_payload TEXT GENERATED ALWAYS AS (
    (payload::jsonb - ARRAY['graph','calculations','formula','source_hashes'])::text
) STORED;
