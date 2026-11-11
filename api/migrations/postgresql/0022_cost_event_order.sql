-- A late historical supplement must not replace a newer event's current cost.
CREATE OR REPLACE VIEW research_effective_costs AS
 SELECT b.sequence,b.event_id,b.product_id,COALESCE(c.signature,b.signature) AS signature,
 COALESCE(c.payload,b.payload) AS payload,b._order,COALESCE(c.summary_payload,b.summary_payload) AS summary_payload,
 COALESCE(c.current_payload,b.current_payload) AS current_payload,COALESCE(e._order,b.sequence) AS event_order
 FROM research_cost_records b LEFT JOIN research_events e ON e.id=b.event_id
 LEFT JOIN LATERAL (
 SELECT signature,payload,summary_payload,current_payload FROM research_cost_corrections WHERE sequence=b.sequence ORDER BY _order DESC LIMIT 1
 ) c ON true;
