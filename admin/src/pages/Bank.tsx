import { useState } from 'react'
import { api } from '../api'
import { useSession } from '../App'
import { rupees, shortDate, todayIst } from '../format'
import { t } from '../i18n'
import { useLoad } from '../useLoad'
import { Skeleton } from '../ui'
import { Seg } from '../entries/fields'

// ================================================================ Bank khata and reconciliation (partner)

type Account = {
  key: string; bank: string; account: string; holder: string; ifsc: string; label: string
  opening: { paise: number; on: string; by: string } | null; statement: { lines: number; first: string | null; last: string | null }
}
type Entry = {
  key: string; date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string; kind: string; title: string; party: string; note: string; assumed: boolean
}
type Line = { id: string; date: string; direction: 'cr' | 'dr'; amountPaise: number; ref: string; narration: string; balancePaise: number | null; source: 'csv' | 'manual' }
type Ledger = {
  from: string; to: string; opening: { paise: number; on: string } | null; openingPaise: number; inPaise: number; outPaise: number; closingPaise: number
  lines: (Entry & { balancePaise: number })[]; unassigned: Entry[]; beforeOpening: boolean
}
type Pair = { line: Line; entry: Entry; how: 'manual' | 'ref' | 'amount'; diffPaise?: number }
type Recon = {
  from: string; to: string
  statement: { openingPaise: number | null; closingPaise: number | null; inPaise: number; outPaise: number; lines: number }
  app: { openingPaise: number; closingPaise: number; inPaise: number; outPaise: number; entries: number }
  difference: { openingPaise: number | null; closingPaise: number | null; netPaise: number }
  matched: Pair[]; amountDiffers: Pair[]; bankOnly: Line[]; appOnly: Entry[]
}
type Mapping = { date?: number; narration?: number; ref?: number; debit?: number; credit?: number; amount?: number; drcr?: number; balance?: number }
type Preview = { headerRow: number; header: string[]; columns: number; sample: string[][]; mapping: Mapping; dateOrder: 'dmy' | 'mdy' | 'ymd'; rows: number }
type Batch = { id: string; source: 'csv' | 'manual'; fileName: string; lines: number; skipped: number; by: string; at: string; voided: boolean; from: string | null; to: string | null }

/** Rupees typed (may be negative, may have commas) to paise; null when it is not a number. */
const toPaise = (s: string): number | null => {
  const c = s.replace(/[,\s₹]/g, '')
  if (!/^-?\d+(\.\d{0,2})?$/.test(c)) return null
  const neg = c.startsWith('-')
  const [w, f = ''] = c.replace('-', '').split('.')
  const p = Number(w) * 100 + Number((f + '00').slice(0, 2))
  return neg ? -p : p
}
const signedText = (paise: number | null) => (paise === null ? '—' : paise === 0 ? rupees(0) : `${paise > 0 ? '+' : ''}${rupees(paise)}`)
const KIND_LABEL: Record<string, string> = {
  bikri: 'UPI bikri', vasooli: 'UPI vasooli', jama: 'Bank jama (cash)', cheque: 'Cheque clear', charges: 'Cheque bounce charges', daybook: 'Day Book',
}
const entryTitle = (e: Entry) => (e.kind === 'daybook' ? e.title : KIND_LABEL[e.kind] ?? e.title)

