import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, Tx } from '../db/db.service';
import { uuidv7 } from '../common/uuid';
import { SettingsService } from './settings.service';
import { LIVE_BILLS, LIVE_COLS, UPI_PART, n } from './sql';
import { parseStatement, preview, type CsvMapping, type DateOrder } from './bank-csv';

/**
 * Bank book per account, and the partner's reconciliation against the bank's own statement
 * (owner's list 2.6: "the opening and closing balance need to be shown, so every other thing is
 * calculated, so the partner should be able to add its bank statement").
 *
 * The app side of an account, from its opening date:
 *  - the UPI part of each slip and each raseed whose upi_bank names this account;
 *  - each deposit slip's cash (Bank Jama Parchi) into the slip's account, and each cheque on a
 *    slip that cleared without a raseed of its own (a cheque's raseed is already a UPI raseed
 *    naming the account); a bounced cheque's charges go out;
 *  - Day Book lines in bank or UPI mode (supplier payments included: they are Day Book lines),
 *    and cash put into the bank (bank_jama) that is not a deposit slip's own line.
 * Which account: upi_bank (or a Day Book line's party) is matched to an account by its last four
 * digits, else by the bank's name. A line that names no bank goes to the first account in
 * Settings; when the shop has more than one account it is marked "assumed" so it can be checked.
 * A line naming a bank that is no account of the shop belongs to none and is counted apart.
 */

export type Account = { key: string; bank: string; account: string; holder: string; ifsc: string; label: string };
export type AppEntry = {
  key: string; date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string;
  kind: 'bikri' | 'vasooli' | 'jama' | 'cheque' | 'charges' | 'daybook'; title: string; party: string; note: string; assumed: boolean;
};
export type StatementLine = {
  id: string; date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string; narration: string; balancePaise: number | null;
  source: 'csv' | 'manual'; batchId: string; uploadedBy: string;
};
export type LineInput = { date: string; direction: 'cr' | 'dr'; amountPaise: number; ref?: string; narration?: string; balancePaise?: number | null };

const ALL_FROM = '0001-01-01';
const MAX_LINES = 5000;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
const signed = (direction: 'cr' | 'dr', paise: number) => (direction === 'cr' ? paise : -paise);
/** An account number as the key: spaces and dashes dropped, upper case. */
export const accountKey = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

