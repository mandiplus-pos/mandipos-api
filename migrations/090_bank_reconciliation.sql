-- Partner bank statement and reconciliation (owner's list 2.6). Website only: never synced.
--
-- * shop_members.role 'partner': a partner of the firm. Signs in to the website only, reads the
--   books and the bank pages, uploads the bank's statement and matches it. Never opens the shop
--   in the app and never pushes rows.
-- * bank_openings: per bank account of the shop (shops.bank_accounts, keyed by the account
--   number as typed, spaces dropped, upper case), the balance the bank showed on a day. The bank
--   ledger starts there. A master: set again to change it.
-- * bank_statement_batches: one upload (a CSV, or a set of lines typed by hand).
-- * bank_statement_lines: what the bank's statement says, line by line. A fact: never edited;
--   a wrong line or a wrong upload is voided (voided_at) and uploaded again.
-- * bank_matches: what a person decided while reconciling. 'manual' pairs a statement line with
--   an app entry; 'reject' says an automatic pair is wrong and must not be made again. Automatic
--   pairs are worked out on every read, so a slip voided later simply drops out.
--   entry_key names the app entry: bill:<id>, col:<id>, dep:<slip id>, chq:<cheque id>,
--   chqfee:<cheque id>, day:<daybook id>.

ALTER TABLE shop_members DROP CONSTRAINT shop_members_role_check;
ALTER TABLE shop_members ADD CONSTRAINT shop_members_role_check CHECK (role IN ('owner', 'manager', 'munim', 'labour', 'partner'));

CREATE TABLE bank_openings (
  shop_id        uuid NOT NULL REFERENCES shops(id),
  account_no     text NOT NULL,
  -- Signed: an overdraft opens below zero.
  opening_paise  bigint NOT NULL,
  opening_on     date NOT NULL,
  updated_by     text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, account_no)
);

CREATE TABLE bank_statement_batches (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  account_no   text NOT NULL,
  source       text NOT NULL CHECK (source IN ('csv', 'manual')),
  file_name    text NOT NULL DEFAULT '',
  line_count   integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,
  uploaded_by  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz
);
CREATE INDEX bank_statement_batches_recent ON bank_statement_batches (shop_id, account_no, created_at DESC);

CREATE TABLE bank_statement_lines (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  account_no     text NOT NULL,
  batch_id       uuid NOT NULL REFERENCES bank_statement_batches(id),
  -- Order inside its upload: the statement's own order, which the running balance follows.
  pos            integer NOT NULL DEFAULT 0,
  line_date      date NOT NULL,
  -- 'cr' = money into the account (the bank's Credit / Deposit), 'dr' = money out.
  direction      text NOT NULL CHECK (direction IN ('cr', 'dr')),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  ref            text NOT NULL DEFAULT '',
  narration      text NOT NULL DEFAULT '',
  -- The bank's balance after this line, when the statement has one.
  balance_paise  bigint,
  source         text NOT NULL CHECK (source IN ('csv', 'manual')),
  uploaded_by    text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz
);
CREATE INDEX bank_statement_lines_day ON bank_statement_lines (shop_id, account_no, line_date);
CREATE INDEX bank_statement_lines_batch ON bank_statement_lines (batch_id, pos);

CREATE TABLE bank_matches (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  line_id     uuid NOT NULL REFERENCES bank_statement_lines(id),
  entry_key   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('manual', 'reject')),
  matched_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One to one: a line pairs with one entry, an entry with one line.
CREATE UNIQUE INDEX bank_matches_line ON bank_matches (shop_id, line_id) WHERE kind = 'manual';
CREATE UNIQUE INDEX bank_matches_entry ON bank_matches (shop_id, entry_key) WHERE kind = 'manual';
CREATE UNIQUE INDEX bank_matches_reject ON bank_matches (shop_id, line_id, entry_key) WHERE kind = 'reject';

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_openings, bank_matches TO mandipos_api;
-- Statement lines and their uploads are facts: written and voided, never deleted.
GRANT SELECT, INSERT, UPDATE ON bank_statement_batches, bank_statement_lines TO mandipos_api;

ALTER TABLE bank_openings ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON bank_openings TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE bank_statement_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON bank_statement_batches TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON bank_statement_lines TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
ALTER TABLE bank_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON bank_matches TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
