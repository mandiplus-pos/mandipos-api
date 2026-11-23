import { useState } from 'react'
import { api } from '../api'
import { count, rate, rupees, shortDate, time } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { hashQuery, setHashQuery } from '../routes'
import { useLoad } from '../useLoad'
import { Bal, PeriodBar, Skeleton } from '../ui'
import { balRs, dayRange, dmy, fileName, rs, useExport } from '../export/doc'

/**
 * Nariyal's Bhada and Supplier ledger pages, below Dispatch. Bhada is the app's Bada for the
 * days: each gaadi's bhada, what comes off it (advance, dala, fine, halting) and the inaam that
 * goes on, the net, and whether "All paid" was pressed, by whom and from which book. The
 * Supplier ledger is one bikri waala's account: opening, each gaadi with the dana that came,
 * sold and broke and its beejak, each payment and kaat / baaki badla, with a running balance.
 */

// ================================================================ Bhada

type Pot = 'galla' | 'bank' | 'office'
type BadaRow = {
  truckId: string; number: string; supplier: string; deal: 'purchase' | 'commission' | null; arrivedOn: string; closed: boolean
  bhadaPaise: number; advancePaise: number; dalaPaise: number; finePaise: number; inaamPaise: number; haltingPaise: number; netPaise: number
  paid: boolean; paidOn: string | null; paidAt: string | null; paidBy: string
  payout: { pot: Pot | null; mode: string; date: string; direction: 'in' | 'out'; amountPaise: number } | null
  maal: { maal: string; qty: number }[]; dana: number; sold: number
}
type BadaTotals = {
  gaadis: number; paidCount: number; baakiCount: number; bhadaPaise: number; advancePaise: number; dalaPaise: number; finePaise: number
  inaamPaise: number; haltingPaise: number; netPaise: number; paidPaise: number; baakiPaise: number
}
type BadaDesk = { from: string; to: string; rows: BadaRow[]; totals: BadaTotals }
type BadaView = 'sab' | 'paid' | 'baaki'

const POT: Record<Pot, string> = { galla: 'Galla', bank: 'Bank', office: 'Office' }
const potName = (p: Pot | null | undefined) => (p ? t(POT[p]) : '')
const amt = (p: number) => (p ? rupees(p) : '')
const gaadiName = (r: { number: string; supplier: string }) => (r.number && r.number !== '-' ? r.number : r.supplier || t('Gaadi'))

const sumOf = (rows: BadaRow[]) => ({
  bhada: rows.reduce((s, r) => s + r.bhadaPaise, 0), advance: rows.reduce((s, r) => s + r.advancePaise, 0), dala: rows.reduce((s, r) => s + r.dalaPaise, 0),
  fine: rows.reduce((s, r) => s + r.finePaise, 0), inaam: rows.reduce((s, r) => s + r.inaamPaise, 0), halting: rows.reduce((s, r) => s + r.haltingPaise, 0),
  net: rows.reduce((s, r) => s + r.netPaise, 0),
})