/** Per bank account of the shop: its opening, the bank khata, the statement uploads and the milan (reconciliation). */
export function Bank({ shopId }: { shopId: string }) {
  const [tick, setTick] = useState(0)
  const { data, error } = useLoad(() => api<{ today: string; accounts: Account[] }>(`/v1/admin/shops/${shopId}/bank`), [shopId, tick])
  const [key, setKey] = useState('')
  const [tab, setTab] = useState<'khata' | 'statement' | 'milan'>('milan')
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  if (!data.accounts.length) {
    return <div className="card"><p className="empty">{t('Settings mein dukaan ka bank khata (account number ke saath) daalein, phir yahan uska hisab dikhega')}</p></div>
  }
  const account = data.accounts.find((a) => a.key === key) ?? data.accounts[0]
  const reload = () => setTick((n) => n + 1)
  return (
    <div className="stack">
      {data.accounts.length > 1 && (
        <Seg value={account.key} onChange={setKey} options={data.accounts.map((a) => ({ key: a.key, label: a.label }))} />
      )}
      <OpeningCard shopId={shopId} account={account} onSaved={reload} />
      <Seg value={tab} onChange={setTab} options={[
        { key: 'milan', label: t('Milan (reconcile)') }, { key: 'khata', label: t('Bank khata') }, { key: 'statement', label: t('Bank statement') },
      ]} />
      {tab === 'khata' && <BankLedger key={`${account.key}-${tick}`} shopId={shopId} account={account} />}
      {tab === 'statement' && <Statement key={account.key} shopId={shopId} account={account} onChanged={reload} />}
      {tab === 'milan' && <Milan key={`${account.key}-${tick}`} shopId={shopId} account={account} />}
    </div>
  )
}

function OpeningCard({ shopId, account, onSaved }: { shopId: string; account: Account; onSaved: () => void }) {
  const [edit, setEdit] = useState(false)
  const [amount, setAmount] = useState(account.opening ? String(account.opening.paise / 100) : '')
  const [on, setOn] = useState(account.opening?.on ?? todayIst())
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const p = toPaise(amount)
    if (p === null) { setMsg(t('Rakam sahi daalein')); return }
    setBusy(true); setMsg('')
    try {
      await api(`/v1/admin/shops/${shopId}/bank/opening`, { method: 'POST', body: { account: account.key, openingPaise: p, openingOn: on } })
      setEdit(false); onSaved()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <div className="hd">
        <h3>{account.label}{account.holder ? <small className="muted"> · {account.holder}</small> : null}</h3>
        {!edit && <button type="button" className="btn ghost" onClick={() => setEdit(true)}>{account.opening ? t('Opening badlein') : t('Opening daalein')}</button>}
      </div>
      {!edit ? (
        <div className="sum">
          <div><span className="lb">{t('Opening balance')}</span><span className="v">{account.opening ? rupees(account.opening.paise) : '—'}</span></div>
          <div><span className="lb">{t('Kab se')}</span><span className="v">{account.opening ? shortDate(account.opening.on) : '—'}</span></div>
          <div><span className="lb">{t('Statement lines')}</span><span className="v">{account.statement.lines}</span></div>
          <div><span className="lb">{t('Statement tak')}</span><span className="v">{account.statement.last ? shortDate(account.statement.last) : '—'}</span></div>
        </div>
      ) : (
        <div className="hd" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label className="fld"><span className="fld-lb">{t('Tarikh')}</span><input className="field" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
          <label className="fld"><span className="fld-lb">{t('Bank mein kitna tha (₹, minus = overdraft)')}</span>
            <input className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></label>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>{t('Save')}</button>
          <button type="button" className="btn ghost" onClick={() => setEdit(false)}>{t('Rehne dein')}</button>
          {msg && <span className="error" style={{ margin: 0 }}>{msg}</span>}
        </div>
      )}
      {!account.opening && !edit && <p className="muted" style={{ padding: '0 16px 12px' }}>{t('Opening ke bina khata shuru se ginta hai; bank ki statement wali tarikh ka balance daalein')}</p>}
    </div>
  )
}

function Range({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <div className="toolbar">
      <label className="fld"><span className="fld-lb">{t('Se')}</span><input className="field" type="date" value={from} onChange={(e) => onChange(e.target.value, to)} /></label>
      <label className="fld"><span className="fld-lb">{t('Tak')}</span><input className="field" type="date" value={to} onChange={(e) => onChange(from, e.target.value)} /></label>
    </div>
  )
}

