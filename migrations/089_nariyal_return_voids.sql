-- Nariyal "Scan galat tha, hatayein": a parchi marked Maal diya by mistake gets its scan taken
-- back (staff passcode on the terminal). One row cancels one nariyal_returns row (return_id);
-- the parchi then counts as not scanned again: it can be edited, deleted, and scanned again (a
-- new nariyal_returns row, which the duplicate-scan check lets through). Nariyal shops only
-- (sync.service). A fact: written once, never changed. Old app versions do not know the table;
-- the server just stores it, and such a terminal keeps showing the parchi as scanned.

CREATE TABLE nariyal_return_voids (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  return_id    uuid NOT NULL,
  bill_id      uuid NOT NULL,
  staff_name   text NOT NULL DEFAULT '',
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX nariyal_return_voids_return ON nariyal_return_voids (shop_id, return_id);
CREATE INDEX nariyal_return_voids_bill ON nariyal_return_voids (shop_id, bill_id);

GRANT SELECT, INSERT ON nariyal_return_voids TO mandipos_api;
ALTER TABLE nariyal_return_voids ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON nariyal_return_voids TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- A fresh start's snapshot carries them too (086's function, with this table added).
CREATE OR REPLACE FUNCTION sync_reset(p_shop uuid, p_device uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE r bigint; t text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_shop::text, 0));
  DELETE FROM changes WHERE shop_id = p_shop;
  r := sync_append(p_shop, '_reset', gen_random_uuid(), jsonb_build_object('at', now()), p_device);
  UPDATE shop_counters SET reset_seq = r WHERE shop_id = p_shop;
  FOREACH t IN ARRAY ARRAY['brands', 'rates', 'buyers', 'trucks', 'truck_grades', 'bills', 'bill_lines', 'bill_voids',
                           'delivery_slips', 'receivings', 'lading_slips', 'collections', 'collection_voids', 'spoilage',
                           'daybook_entries', 'day_closes', 'terminal_payments', 'udhaar_entries', 'labour_adjustments',
                           'pickups', 'staff', 'supplier_phones', 'breakages', 'office_entries', 'supplier_adjustments',
                           'nariyal_returns', 'nariyal_return_voids'] LOOP
    EXECUTE format(
      'INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
       SELECT $1, (SELECT last_seq FROM shop_counters WHERE shop_id = $1) + row_number() OVER (ORDER BY x.id), %L, x.id, to_jsonb(x), x.device_id
       FROM %I x WHERE x.shop_id = $1', t, t) USING p_shop;
    UPDATE shop_counters SET last_seq = (SELECT max(seq) FROM changes WHERE shop_id = p_shop) WHERE shop_id = p_shop;
  END LOOP;
  INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
  SELECT p_shop, (SELECT last_seq FROM shop_counters WHERE shop_id = p_shop) + row_number() OVER (ORDER BY k.buyer_id), 'kyc', k.buyer_id, kyc_feed_row(k), k.device_id
  FROM buyer_kyc k WHERE k.shop_id = p_shop;
  UPDATE shop_counters SET last_seq = (SELECT max(seq) FROM changes WHERE shop_id = p_shop) WHERE shop_id = p_shop;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION sync_reset(uuid, uuid) FROM PUBLIC;