export function NariyalBhada({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [view, setView] = useState<BadaView>(() => (['paid', 'baaki'].includes(hashQuery().get('v') ?? '') ? hashQuery().get('v') as BadaView : 'sab'))
  const pick = (v: BadaView) => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const [open, setOpen] = useState<BadaRow | null>(null)
  const { data, error, loading } = useLoad(
    () => api<BadaDesk>(`/v1/admin/shops/${shopId}/nariyal/bhada?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])

  const all = data?.rows ?? []
  const rows = view === 'sab' ? all : all.filter((r) => (view === 'paid' ? r.paid : !r.paid))
  const tot = sumOf(rows)
  const viewName = view === 'paid' ? t('Paid') : view === 'baaki' ? t('Baaki') : t('Sab')

  useExport(data ? () => ({
    style: 'book' as const, title: `${t('Bhada')} · ${viewName}`, dateLine: dayRange(period.from, period.to), file: fileName('Bhada', viewName, period.from, period.to),
    summary: [[t('Gaadi'), count(data.totals.gaadis)], [t('Kul bhada'), rs(data.totals.bhadaPaise)], [t('Kul net'), rs(data.totals.netPaise)],
      [t('Paid'), rs(data.totals.paidPaise)], [t('Baaki'), rs(data.totals.baakiPaise)]] as [string, string][],
    columns: [{ label: t('Aayi') }, { label: t('Gaadi'), wide: true }, { label: t('Bhada'), num: true }, { label: t('Advance'), num: true }, { label: t('Dala'), num: true },
      { label: t('Fine'), num: true }, { label: t('Inaam'), num: true }, { label: t('Halting'), num: true }, { label: t('Net'), num: true }, { label: t('Haal'), wide: true }],
    rows: rows.map((r) => ({
      bold: !r.paid,
      cells: [dmy(r.arrivedOn), [gaadiName(r), r.supplier].filter((x, i, a) => x && a.indexOf(x) === i).join(' · '), rs(r.bhadaPaise), r.advancePaise ? rs(r.advancePaise) : '',
        r.dalaPaise ? rs(r.dalaPaise) : '', r.finePaise ? rs(r.finePaise) : '', r.inaamPaise ? rs(r.inaamPaise) : '', r.haltingPaise ? rs(r.haltingPaise) : '', rs(r.netPaise),
        r.paid ? [t('Paid'), r.paidOn ? dmy(r.paidOn) : '', r.paidBy, potName(r.payout?.pot)].filter(Boolean).join(' · ') : t('BAAKI')],
    })),
    foot: [t('Kul'), `${count(rows.length)} ${t('gaadi')}`, rs(tot.bhada), rs(tot.advance), rs(tot.dala), rs(tot.fine), rs(tot.inaam), rs(tot.halting), rs(tot.net), ''],
    note: t('Net = bhada − advance − dala − fine − halting + inaam'),
  }) : null, [data, view])

  return (
    <>
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <div className="seg" role="group">
          <button aria-pressed={view === 'sab'} onClick={() => pick('sab')}>{t('Sab')}{data ? ` · ${data.totals.gaadis}` : ''}</button>
          <button aria-pressed={view === 'paid'} onClick={() => pick('paid')}>{t('Paid')}{data ? ` · ${data.totals.paidCount}` : ''}</button>
          <button aria-pressed={view === 'baaki'} onClick={() => pick('baaki')}>{t('Baaki')}{data ? ` · ${data.totals.baakiCount}` : ''}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div className="card sum">
            <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(data.totals.gaadis)}</span></div>
            <div><span className="lb">{t('Kul bhada')}</span><span className="v">{rupees(data.totals.bhadaPaise)}</span></div>
            <div><span className="lb">{t('Kul net')}</span><span className="v">{rupees(data.totals.netPaise)}</span></div>
            <div><span className="lb">{t('Paid')}</span><span className="v jama">{rupees(data.totals.paidPaise)}</span></div>
            <div><span className="lb">{t('Baaki')}</span><span className={`v${data.totals.baakiPaise ? ' due' : ''}`}>{rupees(data.totals.baakiPaise)}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr>
                <th>{t('Gaadi')}</th><th className="num">{t('Bhada')}</th><th className="num">{t('Advance')}</th><th className="num">{t('Dala')}</th>
                <th className="num">{t('Fine')}</th><th className="num">{t('Inaam')}</th><th className="num">{t('Halting')}</th><th className="num">{t('Net')}</th>
                <th>{t('Haal')}</th><th>{t('Paid kab')}</th><th>{t('Kisne diya')}</th><th>{t('Kahan se')}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.truckId} data-row tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r) }}>
                    <td className="main-col"><b>{gaadiName(r)}</b>
                      <small>{[shortDate(r.arrivedOn), r.supplier !== gaadiName(r) ? r.supplier : ''].filter(Boolean).join(' · ')}
                        <span className="show-sm"> · {r.paid ? t('Paid') : t('Baaki')}</span></small></td>
                    <td className="num opt-col money">{rupees(r.bhadaPaise)}</td>
                    <td className="num opt-col money muted">{amt(r.advancePaise)}</td>
                    <td className="num opt-col money muted">{amt(r.dalaPaise)}</td>
                    <td className="num opt-col money muted">{amt(r.finePaise)}</td>
                    <td className="num opt-col money muted">{amt(r.inaamPaise)}</td>
                    <td className="num opt-col money muted">{amt(r.haltingPaise)}</td>
                    <td className="num amt-col"><b className={`money${r.paid ? '' : ' due'}`}>{rupees(r.netPaise)}</b></td>
                    <td className="opt-col">{r.paid ? <span className="chip green">{t('Paid')}</span> : <span className="chip red">{t('Baaki')}</span>}</td>
                    <td className="opt-col muted">{r.paidOn ? shortDate(r.paidOn) : ''}</td>
                    <td className="opt-col">{r.paidBy}</td>
                    <td className="opt-col">{potName(r.payout?.pot)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && (
                <tfoot><tr>
                  <td className="main-col">{t('Kul')} · {count(rows.length)}</td>
                  <td className="num opt-col money">{rupees(tot.bhada)}</td><td className="num opt-col money">{amt(tot.advance)}</td>
                  <td className="num opt-col money">{amt(tot.dala)}</td><td className="num opt-col money">{amt(tot.fine)}</td>
                  <td className="num opt-col money">{amt(tot.inaam)}</td><td className="num opt-col money">{amt(tot.halting)}</td>
                  <td className="num amt-col money">{rupees(tot.net)}</td><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" />
                </tr></tfoot>
              )}
            </table>
            {rows.length === 0 && <p className="empty">{view === 'baaki' ? t('Kisi gaadi ka bhada baaki nahi') : view === 'paid' ? t('Abhi koi gaadi paid nahi') : t('In dino mein koi gaadi nahi')}</p>}
          </div>
          <p className="muted note">{t('Net = bhada − advance − dala − fine − halting + inaam. Paid = app mein "All paid" dabaya gaya.')}</p>
        </div>
      )}
      {open && <BadaSheet row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** One gaadi's Bada as the app's Bada parchi has it: the bhada, each head with its sign, the net, and how it was paid. */
function BadaSheet({ row: r, onClose }: { row: BadaRow; onClose: () => void }) {
  const heads: [string, number, number][] = ([
    [t('Bhada'), 0, r.bhadaPaise], [t('Advance'), -1, r.advancePaise], [t('Dala'), -1, r.dalaPaise],
    [t('Inaam'), 1, r.inaamPaise], [t('Fine'), -1, r.finePaise], [t('Halting'), -1, r.haltingPaise],
  ] as [string, number, number][]).filter(([, sign, v]) => sign === 0 || v !== 0)
  return (
    <div className="scrim sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={t('Bada')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="sheet-hd"><h3>{t('Bada')} · {gaadiName(r)}</h3><button type="button" className="icon-btn" autoFocus aria-label={t('Band karein')} onClick={onClose}>×</button></div>
        <div className="sheet-bd">
          <div className="muted" style={{ marginBottom: 10 }}>
            {[r.supplier, t('Aayi {d}', { d: shortDate(r.arrivedOn) }), r.deal === 'purchase' ? t('Purchase') : r.deal === 'commission' ? t('Commission') : '', r.closed ? t('Band') : t('Khuli')]
              .filter(Boolean).join(' · ')}
          </div>
          <table className="tbl"><tbody>
            {heads.map(([label, sign, v]) => (
              <tr key={label}><td>{label}{sign < 0 ? ' (−)' : sign > 0 ? ' (+)' : ''}</td><td className="num money">{sign < 0 ? '− ' : sign > 0 ? '+ ' : ''}{rupees(v)}</td></tr>
            ))}
            <tr><td><b>{r.netPaise < 0 ? t('Gaadi wala dega') : t('Net dena')}</b></td><td className="num money"><b className={r.paid ? 'jama' : 'due'}>{rupees(Math.abs(r.netPaise))}</b></td></tr>
          </tbody></table>
          <div style={{ marginTop: 12 }}>
            {r.paid
              ? <><span className="chip green">{t('Paid')}</span> <span className="muted">{[r.paidOn ? shortDate(r.paidOn) : '', r.paidAt ? time(r.paidAt) : '', r.paidBy,
                  r.payout ? t('{pot} se {amt}', { pot: potName(r.payout.pot), amt: rupees(r.payout.amountPaise) }) : t('Aaya-Gaya mein line nahi')].filter(Boolean).join(' · ')}</span></>
              : <span className="chip red">{t('Baaki')}</span>}
          </div>
          {r.maal.length > 0 && (
            <>
              <h4 style={{ margin: '16px 0 6px' }}>{t('Maal aaya')}</h4>
              <table className="tbl"><tbody>
                {r.maal.map((m, i) => <tr key={i}><td>{m.maal || t('Maal')}</td><td className="num money">{t('{n} dana', { n: count(m.qty) })}</td></tr>)}
                <tr><td><b>{t('Kul')}</b></td><td className="num money"><b>{t('{n} dana', { n: count(r.dana) })}</b></td></tr>
                <tr><td>{t('Bika')}</td><td className="num money">{t('{n} dana', { n: count(r.sold) })}</td></tr>
              </tbody></table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================ Supplier ledger

type Party = { key: string; name: string; gaadis: number; purchase: number; commission: number; duePaise: number; lastAt: string | null }
type Lot = { maal: string; grade: string; qty: number; ratePaise: number; amountPaise: number }
type GaadiInfo = {
  truckId: string; number: string; deal: 'purchase' | 'commission'; closed: boolean; lots: Lot[]; dana: number; sold: number; phoota: number; left: number
  goodsPaise: number; correctionPaise: number
  beejak: { no: number; date: string; dana: number; grossPaise: number; expensesPaise: number; netPaise: number } | null
}
type LedgerRow = {
  id: string; date: string; at: string; kind: 'gaadi' | 'payment' | 'kaat' | 'badla'; title: string; detail: string
  debitPaise: number; creditPaise: number; balancePaise: number; gaadi?: GaadiInfo; mode?: string; forGaadi?: string
}
type Ledger = {
  key: string; name: string; from: string; to: string; openingPaise: number; closingPaise: number; duePaise: number; rows: LedgerRow[]
  totals: { creditPaise: number; debitPaise: number; paidPaise: number; adjustPaise: number; gaadis: number; dana: number; sold: number; phoota: number }
}

const lotText = (l: Lot) => [l.maal, l.grade].filter(Boolean).join(' ')
/** "Calcutta I 1,200 @ ₹12.50, Bhopal II 300": what came on a gaadi, by maal and quality. */
const lotsLine = (g: GaadiInfo) => g.lots.map((l) => `${lotText(l) || t('Maal')} ${count(l.qty)}${l.ratePaise ? ` @ ${rate(l.ratePaise)}` : ''}`).join(', ')
const beejakText = (g?: GaadiInfo) => (g?.beejak ? `#${g.beejak.no} · ${rs(g.beejak.netPaise)}` : g?.deal === 'commission' ? t('Nahi bana') : '')

export function NariyalSupplierLedger({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('30')
  const [key, setKey] = useState(() => hashQuery().get('k') ?? '')
  const [q, setQ] = useState('')
  const choose = (k: string) => { setKey(k); const h = Object.fromEntries(hashQuery()); if (k) h.k = k; else delete h.k; setHashQuery(h) }
  const { data: list, error: listError } = useLoad(() => api<{ rows: Party[] }>(`/v1/admin/shops/${shopId}/nariyal/suppliers`), [shopId])
  const { data, error, loading } = useLoad(
    () => (key ? api<Ledger>(`/v1/admin/shops/${shopId}/nariyal/suppliers/${encodeURIComponent(key)}/ledger?from=${period.from}&to=${period.to}`) : Promise.resolve(null)),
    [shopId, key, period.from, period.to])
  const led = key && data && data.key === key ? data : null

  useExport(led ? () => ({
    style: 'book' as const, title: t('SUPPLIER LEDGER'), party: { description: led.name }, dateLine: dayRange(period.from, period.to),
    file: fileName('Supplier-ledger', led.name, period.from, period.to),
    summary: [[t('Party'), led.name], [t('Opening'), balRs(led.openingPaise, 'supplier')], [t('Maal / beejak'), rs(led.totals.creditPaise)],
      [t('Diya'), rs(led.totals.paidPaise)], ...(led.totals.adjustPaise ? [[t('Kaat / badla'), rs(led.totals.adjustPaise)] as [string, string]] : []),
      [t('Closing'), balRs(led.closingPaise, 'supplier')]] as [string, string][],
    columns: [{ label: t('Tarikh') }, { label: t('Vivran'), wide: true }, { label: t('Aaya'), num: true }, { label: t('Bika'), num: true }, { label: t('Phoota'), num: true },
      { label: t('Beejak') }, { label: t('Dena'), num: true }, { label: t('Diya'), num: true }, { label: t('Balance'), num: true }],
    rows: [
      { bold: true, cells: [dmy(period.from), t('Opening balance'), '', '', '', '', '', '', balRs(led.openingPaise, 'supplier')] },
      ...led.rows.map((r) => ({
        bold: r.kind === 'gaadi',
        cells: [dmy(r.date), r.gaadi ? [`${r.title} · ${r.detail}`, lotsLine(r.gaadi)].filter(Boolean).join(' · ') : `${r.title}${r.detail ? ` · ${r.detail}` : ''}`,
          r.gaadi ? count(r.gaadi.dana) : '', r.gaadi ? count(r.gaadi.sold) : '', r.gaadi?.phoota ? count(r.gaadi.phoota) : '', beejakText(r.gaadi),
          r.creditPaise ? rs(r.creditPaise) : '', r.debitPaise ? rs(r.debitPaise) : '', balRs(r.balancePaise, 'supplier')],
      })),
    ],
    foot: [t('Kul'), t('Closing balance'), count(led.totals.dana), count(led.totals.sold), led.totals.phoota ? count(led.totals.phoota) : '', '',
      rs(led.totals.creditPaise), rs(led.totals.debitPaise), balRs(led.closingPaise, 'supplier')],
    note: t('Purchase gaadi: maal x kharid bhav (bhada gaadi wale ka, Bhada mein). Commission gaadi: beejak ka shudh.'),
    sign: true,
  }) : null, [led])

  const parties = list?.rows ?? []
  const query = q.trim().toLowerCase()
  const shown = parties.filter((p) => !query || p.name.toLowerCase().includes(query))

  return (
    <>
      <div className="toolbar">
        <select className="field" aria-label={t('Supplier')} style={{ flex: '1 1 260px', maxWidth: 380 }} value={key} onChange={(e) => choose(e.target.value)}>
          <option value="">{t('Supplier chunein')}</option>
          {parties.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <PeriodBar value={period} onChange={setPeriod} />
      </div>
      {listError && <p className="error">{listError}</p>}
      {error && key && <p className="error">{error}</p>}
      {!key ? (
        !list ? <Skeleton /> : (
          <div className="stack">
            <div className="toolbar" style={{ margin: 0 }}>
              <input className="field grow" data-search type="search" placeholder={t('Supplier ka naam')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="card wrap-x">
              <table className="tbl fold">
                <thead><tr><th>{t('Supplier')}</th><th className="num">{t('Purchase')}</th><th className="num">{t('Commission')}</th><th className="num">{t('Baaki')}</th></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.key} data-row tabIndex={0} onClick={() => choose(p.key)} onKeyDown={(e) => { if (e.key === 'Enter') choose(p.key) }}>
                      <td className="main-col"><b>{p.name}</b><small>{t('{n} gaadi', { n: count(p.gaadis) })}{p.lastAt ? ` · ${shortDate(p.lastAt.slice(0, 10))}` : ''}</small></td>
                      <td className="num opt-col">{p.purchase ? count(p.purchase) : ''}</td>
                      <td className="num opt-col">{p.commission ? count(p.commission) : ''}</td>
                      <td className="num amt-col"><Bal paise={p.duePaise} who="supplier" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && <p className="empty">{t('Koi supplier nahi')}</p>}
            </div>
          </div>
        )
      ) : !led ? <Skeleton /> : (
        <div className={`stack${loading ? ' dim' : ''}`}>
          <div>
            <button type="button" className="btn line" onClick={() => choose('')}>{t('Sab supplier')}</button>
            <h1 style={{ marginTop: 10 }}>{led.name}</h1>
          </div>
          <div className="card sum">
            <div><span className="lb">{t('Opening')}</span><span className="v"><Bal paise={led.openingPaise} who="supplier" /></span></div>
            <div><span className="lb">{t('Maal / beejak')}</span><span className="v">{rupees(led.totals.creditPaise)}</span></div>
            <div><span className="lb">{t('Diya')}</span><span className="v jama">{rupees(led.totals.paidPaise)}</span></div>
            {!!led.totals.adjustPaise && <div><span className="lb">{t('Kaat / badla')}</span><span className="v">{rupees(led.totals.adjustPaise)}</span></div>}
            <div><span className="lb">{t('Closing')}</span><span className="v"><Bal paise={led.closingPaise} who="supplier" /></span></div>
            <div><span className="lb">{t('Gaadi')}</span><span className="v">{count(led.totals.gaadis)} · {t('{n} dana', { n: count(led.totals.dana) })}</span></div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr>
                <th>{t('Tarikh')}</th><th>{t('Vivran')}</th><th className="num">{t('Aaya')}</th><th className="num">{t('Bika')}</th><th className="num">{t('Phoota')}</th>
                <th>{t('Beejak')}</th><th className="num">{t('Dena')}</th><th className="num">{t('Diya')}</th><th className="num">{t('Balance')}</th>
              </tr></thead>
              <tbody>
                <tr>
                  <td className="opt-col muted">{shortDate(period.from)}</td>
                  <td className="main-col"><b>{t('Opening balance')}</b></td>
                  <td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" /><td className="opt-col" />
                  <td className="num amt-col"><Bal paise={led.openingPaise} who="supplier" /></td>
                </tr>
                {led.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td className="opt-col muted">{shortDate(r.date)}</td>
                    <td className="main-col">
                      <b>{r.title}</b>{r.kind === 'gaadi' && <> <span className={`chip ${r.gaadi?.deal === 'purchase' ? 'blue' : 'amber'}`}>{r.detail}</span></>}
                      <small>
                        {r.gaadi ? <>
                          {r.gaadi.lots.map((l, i) => <div key={i}>{lotText(l) || t('Maal')} · {t('{n} dana', { n: count(l.qty) })}{l.ratePaise ? ` @ ${rate(l.ratePaise)}` : ''}</div>)}
                          {r.gaadi.correctionPaise !== 0 && <div>{t('Ginti sudhaar')} · {rupees(-r.gaadi.correctionPaise)}</div>}
                          {r.gaadi.beejak && <div>{t('Beejak #{n}', { n: r.gaadi.beejak.no })} · {t('bikri')} {rupees(r.gaadi.beejak.grossPaise)} − {t('kharcha')} {rupees(r.gaadi.beejak.expensesPaise)}</div>}
                          {r.gaadi.deal === 'commission' && !r.gaadi.beejak && <div>{t('Beejak abhi nahi bana')}</div>}
                          <span className="show-sm">{t('{a} aaya · {b} bika', { a: count(r.gaadi.dana), b: count(r.gaadi.sold) })}{r.gaadi.phoota ? ` · ${t('{n} phoota', { n: count(r.gaadi.phoota) })}` : ''}</span>
                        </> : r.detail}
                      </small>
                    </td>
                    <td className="num opt-col money">{r.gaadi ? count(r.gaadi.dana) : ''}</td>
                    <td className="num opt-col money">{r.gaadi ? count(r.gaadi.sold) : ''}</td>
                    <td className="num opt-col money muted">{r.gaadi?.phoota ? count(r.gaadi.phoota) : ''}</td>
                    <td className="opt-col">{r.gaadi?.beejak ? <>#{r.gaadi.beejak.no} · {rupees(r.gaadi.beejak.netPaise)}</> : ''}</td>
                    <td className="num opt-col money">{r.creditPaise ? rupees(r.creditPaise) : ''}</td>
                    <td className="num opt-col money jama">{r.debitPaise ? rupees(r.debitPaise) : ''}</td>
                    <td className="num amt-col"><Bal paise={r.balancePaise} who="supplier" /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td className="opt-col" /><td className="main-col">{t('Closing balance')}</td>
                <td className="num opt-col money">{count(led.totals.dana)}</td><td className="num opt-col money">{count(led.totals.sold)}</td>
                <td className="num opt-col money">{led.totals.phoota ? count(led.totals.phoota) : ''}</td><td className="opt-col" />
                <td className="num opt-col money">{rupees(led.totals.creditPaise)}</td><td className="num opt-col money">{rupees(led.totals.debitPaise)}</td>
                <td className="num amt-col"><Bal paise={led.closingPaise} who="supplier" /></td>
              </tr></tfoot>
            </table>
            {led.rows.length === 0 && <p className="empty">{t('In dino mein kuch nahi')}</p>}
          </div>
          {led.closingPaise !== led.duePaise && (
            <p className="muted note">{t('Aaj tak ka poora baaki')}: {balRs(led.duePaise, 'supplier')}</p>
          )}
          <p className="muted note">{t('Purchase gaadi: maal x kharid bhav (bhada gaadi wale ka, Bhada mein). Commission gaadi: beejak ka shudh. Sirf Supplier Ledger ki payment (gaadi ke liye ya on account).')}</p>
        </div>
      )}
    </>
  )
}
