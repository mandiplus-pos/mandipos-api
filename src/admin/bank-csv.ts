/**
 * A bank statement CSV, read as forgivingly as the banks write them. Indian banks' "download as
 * CSV / Excel" files differ in everything: a few lines of account details before the header, the
 * header's words (Txn Date, Value Dt, Narration, Particulars, Chq./Ref.No., Withdrawal Amt.,
 * Deposit Amt., DR, CR, Amount + Dr/Cr, Closing Balance), the date (01/04/26, 01-Apr-2026,
 * 2026-04-01 10:22), the money (1,23,456.78, 500.00 Cr, (250.00), -250) and a footer of totals.
 * So: the delimiter and header row are found, the columns are guessed from the header's words and
 * shown to the person to correct (the mapping step), and every row without a date and an amount is
 * skipped and counted rather than failing the upload. Money comes out as integer paise.
 */

export type DateOrder = 'dmy' | 'mdy' | 'ymd';
/** Column indexes into a row; amount + drcr stand in for debit + credit on one-amount statements. */
export type CsvMapping = {
  date: number; narration?: number; ref?: number; debit?: number; credit?: number; amount?: number; drcr?: number; balance?: number;
};
export type ParsedLine = { date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string; narration: string; balancePaise: number | null; row: number };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Splits CSV text into rows of cells: quotes, doubled quotes, CRLF, a BOM, and , ; tab or | as the delimiter. */
export function splitCsv(text: string): { rows: string[][]; delimiter: string } {
  const src = text.replace(/^﻿/, '');
  const sample = src.split(/\r?\n/).slice(0, 60);
  const delimiter = [',', '\t', ';', '|']
    .map((d) => ({ d, score: sample.reduce((t, l) => t + (l.split(d).length - 1 >= 2 ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)[0].d;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row.map((c) => c.trim())); row = [];
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row.map((c) => c.trim())); }
  return { rows: rows.filter((r) => r.some((c) => c !== '')), delimiter };
}

const word = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** What a header cell most likely holds, from its words. */
function kindOf(cell: string): keyof CsvMapping | 'valuedate' | null {
  const w = word(cell);
  if (!w) return null;
  if (w.includes('valuedate') || w === 'valuedt' || w === 'valdate') return 'valuedate';
  if (w.includes('date') || w === 'txndt' || w === 'trandt' || w === 'dt') return 'date';
  if (w.includes('balance') || w === 'bal' || w === 'closingbal') return 'balance';
  if (['drcr', 'crdr', 'debitcredit', 'creditdebit', 'dc', 'cd', 'type', 'txntype', 'transactiontype', 'drcrindicator'].includes(w)) return 'drcr';
  if (w.includes('withdraw') || w.includes('debit') || w === 'dr' || w === 'paidout' || w === 'payments') return 'debit';
  if (w.includes('deposit') || w.includes('credit') || w === 'cr' || w === 'paidin' || w === 'receipts') return 'credit';
  if (w === 'transactionid' || w === 'tranid' || w === 'txnid' || w === 'utrno') return 'ref';
  if (w.includes('narration') || w.includes('description') || w.includes('particular') || w.includes('remark') || w.includes('detail') || w === 'transaction') return 'narration';
  if (w.includes('ref') || w.includes('chq') || w.includes('cheque') || w.includes('utr') || w.includes('instrument')) return 'ref';
  if (w.includes('amount') || w === 'amt' || w === 'txnamount' || w === 'inr') return 'amount';
  return null;
}

/** The header row: the first of the first 40 rows naming a date and some money column. -1 when there is none. */
export function findHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const kinds = rows[i].map(kindOf);
    const dated = kinds.includes('date') || kinds.includes('valuedate');
    const money = kinds.some((k) => k === 'debit' || k === 'credit' || k === 'amount');
    if (dated && money) return i;
  }
  return -1;
}

/** The columns guessed from a header row. Transaction date over value date; debit + credit over a single amount. */
export function guessMapping(header: string[]): Partial<CsvMapping> {
  const m: Partial<CsvMapping> = {};
  let valueDate: number | undefined;
  header.forEach((cell, i) => {
    const k = kindOf(cell);
    if (k === 'valuedate') { valueDate ??= i; return; }
    if (k && m[k] === undefined) m[k] = i;
  });
  if (m.date === undefined && valueDate !== undefined) m.date = valueDate;
  if (m.debit !== undefined || m.credit !== undefined) { delete m.amount; delete m.drcr; }
  return m;
}

/**
 * Money as written by a bank, to paise and a side: "1,23,456.78", "₹ 500", "500.00 Cr", "Dr 20",
 * "(250.00)", "-250", "250-". null for an empty cell, "-", or anything that is not money.
 */
export function parseMoney(raw: string | undefined): { paise: number; side: 'cr' | 'dr' | null } | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || s === '-' || s === '--') return null;
  let side: 'cr' | 'dr' | null = null;
  const sideMatch = s.match(/^(cr|dr)\.?\s*|\s*\(?(cr|dr)\.?\)?$/i);
  if (sideMatch) {
    side = (sideMatch[1] ?? sideMatch[2]).toLowerCase() as 'cr' | 'dr';
    s = s.replace(sideMatch[0], '');
  }
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); } else if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const digits = (frac + '000').slice(0, 3);
  let paise = Number(whole || '0') * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) paise += 1;
  if (!Number.isSafeInteger(paise)) return null;
  if (negative) {
    if (side === null) side = 'dr';
    paise = -paise;
  }
  return { paise, side };
}

