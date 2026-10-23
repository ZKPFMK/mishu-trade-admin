-- Exact-title search shares the indexed query path with order/user/asset identifiers.
CREATE INDEX trade_title_search ON trade_projections(application_id, (document->>'asset_title'));