/** A reference's comparable pieces: the whole of it and each digit run, leading zeros dropped. */
function refTokens(ref: string): string[] {
  const up = ref.toUpperCase();
  const out = new Set<string>();
  const whole = up.replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  if (whole.length >= 6) out.add(whole);
  for (const t of up.match(/[A-Z0-9]+/g) ?? []) {
    const z = t.replace(/^0+/, '');
    if (z.length >= 6 && /\d{4}/.test(z)) out.add(z);
  }
  return [...out];
}
/** Whether an app entry's ref is in a statement line's ref or narration. */
function refHit(entryRef: string, line: { ref: string; narration: string }): boolean {
  const mine = refTokens(entryRef);
  if (!mine.length) return false;
  const theirs = new Set([...refTokens(line.ref), ...refTokens(line.narration)]);
  const flat = `${line.ref} ${line.narration}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return mine.some((t) => theirs.has(t) || (t.length >= 8 && flat.includes(t)));
}

@Injectable()
export class BankService {
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  /** The shop's accounts (Settings), each with its opening and what has been uploaded for it. */
  async accounts(shopId: string) {
    const accounts = await this.accountList(shopId);
    return this.db.withShop(shopId, async (tx) => {
      const openings = await this.openings(tx);
      const stats = (await tx.query<{ account_no: string; lines: string; first: string | null; last: string | null }>(
        `SELECT account_no, COUNT(*) AS lines, MIN(line_date)::text AS first, MAX(line_date)::text AS last
         FROM bank_statement_lines WHERE voided_at IS NULL GROUP BY account_no`)).rows;
      return {
        today: istToday(),
        accounts: accounts.map((a) => {
          const o = openings.get(a.key);
          const s = stats.find((x) => x.account_no === a.key);
          return { ...a, opening: o ? { paise: o.paise, on: o.on, by: o.by } : null, statement: { lines: n(s?.lines), first: s?.first ?? null, last: s?.last ?? null } };
        }),
      };
    });
  }

  async setOpening(shopId: string, by: string, key: string, paise: number, on: string) {
    await this.account(shopId, key);
    await this.db.withShop(shopId, (tx) => tx.query(
      `INSERT INTO bank_openings (shop_id, account_no, opening_paise, opening_on, updated_by) VALUES (current_setting('app.shop_id')::uuid, $1, $2, $3, $4)
       ON CONFLICT (shop_id, account_no) DO UPDATE SET opening_paise = EXCLUDED.opening_paise, opening_on = EXCLUDED.opening_on, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, paise, on, by]));
    return this.accounts(shopId);
  }

  // ---------------------------------------------------------------- the bank ledger

  /** One account's book over [from, to]: brought forward from the opening, every line with a running balance, carried forward. */
  async ledger(shopId: string, key: string, from?: string, to?: string) {
    const all = await this.accountList(shopId);
    const account = this.pick(all, key);
    return this.db.withShop(shopId, async (tx) => {
      const opening = (await this.openings(tx)).get(key) ?? null;
      const since = opening?.on ?? ALL_FROM;
      const end = to ?? istToday();
      const start = from ?? opening?.on ?? `${end.slice(0, 8)}01`;
      if (start > end) throw new BadRequestException('from must be on or before to');
      const book = await this.book(tx, all, key, opening, since, start, end);
      return { account, opening: opening && { paise: opening.paise, on: opening.on }, from: start, to: end, ...book };
    });
  }

  private async book(tx: Tx, all: Account[], key: string, opening: Opening | null, since: string, from: string, to: string) {
    const { entries, unassigned } = await this.entries(tx, all, key, since, to);
    const before = entries.filter((e) => e.date < from);
    const openingPaise = (opening?.paise ?? 0) + before.reduce((t, e) => t + signed(e.direction, e.amountPaise), 0);
    const period = entries.filter((e) => e.date >= from && e.date <= to);
    let bal = openingPaise;
    const lines = period.map((e) => ({ ...e, balancePaise: (bal += signed(e.direction, e.amountPaise)) }));
    const inPaise = period.filter((e) => e.direction === 'cr').reduce((t, e) => t + e.amountPaise, 0);
    const outPaise = period.filter((e) => e.direction === 'dr').reduce((t, e) => t + e.amountPaise, 0);
    return {
      openingPaise, inPaise, outPaise, closingPaise: openingPaise + inPaise - outPaise, lines,
      // Money naming a bank that is none of the shop's accounts: shown, never counted.
      unassigned: unassigned.filter((e) => e.date >= from && e.date <= to),
      // The opening only counts from its own day: lines before it are not this book's.
      beforeOpening: opening ? from < opening.on : false,
    };
  }

  /** Every app entry of [since, to], for one account; and those naming no account of the shop. */
  async entries(tx: Tx, all: Account[], key: string, since: string, to: string): Promise<{ entries: AppEntry[]; unassigned: AppEntry[] }> {
    const many = all.length > 1;
    const first = all[0]?.key ?? null;
    /** Which account a label names: its key, null for none of them, '' when it names no bank at all. */
    const whose = (label: string): string | null => {
      const l = label.trim();
      if (!l) return '';
      const runs = (l.match(/\d{4,}/g) ?? []).map((r) => r.slice(-4));
      const byDigits = all.filter((a) => runs.some((r) => a.key.endsWith(r)));
      if (byDigits.length === 1) return byDigits[0].key;
      const name = l.toLowerCase().replace(/[^a-z]/g, '');
      const byName = (byDigits.length ? byDigits : all).filter((a) => a.bank && name.startsWith(a.bank.toLowerCase().replace(/[^a-z]/g, '')));
      return byName.length === 1 ? byName[0].key : null;
    };
    const mine: AppEntry[] = [], other: AppEntry[] = [];
    const put = (e: Omit<AppEntry, 'assumed'>, label: string) => {
      const w = whose(label);
      if (w === '') {
        if (first === key) mine.push({ ...e, assumed: many });
      } else if (w === key) mine.push({ ...e, assumed: false });
      else if (w === null) other.push({ ...e, assumed: false });
    };

    const bills = (await tx.query<{ id: string; day: string; amt: string; ref: string; bank: string; slip_no: number | null; number: string; name: string }>(
      `SELECT lb.id, lb.business_date::text AS day, lb.upi_paise AS amt, lb.payment_ref AS ref, lb.upi_bank AS bank, lb.slip_no, lb.number, lb.buyer_name AS name
       FROM ${LIVE_BILLS} lb WHERE lb.upi_paise > 0 AND lb.business_date BETWEEN $1 AND $2`, [since, to])).rows;
    for (const b of bills) {
      put({ key: `bill:${b.id}`, date: b.day, direction: 'cr', amountPaise: n(b.amt), ref: b.ref, kind: 'bikri', title: 'UPI bikri',
        party: b.name, note: b.slip_no ? `Parchi #${b.slip_no}` : b.number }, b.bank);
    }

    const cols = (await tx.query<{ id: string; day: string; amt: string; ref: string; bank: string; receipt_no: number | null; name: string | null }>(
      `SELECT MIN(lc.id::text) AS id, lc.business_date::text AS day, SUM(lc.upi) AS amt, MAX(lc.payment_ref) AS ref, MAX(lc.upi_bank) AS bank,
              MAX(lc.receipt_no) AS receipt_no, MAX(g.name) AS name
       FROM (SELECT c.*, ${UPI_PART} AS upi FROM ${LIVE_COLS} c) lc LEFT JOIN buyers g ON g.id = lc.buyer_id
       WHERE lc.business_date BETWEEN $1 AND $2 GROUP BY lc.buyer_id, lc.created_at, lc.business_date HAVING SUM(lc.upi) > 0`, [since, to])).rows;
    for (const c of cols) {
      put({ key: `col:${c.id}`, date: c.day, direction: 'cr', amountPaise: n(c.amt), ref: c.ref, kind: 'vasooli', title: 'UPI vasooli',
        party: c.name ?? '', note: c.receipt_no ? `Raseed #${c.receipt_no}` : '' }, c.bank);
    }

    const slips = (await tx.query<{ id: string; slip_no: number; day: string; acct: string | null; bank: string | null; cash: string }>(
      `SELECT id, slip_no, day::text AS day, account->>'account' AS acct, account->>'bank' AS bank, cash_paise AS cash
       FROM deposit_slips WHERE voided_at IS NULL AND cash_paise > 0 AND day BETWEEN $1 AND $2`, [since, to])).rows;
    for (const s of slips) {
      const k = accountKey(s.acct ?? '');
      const e = { key: `dep:${s.id}`, date: s.day, direction: 'cr' as const, amountPaise: n(s.cash), ref: '', kind: 'jama' as const, title: 'Bank jama (cash)',
        party: '', note: `Bank parchi #${s.slip_no}` };
      if (k === key) mine.push({ ...e, assumed: false });
      else if (!all.some((a) => a.key === k)) other.push({ ...e, assumed: false });
    }

    const cheques = (await tx.query<{ id: string; day: string; amt: string; charges: string; status: string; collection_id: string | null; cheque_no: string; drawer: string; acct: string | null; slip_no: number }>(
      `SELECT d.id, COALESCE(d.status_on, s.day)::text AS day, d.amount_paise AS amt, d.charges_paise AS charges, d.status, d.collection_id,
              d.cheque_no, d.drawer, s.account->>'account' AS acct, s.slip_no
       FROM deposit_cheques d JOIN deposit_slips s ON s.id = d.slip_id
       WHERE s.voided_at IS NULL AND d.status IN ('cleared', 'bounced') AND COALESCE(d.status_on, s.day) BETWEEN $1 AND $2`, [since, to])).rows;
    for (const c of cheques) {
      if (accountKey(c.acct ?? '') !== key) continue;
      if (c.status === 'cleared' && !c.collection_id) {
        mine.push({ key: `chq:${c.id}`, date: c.day, direction: 'cr', amountPaise: n(c.amt), ref: c.cheque_no, kind: 'cheque', title: 'Cheque clear',
          party: c.drawer, note: `Bank parchi #${c.slip_no}`, assumed: false });
      }
      if (c.status === 'bounced' && n(c.charges) > 0) {
        mine.push({ key: `chqfee:${c.id}`, date: c.day, direction: 'dr', amountPaise: n(c.charges), ref: c.cheque_no, kind: 'charges', title: 'Cheque bounce charges',
          party: c.drawer, note: `Bank parchi #${c.slip_no}`, assumed: false });
      }
    }

    const day = (await tx.query<{ id: string; day: string; direction: string; mode: string; category: string; party: string; note: string; amt: string }>(
      `SELECT e.id, e.business_date::text AS day, e.direction, e.mode, e.category, e.party_name AS party, e.note, e.amount_paise AS amt
       FROM daybook_entries e
       WHERE e.hidden = false AND e.category <> 'opening' AND e.business_date BETWEEN $1 AND $2
         AND (e.mode IN ('upi', 'bank') OR e.category = 'bank_jama')
         AND NOT EXISTS (SELECT 1 FROM deposit_slips s WHERE s.daybook_id = e.id)`, [since, to])).rows;
    for (const e of day) {
      const bankMode = e.mode === 'upi' || e.mode === 'bank';
      // Cash put into the bank is written once, as "out" of the galla: here it comes in.
      const direction: 'cr' | 'dr' = !bankMode || e.direction === 'in' ? 'cr' : 'dr';
      put({ key: `day:${e.id}`, date: e.day, direction, amountPaise: n(e.amt), ref: '', kind: 'daybook', title: e.category || (direction === 'cr' ? 'aaya' : 'gaya'),
        party: e.party, note: e.note }, whose(e.party) === null ? '' : e.party);
    }

    const order = (a: AppEntry, b: AppEntry) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key);
    return { entries: mine.sort(order), unassigned: other.sort(order) };
  }

  // ---------------------------------------------------------------- statement upload

  /** The mapping step: header found, columns guessed, first rows. Nothing is saved. */
  csvPreview(text: string) {
    const p = preview(text);
    if (!p.rows) throw new BadRequestException('File mein koi line nahi mili');
    return p;
  }

  async csvImport(shopId: string, by: string, key: string, input: { text: string; fileName: string; headerRow: number; mapping: CsvMapping; dateOrder: DateOrder }) {
    await this.account(shopId, key);
    const m = input.mapping;
    if (m.debit === undefined && m.credit === undefined && m.amount === undefined) throw new BadRequestException('Debit/Credit ya Amount ka column chunein');
    const { lines, skipped } = parseStatement(input.text, input.headerRow, m, input.dateOrder);
    if (!lines.length) throw new BadRequestException('Ek bhi line nahi padh paye: tarikh aur rakam ke column dekhein');
    return this.save(shopId, by, key, 'csv', input.fileName, lines, skipped.length);
  }

  async addLines(shopId: string, by: string, key: string, lines: LineInput[]) {
    await this.account(shopId, key);
    return this.save(shopId, by, key, 'manual', '', lines.map((l) => ({
      date: l.date, direction: l.direction, amountPaise: l.amountPaise, ref: (l.ref ?? '').trim(), narration: (l.narration ?? '').trim(), balancePaise: l.balancePaise ?? null,
    })), 0);
  }

  /**
   * One upload, as a batch. A line already uploaded before (same day, side, amount, ref, narration
   * and balance) is left out, so an overlapping statement can be uploaded again safely.
   */
  private async save(shopId: string, by: string, key: string, source: 'csv' | 'manual', fileName: string,
    lines: { date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string; narration: string; balancePaise: number | null }[], skipped: number) {
    if (lines.length > MAX_LINES) throw new BadRequestException(`Ek baar mein ${MAX_LINES} line tak`);
    return this.db.withShop(shopId, async (tx) => {
      const have = (await tx.query<{ day: string; direction: string; amt: string; ref: string; narration: string; bal: string | null }>(
        `SELECT line_date::text AS day, direction, amount_paise AS amt, ref, narration, balance_paise AS bal FROM bank_statement_lines
         WHERE voided_at IS NULL AND account_no = $1 AND line_date BETWEEN $2 AND $3`,
        [key, lines.reduce((a, l) => (l.date < a ? l.date : a), lines[0]?.date ?? ALL_FROM), lines.reduce((a, l) => (l.date > a ? l.date : a), lines[0]?.date ?? ALL_FROM)])).rows;
      const sig = (d: string, dir: string, amt: number, ref: string, nar: string, bal: number | null) => [d, dir, amt, ref, nar, bal ?? ''].join('|');
      const seen = new Set(have.map((h) => sig(h.day, h.direction, n(h.amt), h.ref, h.narration, h.bal === null ? null : n(h.bal))));
      const fresh = lines.filter((l) => !seen.has(sig(l.date, l.direction, l.amountPaise, l.ref, l.narration, l.balancePaise)));
      const batchId = uuidv7();
      await tx.query(
        `INSERT INTO bank_statement_batches (id, shop_id, account_no, source, file_name, line_count, skipped, uploaded_by)
         VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7)`,
        [batchId, key, source, fileName.slice(0, 120), fresh.length, skipped + (lines.length - fresh.length), by]);
      for (const [pos, l] of fresh.entries()) {
        await tx.query(
          `INSERT INTO bank_statement_lines (id, shop_id, account_no, batch_id, pos, line_date, direction, amount_paise, ref, narration, balance_paise, source, uploaded_by)
           VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [uuidv7(), key, batchId, pos, l.date, l.direction, l.amountPaise, l.ref.slice(0, 60), l.narration.slice(0, 300), l.balancePaise, source, by]);
      }
      const dates = fresh.map((l) => l.date).sort();
      return { batchId, added: fresh.length, duplicates: lines.length - fresh.length, skipped, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
    });
  }

  async batches(shopId: string, key: string) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await tx.query<{ id: string; source: string; file_name: string; line_count: number; skipped: number; uploaded_by: string; created_at: Date; voided_at: Date | null; first: string | null; last: string | null }>(
        `SELECT b.id, b.source, b.file_name, b.line_count, b.skipped, b.uploaded_by, b.created_at, b.voided_at,
                (SELECT MIN(line_date)::text FROM bank_statement_lines l WHERE l.batch_id = b.id) AS first,
                (SELECT MAX(line_date)::text FROM bank_statement_lines l WHERE l.batch_id = b.id) AS last
         FROM bank_statement_batches b WHERE b.account_no = $1 ORDER BY b.created_at DESC LIMIT 200`, [key])).rows;
      return { batches: rows.map((r) => ({
        id: r.id, source: r.source, fileName: r.file_name, lines: r.line_count, skipped: r.skipped, by: r.uploaded_by,
        at: r.created_at.toISOString(), voided: !!r.voided_at, from: r.first, to: r.last,
      })) };
    });
  }

  /** A wrong upload taken back whole: its lines are voided, and any match made on them goes too. */
  async voidBatch(shopId: string, batchId: string) {
    await this.db.withShop(shopId, async (tx) => {
      const b = (await tx.query(`UPDATE bank_statement_batches SET voided_at = now() WHERE id = $1 AND voided_at IS NULL`, [batchId])).rowCount;
      if (!b) throw new NotFoundException('Yeh upload nahi mila');
      await tx.query(`UPDATE bank_statement_lines SET voided_at = now() WHERE batch_id = $1 AND voided_at IS NULL`, [batchId]);
      await tx.query(`DELETE FROM bank_matches WHERE line_id IN (SELECT id FROM bank_statement_lines WHERE batch_id = $1)`, [batchId]);
    });
  }

  async voidLine(shopId: string, lineId: string) {
    await this.db.withShop(shopId, async (tx) => {
      const r = (await tx.query(`UPDATE bank_statement_lines SET voided_at = now() WHERE id = $1 AND voided_at IS NULL`, [lineId])).rowCount;
      if (!r) throw new NotFoundException('Yeh line nahi mili');
      await tx.query(`DELETE FROM bank_matches WHERE line_id = $1`, [lineId]);
    });
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * The statement against the app over [from, to]. Pairs are one to one: a person's own pairs
   * first; then by UTR / reference (the app's ref found in the line's ref or narration); then by
   * the same amount on the same side within a day, nearest first. A pair a person took apart
   * ('reject') is never made again by itself.
   */
  async reconcile(shopId: string, key: string, from?: string, to?: string) {
    const all = await this.accountList(shopId);
    const account = this.pick(all, key);
    return this.db.withShop(shopId, async (tx) => {
      const opening = (await this.openings(tx)).get(key) ?? null;
      const end = to ?? istToday();
      const start = from ?? opening?.on ?? `${end.slice(0, 8)}01`;
      if (start > end) throw new BadRequestException('from must be on or before to');
      const since = opening?.on ?? ALL_FROM;
      const book = await this.book(tx, all, key, opening, since, start, end);
      // A day either side, so a payment on the 31st that the bank shows on the 1st still pairs.
      const near = (await this.entries(tx, all, key, since, addDays(end, 1))).entries.filter((e) => e.date >= addDays(start, -1));
      const lines = await this.statementLines(tx, key, start, end);
      const decided = (await tx.query<{ line_id: string; entry_key: string; kind: 'manual' | 'reject' }>(
        `SELECT line_id, entry_key, kind FROM bank_matches WHERE line_id = ANY($1::uuid[])`, [lines.map((l) => l.id)])).rows;

      const rejected = new Set(decided.filter((d) => d.kind === 'reject').map((d) => `${d.line_id}|${d.entry_key}`));
      const byKey = new Map(near.map((e) => [e.key, e]));
      const usedLine = new Set<string>(), usedEntry = new Set<string>();
      const pairs: { line: StatementLine; entry: AppEntry; how: 'manual' | 'ref' | 'amount' }[] = [];
      const pair = (line: StatementLine, entry: AppEntry, how: 'manual' | 'ref' | 'amount') => {
        usedLine.add(line.id); usedEntry.add(entry.key); pairs.push({ line, entry, how });
      };
      for (const d of decided.filter((x) => x.kind === 'manual')) {
        const line = lines.find((l) => l.id === d.line_id), entry = byKey.get(d.entry_key);
        if (line && entry && !usedLine.has(line.id) && !usedEntry.has(entry.key)) pair(line, entry, 'manual');
      }
      const free = (l: StatementLine, e: AppEntry) => !usedEntry.has(e.key) && e.direction === l.direction && !rejected.has(`${l.id}|${e.key}`);
      for (const l of lines) {
        if (usedLine.has(l.id)) continue;
        const hits = near.filter((e) => free(l, e) && e.ref && refHit(e.ref, l))
          .sort((a, b) => Number(a.amountPaise !== l.amountPaise) - Number(b.amountPaise !== l.amountPaise) || daysApart(a.date, l.date) - daysApart(b.date, l.date));
        if (hits[0]) pair(l, hits[0], 'ref');
      }
      const candidates: { l: StatementLine; e: AppEntry; gap: number; i: number }[] = [];
      lines.forEach((l, i) => {
        if (usedLine.has(l.id)) return;
        for (const e of near) if (free(l, e) && e.amountPaise === l.amountPaise && daysApart(e.date, l.date) <= 1) candidates.push({ l, e, gap: daysApart(e.date, l.date), i });
      });
      candidates.sort((a, b) => a.gap - b.gap || a.i - b.i || a.e.date.localeCompare(b.e.date) || a.e.key.localeCompare(b.e.key));
      for (const c of candidates) if (!usedLine.has(c.l.id) && !usedEntry.has(c.e.key)) pair(c.l, c.e, 'amount');

      const order = (a: { line: StatementLine }, b: { line: StatementLine }) => lines.indexOf(a.line) - lines.indexOf(b.line);
      const matched = pairs.filter((p) => p.line.amountPaise === p.entry.amountPaise).sort(order);
      const amountDiffers = pairs.filter((p) => p.line.amountPaise !== p.entry.amountPaise).sort(order)
        .map((p) => ({ ...p, diffPaise: signed(p.line.direction, p.line.amountPaise) - signed(p.entry.direction, p.entry.amountPaise) }));
      const bankOnly = lines.filter((l) => !usedLine.has(l.id));
      const appOnly = near.filter((e) => !usedEntry.has(e.key) && e.date >= start && e.date <= end);

      // The bank's own opening and closing, when its lines carry a balance.
      const firstBal = lines.find((l) => l.balancePaise !== null);
      const lastBal = [...lines].reverse().find((l) => l.balancePaise !== null);
      const sIn = lines.filter((l) => l.direction === 'cr').reduce((t, l) => t + l.amountPaise, 0);
      const sOut = lines.filter((l) => l.direction === 'dr').reduce((t, l) => t + l.amountPaise, 0);
      const sOpening = firstBal && firstBal === lines[0] ? firstBal.balancePaise! - signed(firstBal.direction, firstBal.amountPaise) : null;
      const sClosing = lastBal && lastBal === lines[lines.length - 1] ? lastBal.balancePaise! : null;
      return {
        account, opening: opening && { paise: opening.paise, on: opening.on }, from: start, to: end,
        statement: { openingPaise: sOpening, closingPaise: sClosing, inPaise: sIn, outPaise: sOut, lines: lines.length },
        app: { openingPaise: book.openingPaise, closingPaise: book.closingPaise, inPaise: book.inPaise, outPaise: book.outPaise, entries: book.lines.length },
        difference: {
          openingPaise: sOpening === null ? null : sOpening - book.openingPaise,
          closingPaise: sClosing === null ? null : sClosing - book.closingPaise,
          netPaise: (sIn - sOut) - (book.inPaise - book.outPaise),
        },
        matched, amountDiffers, bankOnly, appOnly,
        counts: { matched: matched.length, amountDiffers: amountDiffers.length, bankOnly: bankOnly.length, appOnly: appOnly.length },
      };
    });
  }

  /** A person's own pair; any earlier "not these two" between them is dropped. */
  async match(shopId: string, by: string, lineId: string, entryKey: string) {
    await this.db.withShop(shopId, async (tx) => {
      const line = (await tx.query(`SELECT 1 FROM bank_statement_lines WHERE id = $1 AND voided_at IS NULL`, [lineId])).rowCount;
      if (!line) throw new NotFoundException('Yeh line nahi mili');
      const taken = (await tx.query<{ line_id: string; entry_key: string }>(
        `SELECT line_id, entry_key FROM bank_matches WHERE kind = 'manual' AND (line_id = $1 OR entry_key = $2)`, [lineId, entryKey])).rows;
      if (taken.some((t) => t.line_id === lineId && t.entry_key === entryKey)) return;
      if (taken.length) throw new ConflictException('Inmein se ek pehle se kisi aur se juda hai: pehle use alag karein');
      await tx.query(`DELETE FROM bank_matches WHERE kind = 'reject' AND line_id = $1 AND entry_key = $2`, [lineId, entryKey]);
      await tx.query(`INSERT INTO bank_matches (id, shop_id, line_id, entry_key, kind, matched_by) VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, 'manual', $4)`,
        [uuidv7(), lineId, entryKey, by]);
    });
  }

  /** Takes a pair apart, a person's or an automatic one, and keeps it apart. */
  async unmatch(shopId: string, by: string, lineId: string, entryKey: string) {
    await this.db.withShop(shopId, async (tx) => {
      await tx.query(`DELETE FROM bank_matches WHERE line_id = $1 AND entry_key = $2`, [lineId, entryKey]);
      await tx.query(`INSERT INTO bank_matches (id, shop_id, line_id, entry_key, kind, matched_by) VALUES ($1, current_setting('app.shop_id')::uuid, $2, $3, 'reject', $4)`,
        [uuidv7(), lineId, entryKey, by]);
    });
  }

  // ---------------------------------------------------------------- helpers

  private async statementLines(tx: Tx, key: string, from: string, to: string): Promise<StatementLine[]> {
    const rows = (await tx.query<{ id: string; day: string; direction: 'cr' | 'dr'; amt: string; ref: string; narration: string; bal: string | null; source: 'csv' | 'manual'; batch_id: string; uploaded_by: string }>(
      `SELECT l.id, l.line_date::text AS day, l.direction, l.amount_paise AS amt, l.ref, l.narration, l.balance_paise AS bal, l.source, l.batch_id, l.uploaded_by
       FROM bank_statement_lines l JOIN bank_statement_batches b ON b.id = l.batch_id
       WHERE l.voided_at IS NULL AND l.account_no = $1 AND l.line_date BETWEEN $2 AND $3
       ORDER BY l.line_date, b.created_at, l.pos`, [key, from, to])).rows;
    return rows.map((r) => ({
      id: r.id, date: r.day, direction: r.direction, amountPaise: n(r.amt), ref: r.ref, narration: r.narration,
      balancePaise: r.bal === null ? null : n(r.bal), source: r.source, batchId: r.batch_id, uploadedBy: r.uploaded_by,
    }));
  }

  private async openings(tx: Tx): Promise<Map<string, Opening>> {
    const rows = (await tx.query<{ account_no: string; opening_paise: string; on: string; updated_by: string }>(
      `SELECT account_no, opening_paise, opening_on::text AS on, updated_by FROM bank_openings`)).rows;
    return new Map(rows.map((r) => [r.account_no, { paise: n(r.opening_paise), on: r.on, by: r.updated_by }]));
  }

  private async accountList(shopId: string): Promise<Account[]> {
    const s = await this.settings.get(shopId);
    const seen = new Set<string>();
    return s.bankAccounts.flatMap((a) => {
      const key = accountKey(a.account ?? '');
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [{ key, bank: a.bank, account: a.account, holder: a.holder || s.name, ifsc: a.ifsc, label: [a.bank, `··${key.slice(-4)}`].filter(Boolean).join(' ') }];
    });
  }

  private pick(all: Account[], key: string): Account {
    const a = all.find((x) => x.key === key);
    if (!a) throw new NotFoundException('Yeh bank khata Settings mein nahi hai');
    return a;
  }

  private async account(shopId: string, key: string) {
    return this.pick(await this.accountList(shopId), key);
  }
}

type Opening = { paise: number; on: string; by: string };