/** A bank's date to YYYY-MM-DD, any time after it dropped. Day first unless told otherwise (Indian statements). */
export function parseDate(raw: string | undefined, order: DateOrder = 'dmy'): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i, '').replace(/T\d{2}:\d{2}.*$/, '');
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/., ]+(\d{2,4})$/))) {
    d = +m[1]; mo = MONTHS[m[2].toLowerCase().slice(0, 3)] ?? 0; y = +m[3];
  } else if ((m = s.match(/^([A-Za-z]{3,9})[-/. ](\d{1,2}),?[-/. ]+(\d{2,4})$/))) {
    mo = MONTHS[m[1].toLowerCase().slice(0, 3)] ?? 0; d = +m[2]; y = +m[3];
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    if (order === 'mdy') { mo = +m[1]; d = +m[2]; } else { d = +m[1]; mo = +m[2]; }
    y = +m[3];
  } else if ((m = s.match(/^(\d{2})(\d{2})(\d{4})$/))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else return null;
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return back.getUTCDate() === d ? iso : null;
}

/** Day first or month first, from the dates themselves: a first number above 12 says day first, a second one month first. */
export function guessDateOrder(values: string[]): DateOrder {
  let dmy = 0, mdy = 0, ymd = 0;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
    if (!m) continue;
    if (m[1].length === 4) ymd++;
    else if (+m[1] > 12) dmy++;
    else if (+m[2] > 12) mdy++;
  }
  return ymd > dmy + mdy ? 'ymd' : mdy > dmy ? 'mdy' : 'dmy';
}

/** A UTR or reference inside a narration: UPI/412345678901/..., NEFT-HDFCN52026..., IMPS 4123... */
export function refFromNarration(narration: string): string {
  const tagged = narration.match(/(?:UPI|IMPS|NEFT|RTGS|UTR)[\s/:\-]*(?:[A-Z]{2,6}[\s/:\-]+)?([A-Z0-9]{10,22})/i);
  if (tagged && /\d{6}/.test(tagged[1])) return tagged[1].toUpperCase();
  const twelve = narration.match(/(?<!\d)(\d{12})(?!\d)/);
  return twelve ? twelve[1] : '';
}

export type Preview = {
  delimiter: string; headerRow: number; header: string[]; columns: number; sample: string[][]; mapping: Partial<CsvMapping>; dateOrder: DateOrder; rows: number;
};

/** What the mapping step shows: the header found, the columns guessed, and the first rows under it. */
export function preview(text: string): Preview {
  const { rows, delimiter } = splitCsv(text);
  const headerRow = findHeader(rows);
  const header = headerRow >= 0 ? rows[headerRow] : [];
  const body = rows.slice(headerRow + 1);
  const mapping = headerRow >= 0 ? guessMapping(header) : {};
  const dates = mapping.date !== undefined ? body.slice(0, 200).map((r) => r[mapping.date!] ?? '') : [];
  return {
    delimiter, headerRow, header, columns: Math.max(0, ...rows.slice(0, 50).map((r) => r.length)),
    sample: body.slice(0, 12), mapping, dateOrder: guessDateOrder(dates), rows: body.length,
  };
}

/**
 * Every statement line under the header, by the mapping. A row is skipped (and said why) when it
 * has no date, no amount, or a zero amount: the bank's opening line, totals and footers.
 */
export function parseStatement(text: string, headerRow: number, mapping: CsvMapping, order: DateOrder) {
  const { rows } = splitCsv(text);
  const lines: ParsedLine[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const cell = (r: string[], i?: number) => (i === undefined || i < 0 ? '' : (r[i] ?? '').trim());
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    const date = parseDate(cell(r, mapping.date), order);
    if (!date) { skipped.push({ row: rowNo, reason: 'date' }); continue; }
    const narration = cell(r, mapping.narration).replace(/\s+/g, ' ').slice(0, 300);
    let ref = cell(r, mapping.ref).replace(/\s+/g, ' ').slice(0, 60);
    if (!ref || /^0+$/.test(ref)) ref = refFromNarration(narration);
    const bal = parseMoney(cell(r, mapping.balance));
    const balancePaise = bal ? (bal.side === 'dr' ? -Math.abs(bal.paise) : Math.abs(bal.paise)) : null;
    const found: { direction: 'cr' | 'dr'; amountPaise: number }[] = [];
    if (mapping.debit !== undefined || mapping.credit !== undefined) {
      const d = parseMoney(cell(r, mapping.debit)), c = parseMoney(cell(r, mapping.credit));
      if (d && d.paise !== 0) found.push({ direction: d.paise < 0 ? 'cr' : 'dr', amountPaise: Math.abs(d.paise) });
      if (c && c.paise !== 0) found.push({ direction: c.paise < 0 ? 'dr' : 'cr', amountPaise: Math.abs(c.paise) });
    } else if (mapping.amount !== undefined) {
      const a = parseMoney(cell(r, mapping.amount));
      if (a && a.paise !== 0) {
        const t = word(cell(r, mapping.drcr));
        const said = t.startsWith('cr') || t === 'c' || t.startsWith('dep') || t.startsWith('credit') ? 'cr'
          : t.startsWith('dr') || t === 'd' || t.startsWith('with') || t.startsWith('debit') ? 'dr' : null;
        found.push({ direction: said ?? a.side ?? (a.paise < 0 ? 'dr' : 'cr'), amountPaise: Math.abs(a.paise) });
      }
    }
    if (!found.length) { skipped.push({ row: rowNo, reason: 'amount' }); continue; }
    for (const f of found) lines.push({ date, ...f, ref, narration, balancePaise, row: rowNo });
  }
  return { lines, skipped };
}
