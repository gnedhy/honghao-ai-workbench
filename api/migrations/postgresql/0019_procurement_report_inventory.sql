-- Inventory stays with its import until the owning price round is activated.
ALTER TABLE procurement_imports ADD COLUMN inventory_payload TEXT NOT NULL DEFAULT '[]';
ALTER TABLE procurement_price_batches ADD COLUMN inventory_snapshot TEXT NOT NULL DEFAULT '[]';
