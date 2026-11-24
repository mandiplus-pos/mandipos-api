import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Db, Tx } from '../db/db.service';
import { BOUGHT, IST_DAY, LIVE_BILLS, n } from './sql';
import { ReportsService, nameKey } from './reports.service';

/**
 * Nariyal's two website pages beside Dispatch:
 *  - Bhada: every gaadi's Bada (the gaadi wale's account) for the days, as the app's BadaScreen
 *    keeps it on the truck: bhada less advance, dala, fine and halting, plus inaam (GaadiBada.net),
 *    and whether "All paid" was pressed, by whom, and from where (the Aaya-Gaya line the app writes
 *    under id nameUUIDFromBytes("bada-paid/<truckId>"), Store.putBadaPayout).
 *  - Supplier ledger: one supplier's nariyal gaadis (Purchase and Commission) with the dana that
 *    came, sold and broke, what the shop owes him on each, his payments and kaat / baaki badla,
 *    with a running balance. A Purchase gaadi is owed its maal (Store.purchaseSuppliers: dana x
 *    kharid bhav, less count corrections, no bhada); a Commission gaadi its saved beejak's net.
 */

/** java.util.UUID.nameUUIDFromBytes: an MD5 name UUID (version 3), as the app makes the Bada line's id. */
export function nameUuid(name: string): string {
  const b = createHash('md5').update(name, 'utf8').digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const badaPayoutId = (truckId: string) => nameUuid(`bada-paid/${truckId}`);

/** GaadiBada.net: what the gaadi wala is still owed; below zero he owes the shop. */
export const badaNet = (b: { bhada: number; advance: number; dala: number; inaam: number; fine: number; halting: number }) =>
  b.bhada - b.advance - b.dala + b.inaam - b.fine - b.halting;

/** Where the money came from, as the portal names its books: cash = galla, upi/bank = bank. */
const potOf = (mode: string | null) => (mode == null ? null : mode === 'cash' ? 'galla' : mode === 'office' ? 'office' : 'bank');
const GRADE: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', mix: 'Mix', MIX: 'Mix' };
const gradeLabel = (g: string | null) => (g == null ? '' : GRADE[g] ?? g);
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

type Deal = 'purchase' | 'commission';

@Injectable()
export class NariyalHisabService {
  constructor(private readonly db: Db, private readonly reports: ReportsService) {}

  // ---------------------------------------------------------------- Bhada

  /**
   * Every gaadi on Bada for the days: those that arrived in them, and those paid off in them.
   * One row a gaadi with its heads, net, paid mark, who paid and from which book.
   */
  async bhada(shopId: string, from: string, to: string) {
    return this.db.withShop(shopId, async (tx) => {
      const trucks = (await tx.query<{ id: string; number: string; supplier: string; deal: string | null; arrived_at: Date; closed: boolean;
        freight: string; advance: string; dala: string; inaam: string; fine: string; halting: string; paid_at: Date | null; paid_by: string | null }>(
        `SELECT t.id, t.number, TRIM(t.supplier) AS supplier, t.deal, t.arrived_at, t.closed_at IS NOT NULL AS closed,
                t.freight_paise AS freight, t.advance_paise AS advance, t.dala_paise AS dala, t.inaam_paise AS inaam,
                t.fine_paise AS fine, t.halting_paise AS halting, t.bada_paid_at AS paid_at, t.bada_paid_by AS paid_by
         FROM trucks t
         WHERE ${IST_DAY('t.arrived_at')} BETWEEN $1::date AND $2::date
            OR (t.bada_paid_at IS NOT NULL AND ${IST_DAY('t.bada_paid_at')} BETWEEN $1::date AND $2::date)
         ORDER BY t.arrived_at, t.number`, [from, to])).rows;
      const ids = trucks.map((t) => t.id);
      const payoutIds = ids.map(badaPayoutId);
      const lines = ids.length ? (await tx.query<{ id: string; mode: string; day: string; direction: string; amount: string; note: string }>(
        `SELECT id, mode, business_date::text AS day, direction, amount_paise AS amount, note FROM daybook_entries
         WHERE id = ANY($1::uuid[]) AND hidden = false`, [payoutIds])).rows : [];
      const lineOf = new Map(lines.map((l) => [l.id, l]));
      // What came and what sold, for the gaadi's details.
      const lots = ids.length ? (await tx.query<{ truck_id: string; brand: string | null; grade: string | null; qty: string }>(
        `SELECT g.truck_id, br.name AS brand, g.grade, SUM(g.billed_qty + g.free_qty) AS qty FROM truck_grades g
         LEFT JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = ANY($1::uuid[]) AND ${BOUGHT('g')}
         GROUP BY g.truck_id, br.name, g.grade ORDER BY g.truck_id, br.name, g.grade`, [ids])).rows : [];
      const sold = ids.length ? (await tx.query<{ truck_id: string; qty: string }>(
        `SELECT l.truck_id, SUM(l.qty) AS qty FROM bill_lines l JOIN ${LIVE_BILLS} lb ON lb.id = l.bill_id
         WHERE l.truck_id = ANY($1::uuid[]) GROUP BY l.truck_id`, [ids])).rows : [];
      const soldOf = new Map(sold.map((s) => [s.truck_id, n(s.qty)]));

      const rows = trucks.map((t) => {
        const heads = { bhada: n(t.freight), advance: n(t.advance), dala: n(t.dala), inaam: n(t.inaam), fine: n(t.fine), halting: n(t.halting) };
        const line = lineOf.get(badaPayoutId(t.id));
        const maal = lots.filter((l) => l.truck_id === t.id).map((l) => ({ maal: [l.brand ?? '', gradeLabel(l.grade)].filter(Boolean).join(' '), qty: n(l.qty) }));
        return {
          truckId: t.id, number: t.number, supplier: t.supplier, deal: (t.deal as Deal | null) ?? null, arrivedOn: istDay(t.arrived_at), closed: t.closed,
          bhadaPaise: heads.bhada, advancePaise: heads.advance, dalaPaise: heads.dala, finePaise: heads.fine, inaamPaise: heads.inaam, haltingPaise: heads.halting,
          netPaise: badaNet(heads),
          paid: t.paid_at != null, paidOn: t.paid_at ? istDay(t.paid_at) : null, paidAt: t.paid_at?.toISOString() ?? null, paidBy: t.paid_by ?? '',
          // The Aaya-Gaya line it was paid with: from which book, on which day, how much; null = not paid that way.
          payout: line ? { pot: potOf(line.mode), mode: line.mode, date: line.day, direction: line.direction as 'in' | 'out', amountPaise: n(line.amount) } : null,
          maal, dana: maal.reduce((s, m) => s + m.qty, 0), sold: soldOf.get(t.id) ?? 0,
        };
      });
      const sum = (f: (r: (typeof rows)[number]) => number, only?: (r: (typeof rows)[number]) => boolean) =>
        rows.filter((r) => !only || only(r)).reduce((s, r) => s + f(r), 0);
      return {
        from, to, rows,
        totals: {
          gaadis: rows.length, paidCount: rows.filter((r) => r.paid).length, baakiCount: rows.filter((r) => !r.paid).length,
          bhadaPaise: sum((r) => r.bhadaPaise), advancePaise: sum((r) => r.advancePaise), dalaPaise: sum((r) => r.dalaPaise), finePaise: sum((r) => r.finePaise),
          inaamPaise: sum((r) => r.inaamPaise), haltingPaise: sum((r) => r.haltingPaise), netPaise: sum((r) => r.netPaise),
          paidPaise: sum((r) => r.netPaise, (r) => r.paid), baakiPaise: sum((r) => r.netPaise, (r) => !r.paid),
        },
      };
    });
  }

  // ---------------------------------------------------------------- Supplier ledger

  /**
   * Every nariyal supplier (a Purchase or Commission gaadi on his name) with what the shop owes
   * him. The gaadis, their dana and goods come from ReportsService.supplierBooks (the port of the
   * app's Store.suppliers), so the counts match the Supplier Khata; only the money owed differs:
   * Purchase = maal without bhada (the bhada is the gaadi wala's, paid on Bada), Commission = beejak net.
   */
  private async parties(tx: Tx) {
    const books = await this.reports.supplierBooks(tx);
    const deals = new Map((await tx.query<{ id: string; deal: Deal }>(
      `SELECT id, deal FROM trucks WHERE deal IN ('purchase', 'commission')`)).rows.map((r) => [r.id, r.deal]));
    const beejaks = new Map((await tx.query<{ truck_id: string; beejak_no: number; day: string; dana: number; gross: string; expenses: string; net: string }>(
      `SELECT truck_id, beejak_no, day::text AS day, dana, gross_paise AS gross, expenses_paise AS expenses, net_paise AS net FROM nariyal_beejaks`)).rows
      .map((b) => [b.truck_id, { no: b.beejak_no, date: b.day, dana: b.dana, grossPaise: n(b.gross), expensesPaise: n(b.expenses), netPaise: n(b.net) }]));
    // Only Supplier Ledger payments: tagged with a gaadi, or "on account" (Store.purchaseSuppliers).
    const payments = (await tx.query<{ id: string; party: string; amount: string; mode: string; note: string; day: string; at: Date; bill: string }>(
      `SELECT id, TRIM(party_name) AS party, amount_paise AS amount, mode, note, business_date::text AS day, created_at AS at, purchase_bill AS bill
       FROM daybook_entries WHERE category = 'supplier' AND direction = 'out' AND hidden = false AND purchase_bill IS NOT NULL`)).rows;
    const adjustments = (await tx.query<{ id: string; truck_id: string; party: string; kind: 'kaat' | 'badla'; note: string; amount: string; day: string; at: Date }>(
      `SELECT id, truck_id, TRIM(party_name) AS party, kind, note, amount_paise AS amount, business_date::text AS day, created_at AS at
       FROM supplier_adjustments WHERE hidden = false`)).rows;

    return books.map((s) => {
      const gaadis = s.gaadis.filter((g) => deals.has(g.truckId)).map((g) => {
        const deal = deals.get(g.truckId)!;
        const beejak = beejaks.get(g.truckId) ?? null;
        return { ...g, deal, beejak, owedPaise: deal === 'purchase' ? g.goodsPaise : beejak?.netPaise ?? 0 };
      });
      const ids = new Set(gaadis.map((g) => g.truckId));
      const hasPurchase = gaadis.some((g) => g.deal === 'purchase');
      const paid = payments.filter((p) => ids.has(p.bill) || (p.bill === 'account' && hasPurchase && nameKey(p.party) === s.key));
      const adj = adjustments.filter((a) => ids.has(a.truck_id));
      const owed = gaadis.reduce((t, g) => t + g.owedPaise, 0);
      const paidPaise = paid.reduce((t, p) => t + n(p.amount), 0), adjustPaise = adj.reduce((t, a) => t + n(a.amount), 0);
      const last = [...gaadis.map((g) => g.arrivedAt.getTime()), ...paid.map((p) => p.at.getTime())].sort((a, b) => a - b).at(-1);
      return { key: s.key, name: s.name, gaadis, payments: paid, adjustments: adj, owedPaise: owed, paidPaise, adjustPaise,
        duePaise: owed - paidPaise - adjustPaise, lastAt: last ? new Date(last).toISOString() : null };
    }).filter((s) => s.gaadis.length > 0);
  }

  /** The picker: every nariyal supplier, newest first, with his gaadis and what is still to pay him. */
  async suppliers(shopId: string) {
    return this.db.withShop(shopId, async (tx) => {
      const rows = (await this.parties(tx)).map((s) => ({
        key: s.key, name: s.name, gaadis: s.gaadis.length,
        purchase: s.gaadis.filter((g) => g.deal === 'purchase').length, commission: s.gaadis.filter((g) => g.deal === 'commission').length,
        duePaise: s.duePaise, lastAt: s.lastAt,
      })).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
      return { rows };
    });
  }

  /**
   * One supplier's ledger for the days: what came before [from] carried in as the opening, then
   * each gaadi (credit: what the shop owes on it), payment (debit) and kaat / baaki badla (debit
   * when it brings the baaki down), oldest first with a running balance. Balance > 0 = still to pay him.
   */
  async ledger(shopId: string, key: string, from: string, to: string) {
    return this.db.withShop(shopId, async (tx) => {
      const s = (await this.parties(tx)).find((x) => x.key === key);
      if (!s) throw new NotFoundException('Supplier nahi mila');
      const ids = s.gaadis.map((g) => g.truckId);
      const lots = ids.length ? (await tx.query<{ truck_id: string; brand: string | null; grade: string | null; qty: string; rate: string }>(
        `SELECT g.truck_id, br.name AS brand, g.grade, SUM(g.billed_qty) AS qty, g.rate_paise AS rate FROM truck_grades g
         LEFT JOIN brands br ON br.id = g.brand_id WHERE g.truck_id = ANY($1::uuid[]) AND ${BOUGHT('g')}
         GROUP BY g.truck_id, br.name, g.grade, g.rate_paise ORDER BY g.truck_id, MIN(g.created_at), g.grade`, [ids])).rows : [];
      const gaadiName = new Map(s.gaadis.map((g) => [g.truckId, `${g.number} ${shortDay(istDay(g.arrivedAt))}`]));
      const modeName = (m: string) => (m === 'cash' ? 'Galla' : m === 'office' ? 'Office' : 'Bank');

      type Entry = { id: string; date: string; at: string; order: number; kind: 'gaadi' | 'payment' | 'kaat' | 'badla'; title: string; detail: string;
        debitPaise: number; creditPaise: number; gaadi?: unknown; mode?: string; forGaadi?: string };
      const all: Entry[] = [];
      for (const g of s.gaadis) {
        const mine = lots.filter((l) => l.truck_id === g.truckId && n(l.qty) > 0)
          .map((l) => ({ maal: l.brand ?? '', grade: gradeLabel(l.grade), qty: n(l.qty), ratePaise: n(l.rate), amountPaise: n(l.qty) * n(l.rate) }));
        // A count corrected after arrival: what the lots add up to less what he is owed on them.
        const correctionPaise = g.deal === 'purchase' ? mine.reduce((t, l) => t + l.amountPaise, 0) - g.goodsPaise : 0;
        all.push({
          id: g.truckId, date: istDay(g.arrivedAt), at: g.arrivedAt.toISOString(), order: 0, kind: 'gaadi',
          title: `Gaadi ${g.number}`, detail: g.deal === 'purchase' ? 'Purchase' : 'Commission',
          debitPaise: 0, creditPaise: g.owedPaise,
          gaadi: { truckId: g.truckId, number: g.number, deal: g.deal, closed: g.closed, lots: mine, dana: g.dana, sold: g.sold, phoota: g.spoiled,
            left: Math.max(0, g.dana - g.sold - g.spoiled), goodsPaise: g.goodsPaise, correctionPaise, beejak: g.beejak },
        });
      }
      for (const p of s.payments) {
        const forGaadi = p.bill === 'account' ? 'On account' : gaadiName.get(p.bill) ?? '';
        all.push({ id: p.id, date: p.day, at: p.at.toISOString(), order: 3, kind: 'payment', title: 'Payment',
          detail: [modeName(p.mode), forGaadi, p.note].filter(Boolean).join(' · '), debitPaise: n(p.amount), creditPaise: 0, mode: potOf(p.mode) ?? '', forGaadi });
      }
      for (const a of s.adjustments) {
        const amt = n(a.amount);
        all.push({ id: a.id, date: a.day, at: a.at.toISOString(), order: 4, kind: a.kind, title: a.kind === 'kaat' ? 'Kaat' : 'Baaki badla',
          detail: [gaadiName.get(a.truck_id) ?? '', a.note].filter(Boolean).join(' · '), debitPaise: Math.max(0, amt), creditPaise: Math.max(0, -amt),
          forGaadi: gaadiName.get(a.truck_id) ?? '' });
      }
      all.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.at.localeCompare(b.at));
      const openingPaise = all.filter((e) => e.date < from).reduce((t, e) => t + e.creditPaise - e.debitPaise, 0);
      let bal = openingPaise;
      const rows = all.filter((e) => e.date >= from && e.date <= to).map(({ order: _o, ...e }) => ({ ...e, balancePaise: (bal += e.creditPaise - e.debitPaise) }));
      const gaadiRows = rows.filter((r) => r.kind === 'gaadi').map((r) => r.gaadi as { dana: number; sold: number; phoota: number });
      return {
        key: s.key, name: s.name, from, to, openingPaise, rows, closingPaise: bal,
        totals: {
          creditPaise: rows.reduce((t, r) => t + r.creditPaise, 0), debitPaise: rows.reduce((t, r) => t + r.debitPaise, 0),
          paidPaise: rows.filter((r) => r.kind === 'payment').reduce((t, r) => t + r.debitPaise, 0),
          adjustPaise: rows.filter((r) => r.kind === 'kaat' || r.kind === 'badla').reduce((t, r) => t + r.debitPaise - r.creditPaise, 0),
          gaadis: gaadiRows.length, dana: gaadiRows.reduce((t, g) => t + g.dana, 0), sold: gaadiRows.reduce((t, g) => t + g.sold, 0),
          phoota: gaadiRows.reduce((t, g) => t + g.phoota, 0),
        },
        // His whole account today, whatever the days on screen.
        duePaise: s.duePaise,
      };
    });
  }
}
