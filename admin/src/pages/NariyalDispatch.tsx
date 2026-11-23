import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { count, shortDate, time } from '../format'
import { usePeriod } from '../hooks'
import { t } from '../i18n'
import { openVoucher } from '../keys'
import { hashQuery, setHashQuery } from '../routes'
import { booksChanged, useLoad } from '../useLoad'
import { PeriodBar, Skeleton } from '../ui'
import * as I from '../icons'
import { dayRange, fileName, useExport } from '../export/doc'

/**
 * Nariyal Dispatch, the website's copy of the app's Hisab > Dispatch. In the evening the labour
 * hand back the parchis; the munim scans each one (a gun types into the box and presses Enter,
 * or the number is typed) and clicks Maal diya. The count (56 / 444) moves at once, the Baaki
 * list is what never came back, and the PDF marks those rows NAHI AAYI. Scans made on the
 * machines show here within a few seconds, and the website's scans reach the machines by sync.
 */
type Row = {
  billId: string; slipNo: number | null; buyer: string; date: string; at: string; qty: number
  gaadis: { truckId: string; name: string }[]; scanned: boolean; scannedAt: string | null; scannedBy: string
}
type Desk = { from: string; to: string; slips: Row[]; totals: { slips: number; scanned: number; missing: number; dana: number; danaScanned: number; danaMissing: number } }
type Slip = { billId: string; slipNo: number | null; buyer: string; date: string; at: string; gaadi: string; qty: number; lines: { maal: string; qty: number }[]; scanned: boolean; scannedAt: string | null }

const slipName = (s: { slipNo: number | null }) => (s.slipNo ? `#${s.slipNo}` : t('Parchi'))
const dana = (n: number) => t('{n} dana', { n: count(n) })
type View = 'baaki' | 'done' | 'sab'