function BankLedger({ shopId, account }: { shopId: string; account: Account }) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const qs = `account=${encodeURIComponent(account.key)}${range.from ? `&from=${range.from}` : ''}${range.to ? `&to=${range.to}` : ''}`
  const { data, error, loading } = useLoad(() => api<Ledger>(`/v1/admin/shops/${shopId}/bank/ledger?${qs}`), [shopId, qs])
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  return (
    <div className={`stack${loading ? ' dim' : ''}`}>
      <Range from={data.from} to={data.to} onChange={(from, to) => setRange({ from, to })} />
      <div className="card sum">
        <div><span className="lb">{t('Shuru (b/f)')}</span><span className="v">{rupees(data.openingPaise)}</span></div>
        <div><span className="lb">{t('Aaya')}</span><span className="v jama">+{rupees(data.inPaise)}</span></div>
        <div><span className="lb">{t('Gaya')}</span><span className="v due">−{rupees(data.outPaise)}</span></div>
        <div><span className="lb">{t('Bacha (c/f)')}</span><span className="v">{rupees(data.closingPaise)}</span></div>
      </div>
      {data.beforeOpening && <p className="muted">{t('Opening ki tarikh se pehle ka hisab is khate mein nahi ginta')}</p>}
      <div className="card wrap-x">
        <table className="tbl fold">
          <thead><tr><th>{t('Tarikh')}</th><th>{t('Vivaran')}</th><th className="num">{t('Aaya')}</th><th className="num">{t('Gaya')}</th><th className="num">{t('Balance')}</th></tr></thead>
          <tbody>
            <tr><td className="opt-col muted">{shortDate(data.from)}</td><td className="main-col"><b>{t('Shuru ka balance')}</b></td><td className="opt-col" /><td className="opt-col" />
              <td className="num amt-col money b">{rupees(data.openingPaise)}</td></tr>
            {data.lines.map((l) => (
              <tr key={l.key}>
                <td className="opt-col muted">{shortDate(l.date)}</td>
                <td className="main-col"><b>{entryTitle(l)}</b>
                  <small>{[l.party, l.note, l.ref && `Ref ${l.ref}`].filter(Boolean).join(' · ')}{l.assumed ? ` · ${t('bank nahi chuna, pehla khata maana')}` : ''}</small></td>
                <td className="num opt-col money">{l.direction === 'cr' ? rupees(l.amountPaise) : ''}</td>
                <td className="num opt-col money">{l.direction === 'dr' ? rupees(l.amountPaise) : ''}</td>
                <td className="num amt-col money">{rupees(l.balancePaise)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td className="opt-col" /><td className="main-col">{t('Bacha (c/f)')}</td><td className="num opt-col money">{rupees(data.inPaise)}</td>
            <td className="num opt-col money">{rupees(data.outPaise)}</td><td className="num amt-col money">{rupees(data.closingPaise)}</td></tr></tfoot>
        </table>
        {data.lines.length === 0 && <p className="empty">{t('Is period mein koi len-den nahi')}</p>}
      </div>
      {data.unassigned.length > 0 && (
        <div className="card wrap-x">
          <div className="hd"><h3>{t('Kisi aur bank ke naam')}</h3><span className="muted">{t('Settings mein yeh khata nahi hai, isliye nahi gina')}</span></div>
          <table className="tbl"><tbody>
            {data.unassigned.map((e) => <tr key={e.key}><td className="muted">{shortDate(e.date)}</td><td>{entryTitle(e)} <small>{e.party}</small></td><td className="num money">{rupees(e.amountPaise)}</td></tr>)}
          </tbody></table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- statement: CSV with a column mapping, or typed lines

const FIELDS: { key: keyof Mapping; label: string }[] = [
  { key: 'date', label: 'Tarikh' }, { key: 'narration', label: 'Narration' }, { key: 'ref', label: 'Ref / UTR' },
  { key: 'debit', label: 'Debit (nikla)' }, { key: 'credit', label: 'Credit (aaya)' }, { key: 'amount', label: 'Ek hi Amount column' },
  { key: 'drcr', label: 'Dr / Cr column' }, { key: 'balance', label: 'Balance' },
]

function Statement({ shopId, account, onChanged }: { shopId: string; account: Account; onChanged: () => void }) {
  const [tick, setTick] = useState(0)
  const { data } = useLoad(() => api<{ batches: Batch[] }>(`/v1/admin/shops/${shopId}/bank/batches?account=${encodeURIComponent(account.key)}`), [shopId, account.key, tick])
  const changed = () => { setTick((n) => n + 1); onChanged() }
  const { me } = useSession()
  return (
    <div className="stack">
      <CsvUpload shopId={shopId} account={account} onDone={changed} />
      <ManualLines shopId={shopId} account={account} onDone={changed} />
      <div className="card wrap-x">
        <div className="hd"><h3>{t('Upload')}</h3></div>
        <table className="tbl">
          <thead><tr><th>{t('Kab')}</th><th>{t('File')}</th><th className="num">{t('Lines')}</th><th>{t('Tarikh')}</th><th /></tr></thead>
          <tbody>
            {(data?.batches ?? []).map((b) => (
              <tr key={b.id} className={b.voided ? 'muted' : undefined}>
                <td>{shortDate(b.at.slice(0, 10))}<small>{b.by === me?.phone ? t('aap') : b.by}</small></td>
                <td>{b.source === 'csv' ? b.fileName || 'CSV' : t('Haath se')}{b.voided ? ` · ${t('Hatayi gayi')}` : ''}</td>
                <td className="num">{b.lines}{b.skipped ? <small>{t('{n} chhodi', { n: b.skipped })}</small> : null}</td>
                <td>{b.from ? `${shortDate(b.from)} – ${shortDate(b.to!)}` : '—'}</td>
                <td>{!b.voided && <button type="button" className="btn ghost" onClick={async () => {
                  if (!confirm(t('Yeh poora upload hatayein? Iski lines aur unke milan hat jayenge.'))) return
                  await api(`/v1/admin/shops/${shopId}/bank/batches/${b.id}/void`, { method: 'POST' }); changed()
                }}>{t('Hatayein')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.batches.length === 0 && <p className="empty">{t('Abhi koi statement nahi chadhi')}</p>}
      </div>
    </div>
  )
}

function CsvUpload({ shopId, account, onDone }: { shopId: string; account: Account; onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [pre, setPre] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [order, setOrder] = useState<'dmy' | 'mdy' | 'ymd'>('dmy')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = async (f: File | undefined) => {
    if (!f) return
    setMsg(''); setPre(null)
    const text = await f.text()
    setFile({ name: f.name, text })
    try {
      const p = await api<Preview>(`/v1/admin/shops/${shopId}/bank/csv/preview`, { method: 'POST', body: { text } })
      setPre(p); setMapping(p.mapping); setOrder(p.dateOrder)
    } catch (e) { setMsg((e as Error).message) }
  }
  const run = async () => {
    if (!file || !pre) return
    setBusy(true); setMsg('')
    try {
      const r = await api<{ added: number; duplicates: number; skipped: number }>(`/v1/admin/shops/${shopId}/bank/csv/import`, {
        method: 'POST', body: { account: account.key, text: file.text, fileName: file.name, headerRow: pre.headerRow, mapping, dateOrder: order },
      })
      setMsg(t('{a} line chadhi, {d} pehle se thi, {s} chhodi', { a: r.added, d: r.duplicates, s: r.skipped }))
      setPre(null); setFile(null); onDone()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  const colName = (i: number) => (pre?.header[i] ? `${i + 1}. ${pre.header[i]}` : `${t('Column')} ${i + 1}`)
  const cols = pre ? Array.from({ length: pre.columns }, (_, i) => i) : []
  return (
    <div className="card">
      <div className="hd"><h3>{t('CSV chadhayein')}</h3><span className="muted">{t('Bank ki site se statement CSV mein download karein')}</span></div>
      <div style={{ padding: '0 16px 12px' }}>
        <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
        {pre && (
          <>
            <p className="muted">{pre.headerRow >= 0 ? t('Header line {n} par mila; {r} line', { n: pre.headerRow + 1, r: pre.rows }) : t('Header nahi mila: column khud chunein')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {FIELDS.map((f) => (
                <label key={f.key} className="fld"><span className="fld-lb">{t(f.label)}</span>
                  <select className="field" value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">—</option>
                    {cols.map((i) => <option key={i} value={i}>{colName(i)}</option>)}
                  </select>
                </label>
              ))}
              <label className="fld"><span className="fld-lb">{t('Tarikh ka dhang')}</span>
                <select className="field" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
                  <option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option><option value="ymd">YYYY-MM-DD</option>
                </select>
              </label>
            </div>
            <div className="wrap-x" style={{ marginTop: 8 }}>
              <table className="tbl">
                <thead><tr>{cols.map((i) => <th key={i}>{colName(i)}</th>)}</tr></thead>
                <tbody>{pre.sample.slice(0, 6).map((r, k) => <tr key={k}>{cols.map((i) => <td key={i}>{r[i] ?? ''}</td>)}</tr>)}</tbody>
              </table>
            </div>
            <div className="hd">
              <span className="muted">{t('Debit + Credit column, ya ek Amount column (Dr/Cr ke saath) chunein')}</span>
              <button type="button" className="btn primary" disabled={busy || mapping.date === undefined || (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined)} onClick={run}>{t('Chadhayein')}</button>
            </div>
          </>
        )}
        {msg && <p className={msg.includes('chadhi') ? 'muted' : 'error'}>{msg}</p>}
      </div>
    </div>
  )
}

type Draft = { date: string; direction: 'cr' | 'dr'; amount: string; ref: string; narration: string; balance: string }
const blankDraft = (): Draft => ({ date: todayIst(), direction: 'cr', amount: '', ref: '', narration: '', balance: '' })

function ManualLines({ shopId, account, onDone }: { shopId: string; account: Account; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Draft[]>([blankDraft()])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const save = async () => {
    const lines = []
    for (const r of rows) {
      if (!r.amount.trim()) continue
      const amt = toPaise(r.amount), bal = r.balance.trim() ? toPaise(r.balance) : null
      if (amt === null || amt <= 0 || (r.balance.trim() && bal === null)) { setMsg(t('Rakam sahi daalein')); return }
      lines.push({ date: r.date, direction: r.direction, amountPaise: amt, ref: r.ref.trim(), narration: r.narration.trim(), balancePaise: bal })
    }
    if (!lines.length) { setMsg(t('Rakam daalein')); return }
    setBusy(true); setMsg('')
    try {
      await api(`/v1/admin/shops/${shopId}/bank/lines`, { method: 'POST', body: { account: account.key, lines } })
      setRows([blankDraft()]); setOpen(false); onDone()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  if (!open) return <div><button type="button" className="btn ghost" onClick={() => setOpen(true)}>+ {t('Line haath se likhein')}</button></div>
  return (
    <div className="card wrap-x">
      <div className="hd"><h3>{t('Line haath se likhein')}</h3></div>
      <table className="tbl">
        <thead><tr><th>{t('Tarikh')}</th><th>{t('Aaya / Gaya')}</th><th>{t('Rakam')}</th><th>{t('Ref / UTR')}</th><th>{t('Narration')}</th><th>{t('Balance')}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input className="field" type="date" value={r.date} onChange={(e) => set(i, { date: e.target.value })} /></td>
              <td><select className="field" value={r.direction} onChange={(e) => set(i, { direction: e.target.value as 'cr' | 'dr' })}>
                <option value="cr">{t('Aaya (Credit)')}</option><option value="dr">{t('Gaya (Debit)')}</option></select></td>
              <td><input className="field" inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} /></td>
              <td><input className="field" value={r.ref} maxLength={60} onChange={(e) => set(i, { ref: e.target.value })} /></td>
              <td><input className="field" value={r.narration} maxLength={300} onChange={(e) => set(i, { narration: e.target.value })} /></td>
              <td><input className="field" inputMode="decimal" value={r.balance} onChange={(e) => set(i, { balance: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hd">
        <button type="button" className="btn ghost" onClick={() => setRows([...rows, { ...blankDraft(), date: rows[rows.length - 1].date }])}>+ {t('Aur line')}</button>
        {msg && <span className="error" style={{ margin: 0 }}>{msg}</span>}
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>{t('Rehne dein')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{t('Save')}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- milan (reconciliation)

function Milan({ shopId, account }: { shopId: string; account: Account }) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [tick, setTick] = useState(0)
  const [msg, setMsg] = useState('')
  const qs = `account=${encodeURIComponent(account.key)}${range.from ? `&from=${range.from}` : ''}${range.to ? `&to=${range.to}` : ''}`
  const { data, error, loading } = useLoad(() => api<Recon>(`/v1/admin/shops/${shopId}/bank/reconcile?${qs}`), [shopId, qs, tick])
  const act = async (path: 'match' | 'unmatch' | null, lineId: string, entryKey: string) => {
    setMsg('')
    try {
      if (path) await api(`/v1/admin/shops/${shopId}/bank/${path}`, { method: 'POST', body: { lineId, entryKey } })
      else await api(`/v1/admin/shops/${shopId}/bank/lines/${lineId}/void`, { method: 'POST' })
      setTick((n) => n + 1)
    } catch (e) { setMsg((e as Error).message) }
  }
  if (error) return <p className="error">{error}</p>
  if (!data) return <Skeleton />
  const lineCell = (l: Line) => (
    <td className="main-col"><b>{l.narration || l.ref || t('Bank line')}</b><small>{[shortDate(l.date), l.ref && `Ref ${l.ref}`, l.source === 'manual' && t('Haath se')].filter(Boolean).join(' · ')}</small></td>
  )
  const entryCell = (e: Entry) => (
    <td className="main-col"><b>{entryTitle(e)}</b><small>{[shortDate(e.date), e.party, e.note, e.ref && `Ref ${e.ref}`].filter(Boolean).join(' · ')}</small></td>
  )
  const money = (dir: 'cr' | 'dr', p: number) => <span className={`money ${dir === 'cr' ? 'jama' : 'due'}`}>{dir === 'cr' ? '+' : '−'}{rupees(p)}</span>
  const HOW: Record<Pair['how'], string> = { manual: t('Aapne joda'), ref: t('UTR / Ref se'), amount: t('Rakam + tarikh se') }
  return (
    <div className={`stack${loading ? ' dim' : ''}`}>
      <Range from={data.from} to={data.to} onChange={(from, to) => setRange({ from, to })} />
      <div className="card wrap-x">
        <table className="tbl">
          <thead><tr><th /><th className="num">{t('Bank statement')}</th><th className="num">{t('App ka hisab')}</th><th className="num">{t('Fark')}</th></tr></thead>
          <tbody>
            <tr><td><b>{t('Opening')}</b></td><td className="num money">{data.statement.openingPaise === null ? '—' : rupees(data.statement.openingPaise)}</td>
              <td className="num money">{rupees(data.app.openingPaise)}</td><td className="num money b">{signedText(data.difference.openingPaise)}</td></tr>
            <tr><td>{t('Aaya')}</td><td className="num money">{rupees(data.statement.inPaise)}</td><td className="num money">{rupees(data.app.inPaise)}</td>
              <td className="num money">{signedText(data.statement.inPaise - data.app.inPaise)}</td></tr>
            <tr><td>{t('Gaya')}</td><td className="num money">{rupees(data.statement.outPaise)}</td><td className="num money">{rupees(data.app.outPaise)}</td>
              <td className="num money">{signedText(data.statement.outPaise - data.app.outPaise)}</td></tr>
            <tr><td><b>{t('Closing')}</b></td><td className="num money">{data.statement.closingPaise === null ? '—' : rupees(data.statement.closingPaise)}</td>
              <td className="num money">{rupees(data.app.closingPaise)}</td><td className="num money b">{signedText(data.difference.closingPaise)}</td></tr>
          </tbody>
        </table>
        {data.statement.closingPaise === null && data.statement.lines > 0 && <p className="muted" style={{ padding: '0 16px 12px' }}>{t('Statement mein balance column nahi, isliye bank ka opening / closing nahi dikh sakta')}</p>}
      </div>
      {msg && <p className="error">{msg}</p>}

      <div className="card wrap-x">
        <div className="hd"><h3>{t('Bank mein hai, app mein nahi')} ({data.bankOnly.length})</h3></div>
        <table className="tbl"><tbody>
          {data.bankOnly.map((l) => {
            const options = data.appOnly.filter((e) => e.direction === l.direction)
            return (
              <tr key={l.id}>
                {lineCell(l)}
                <td className="num">{money(l.direction, l.amountPaise)}</td>
                <td>
                  {options.length > 0 && (
                    <select className="field" value="" aria-label={t('App entry se jodein')} onChange={(e) => e.target.value && void act('match', l.id, e.target.value)}>
                      <option value="">{t('App entry se jodein')}…</option>
                      {options.map((e) => <option key={e.key} value={e.key}>{shortDate(e.date)} · {entryTitle(e)} · {rupees(e.amountPaise)}{e.party ? ` · ${e.party}` : ''}</option>)}
                    </select>
                  )}
                  {l.source === 'manual' && <button type="button" className="btn ghost" onClick={() => void act(null, l.id, '')}>{t('Hatayein')}</button>}
                </td>
              </tr>
            )
          })}
        </tbody></table>
        {data.bankOnly.length === 0 && <p className="empty">{t('Kuch nahi')}</p>}
      </div>

      <div className="card wrap-x">
        <div className="hd"><h3>{t('App mein hai, bank mein nahi')} ({data.appOnly.length})</h3></div>
        <table className="tbl"><tbody>
          {data.appOnly.map((e) => <tr key={e.key}>{entryCell(e)}<td className="num">{money(e.direction, e.amountPaise)}</td></tr>)}
        </tbody></table>
        {data.appOnly.length === 0 && <p className="empty">{t('Kuch nahi')}</p>}
      </div>

      <div className="card wrap-x">
        <div className="hd"><h3>{t('Rakam mein fark')} ({data.amountDiffers.length})</h3></div>
        <table className="tbl"><tbody>
          {data.amountDiffers.map((p) => (
            <tr key={p.line.id}>{lineCell(p.line)}<td className="num">{money(p.line.direction, p.line.amountPaise)}</td>{entryCell(p.entry)}
              <td className="num">{money(p.entry.direction, p.entry.amountPaise)}<small>{t('Fark')} {signedText(p.diffPaise ?? 0)}</small></td>
              <td><button type="button" className="btn ghost" onClick={() => void act('unmatch', p.line.id, p.entry.key)}>{t('Alag karein')}</button></td></tr>
          ))}
        </tbody></table>
        {data.amountDiffers.length === 0 && <p className="empty">{t('Kuch nahi')}</p>}
      </div>

      <div className="card wrap-x">
        <div className="hd"><h3>{t('Mil gaye')} ({data.matched.length})</h3></div>
        <table className="tbl"><tbody>
          {data.matched.map((p) => (
            <tr key={p.line.id}>{lineCell(p.line)}{entryCell(p.entry)}<td className="num">{money(p.line.direction, p.line.amountPaise)}<small>{HOW[p.how]}</small></td>
              <td><button type="button" className="btn ghost" onClick={() => void act('unmatch', p.line.id, p.entry.key)}>{t('Alag karein')}</button></td></tr>
          ))}
        </tbody></table>
        {data.matched.length === 0 && <p className="empty">{t('Kuch nahi')}</p>}
      </div>
    </div>
  )
}