export function NariyalDispatch({ shopId }: { shopId: string }) {
  const [period, setPeriod] = usePeriod('aaj')
  const [view, setView] = useState<View>(() => (['done', 'sab'].includes(hashQuery().get('v') ?? '') ? hashQuery().get('v') as View : 'sab'))
  const pick = (v: View) => { setView(v); setHashQuery({ ...Object.fromEntries(hashQuery()), v }) }
  const { data, error, reload } = useLoad(
    () => api<Desk>(`/v1/admin/shops/${shopId}/nariyal/dispatch?from=${period.from}&to=${period.to}`), [shopId, period.from, period.to])
  // The machines scan too: their Maal diya shows here without a reload.
  useEffect(() => { const h = setInterval(() => { if (document.visibilityState === 'visible') reload() }, 8000); return () => clearInterval(h) }, [reload])

  const all = data?.slips ?? []
  const rows = (view === 'sab' ? all : all.filter((s) => (view === 'done' ? s.scanned : !s.scanned)))
    // Scanned ones newest scan first, as the app's Scan hui list.
    .slice().sort((a, b) => (view === 'done' ? (b.scannedAt ?? '').localeCompare(a.scannedAt ?? '') : 0))
  const many = period.from !== period.to
  const pct = data && data.totals.slips ? Math.round((data.totals.scanned / data.totals.slips) * 100) : 0

  useExport(data ? () => ({
    style: 'book' as const, title: t('Dispatch · Parchi wapas'), dateLine: dayRange(period.from, period.to), file: fileName('Dispatch', period.from, period.to),
    summary: [[t('Kul parchi'), count(data.totals.slips)], [t('Scan hui'), count(data.totals.scanned)], [t('Nahi aayi'), count(data.totals.missing)],
      [t('Kul dana'), count(data.totals.dana)], [t('Baaki dana'), count(data.totals.danaMissing)]] as [string, string][],
    columns: [{ label: t('Parchi') }, { label: t('Grahak'), wide: true }, { label: t('Gaadi'), wide: true }, { label: t('Dana'), num: true }, { label: t('Haal') }],
    rows: data.slips.map((s) => ({
      bold: !s.scanned,
      cells: [slipName(s), s.buyer, s.gaadis.map((g) => g.name).join(', '), count(s.qty),
        s.scanned ? t('Scan {at}', { at: s.scannedAt ? time(s.scannedAt) : '' }) : t('NAHI AAYI (MISSING)')],
    })),
    foot: [t('Kul'), '', '', count(data.totals.dana), `${count(data.totals.scanned)} / ${count(data.totals.slips)}`],
  }) : null, [data])

  const undo = async (s: Row) => {
    if (!confirm(t('Parchi {n} ka scan hatayein? Yeh phir se Baaki mein aa jayegi.', { n: slipName(s) }))) return
    try { await api(`/v1/admin/shops/${shopId}/nariyal/returns/undo`, { method: 'POST', body: { billId: s.billId } }); reload(); booksChanged() }
    catch (e) { alert((e as Error).message) }
  }

  return (
    <>
      <Scanner shopId={shopId} onSaved={reload} />
      <div className="toolbar">
        <PeriodBar value={period} onChange={setPeriod} />
        <div className="seg" role="group">
          <button aria-pressed={view === 'sab'} onClick={() => pick('sab')}>{t('Sab')}{data ? ` · ${data.totals.slips}` : ''}</button>
          <button aria-pressed={view === 'done'} onClick={() => pick('done')}>{t('Scan hui')}{data ? ` · ${data.totals.scanned}` : ''}</button>
          <button aria-pressed={view === 'baaki'} onClick={() => pick('baaki')}>{t('Baaki')}{data ? ` · ${data.totals.missing}` : ''}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? <Skeleton /> : (
        <div className="stack">
          <div className="card sum">
            <div><span className="lb">{t('Scan hui')}</span><span className="v">{count(data.totals.scanned)} / {count(data.totals.slips)}</span></div>
            <div><span className="lb">{t('Nahi aayi')}</span><span className={`v${data.totals.missing ? ' due' : ''}`}>{count(data.totals.missing)}</span></div>
            <div><span className="lb">{t('Kul dana')}</span><span className="v">{count(data.totals.dana)}</span></div>
            <div><span className="lb">{t('Dana gaya')}</span><span className="v jama">{count(data.totals.danaScanned)}</span></div>
            <div><span className="lb">{t('Dana baaki')}</span><span className={`v${data.totals.danaMissing ? ' due' : ''}`}>{count(data.totals.danaMissing)}</span></div>
          </div>
          <div className="card" style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
              <span className="muted">{t('Parchi wapas aayi')}</span><b>{pct}%</b>
            </div>
            <div style={{ height: 10, borderRadius: 6, background: 'var(--line-2)', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s' }} />
            </div>
          </div>
          <div className="card wrap-x">
            <table className="tbl fold">
              <thead><tr><th>{t('Parchi')}</th><th>{t('Gaadi')}</th><th className="num">{t('Dana')}</th><th className="num">{t('Haal')}</th><th /></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.billId} data-row tabIndex={0} onClick={() => openVoucher(shopId, s.billId)} onKeyDown={(e) => { if (e.key === 'Enter') openVoucher(shopId, s.billId) }}
                    style={s.scanned ? undefined : { background: 'var(--due-soft)' }}>
                    <td className="main-col"><b>{slipName(s)} · {s.buyer}</b>
                      <small>{[many ? shortDate(s.date) : '', t('Bill {at}', { at: time(s.at) }),
                        s.scannedAt ? t('Scan {at}', { at: time(s.scannedAt) }) : '', s.scannedBy].filter(Boolean).join(' · ')}
                        <span className="show-sm"> · {s.gaadis.map((g) => g.name).join(', ')}</span></small></td>
                    <td className="opt-col">{s.gaadis.map((g) => <div key={g.truckId}><b>{g.name}</b></div>)}</td>
                    <td className="num opt-col money">{count(s.qty)}</td>
                    <td className="num amt-col">{s.scanned ? <span className="chip green">{t('Maal diya')}</span> : <span className="chip red">{t('Nahi aayi')}</span>}</td>
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      {s.scanned && <button type="button" className="btn line" style={{ whiteSpace: 'nowrap' }} onClick={() => undo(s)}>{t('Scan galat tha')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="empty">{view === 'baaki' ? t('Sab parchi wapas aa gayi') : view === 'done' ? t('Abhi koi scan nahi hui') : t('Koi parchi nahi')}</p>}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * The scan box: a Bluetooth / USB gun types the barcode and presses Enter, or the parchi number
 * is typed. The parchi opens with its gaadi and dana; Maal diya saves it once. A repeat shows red.
 */
function Scanner({ shopId, onSaved }: { shopId: string; onSaved: () => void }) {
  const [code, setCode] = useState('')
  const [slip, setSlip] = useState<Slip | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; title: string; detail?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => { box.current?.focus() }, [])

  const look = async (raw: string) => {
    const c = raw.trim()
    if (!c || busy) return
    setCode(''); setBusy(true)
    try {
      const s = await api<Slip>(`/v1/admin/shops/${shopId}/nariyal/slip?code=${encodeURIComponent(c)}`)
      if (s.scanned) { setSlip(null); setMsg({ ok: false, title: t('Pehle hi scan ho chuki'), detail: `${slipName(s)} · ${s.buyer} · ${dana(s.qty)}${s.scannedAt ? ` · ${time(s.scannedAt)}` : ''}` }) }
      else { setMsg(null); setSlip(s) }
    } catch (e) { setSlip(null); setMsg({ ok: false, title: (e as Error).message || t('Parchi nahi mili') }) }
    finally { setBusy(false); box.current?.focus() }
  }
  const give = async () => {
    if (!slip || busy) return
    setBusy(true)
    try {
      const r = await api<Slip & { already: boolean }>(`/v1/admin/shops/${shopId}/nariyal/returns`, { method: 'POST', body: { billId: slip.billId } })
      setMsg(r.already ? { ok: false, title: t('Pehle hi scan ho chuki'), detail: `${slipName(slip)} · ${slip.buyer}` }
        : { ok: true, title: t('Parchi {n} wapas', { n: slipName(slip) }), detail: `${slip.buyer} · ${slip.gaadi || t('Gaadi')} · ${dana(slip.qty)}` })
      setSlip(null); onSaved(); booksChanged()
    } catch (e) { setMsg({ ok: false, title: (e as Error).message }) }
    finally { setBusy(false); box.current?.focus() }
  }

  return (
    <div className="stack" style={{ marginBottom: 16 }}>
      <div className="card" style={{ padding: '14px 18px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex' }}><I.IScan /></span>
        <input ref={box} className="field" style={{ flex: 1, minWidth: 220 }} value={code} disabled={busy}
          placeholder={t('Gun se scan karein ya parchi number likh ke Enter dabayein')}
          onChange={(e) => {
            const v = e.target.value
            setCode(v)
            // A gun set to send no Enter: a whole barcode (20 digits) or QR (the parchi id) opens as soon as it is in.
            if (/^\d{20}$/.test(v.trim()) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())) void look(v)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void look(code) } }} />
        <button type="button" className="btn primary" disabled={busy || !code.trim()} onClick={() => look(code)}>{t('Kholein')}</button>
      </div>
      {slip && (
        <div className="card" style={{ padding: '16px 18px', background: 'var(--accent-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <b style={{ fontSize: 18 }}>{t('Parchi {n}', { n: slipName(slip) })} · {slip.buyer}</b>
            <span className="muted">{shortDate(slip.date)} · {time(slip.at)}</span>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>{t('Gaadi')}: <b style={{ color: 'var(--ink)' }}>{slip.gaadi || '-'}</b></div>
          <table className="tbl" style={{ marginTop: 8 }}>
            <tbody>
              {slip.lines.map((l, i) => <tr key={i}><td>{l.maal || t('Maal')}</td><td className="num money">{dana(l.qty)}</td></tr>)}
              <tr><td><b>{t('Kul')}</b></td><td className="num money"><b>{dana(slip.qty)}</b></td></tr>
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" className="btn primary" autoFocus disabled={busy} onClick={give}>{t('Maal diya')}</button>
            <button type="button" className="btn line" disabled={busy} onClick={() => { setSlip(null); box.current?.focus() }}>{t('Rehne dein')}</button>
          </div>
        </div>
      )}
      {msg && (
        <div className="card" role="status" style={{ padding: '12px 18px', background: msg.ok ? 'var(--accent-soft)' : 'var(--due-soft)' }}>
          <b style={{ color: msg.ok ? 'var(--accent-ink)' : 'var(--due)', fontSize: 16 }}>{msg.title}</b>
          {msg.detail && <div className="muted" style={{ fontSize: 13 }}>{msg.detail}</div>}
        </div>
      )}
    </div>
  )
}
