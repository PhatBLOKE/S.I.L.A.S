import React, { useCallback, useEffect, useState } from 'react';

// PIP diary: a 30-second daily log, all tap targets, saved on this PC (backend/pip_diary.py).
// The full write-up lives in "Karl's PIP Diary" on claude.ai; COPY FOR DIARY bridges the two.
const API = '/api/pip';
export const PIP_DIARY_URL = 'https://claude.ai/artifact/UpFaqp1AoW2DLju7bK348V';

const ACTIVITIES = [
  ['food', 'Preparing food'], ['eating', 'Eating & drinking'], ['treatment', 'Treatments / meds'],
  ['washing', 'Washing & bathing'], ['toilet', 'Toilet needs'], ['dressing', 'Dressing'],
  ['communicating', 'Talking & understanding'], ['reading', 'Reading'], ['people', 'Mixing with people'],
  ['money', 'Money decisions'], ['journeys', 'Planning journeys'], ['moving', 'Moving around'],
];
const MOODS = [['very low', '😞'], ['low', '🙁'], ['ok', '😐'], ['good', '🙂'], ['great', '😄']];
const SLEEP = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const painTone = (n) => (n >= 8 ? 'bg-red-600 border-red-400 text-white' : n >= 5 ? 'bg-amber-600 border-amber-400 text-white' : 'bg-emerald-700 border-emerald-400 text-white');

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.detail) || `SILAS answered ${res.status}`);
  return data;
}

const Label = ({ children }) => <div className="font-mono text-[11px] tracking-[0.2em] text-slate-400 mb-2">{children}</div>;
const Chip = ({ on, onClick, className = '', children, label }) => (
  <button type="button" onClick={onClick} aria-pressed={on} aria-label={label}
    className={`min-w-[44px] min-h-[44px] px-3 rounded-md border-2 font-mono text-sm transition ${on ? className || 'bg-cyan-600 border-cyan-300 text-white' : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-400'}`}>
    {children}
  </button>
);

function PainRow({ title, value, onChange }) {
  return (
    <div>
      <Label>{title} {value !== null && value !== undefined ? `· ${value}/10` : ''}</Label>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 11 }, (_, n) => (
          <Chip key={n} on={value === n} onClick={() => onChange(value === n ? null : n)} className={painTone(n)} label={`${title} ${n}`}>{n}</Chip>
        ))}
      </div>
    </div>
  );
}

// Three states: not said / taken / missed
function MedTile({ label, value, onChange }) {
  const next = value === true ? false : value === false ? null : true;
  const look = value === true ? 'border-emerald-400 bg-emerald-950/50 text-emerald-200' : value === false ? 'border-red-400 bg-red-950/40 text-red-200' : 'border-slate-700 bg-slate-900 text-slate-400';
  return (
    <button type="button" onClick={() => onChange(next)} className={`rounded-lg border-2 p-3 text-left min-h-[70px] ${look}`}>
      <div className="font-mono text-[11px] tracking-widest">{label}</div>
      <div className="font-display text-lg">{value === true ? '✓ TAKEN' : value === false ? '✗ MISSED' : 'TAP TO SET'}</div>
    </button>
  );
}

const blank = () => ({
  date: todayKey(), sleep_hours: null, back_pain: null, leg_pain: null, mood: null,
  meds_morning: null, meds_evening: null, booster: null, struggles: [], note: '',
});

export function PipLog({ entry, onClose, onSaved }) {
  const [f, setF] = useState(entry ? { ...blank(), ...entry } : blank());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [armed, setArmed] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k) => setF((x) => ({ ...x, struggles: x.struggles.includes(k) ? x.struggles.filter((s) => s !== k) : [...x.struggles, k] }));

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...f };
      delete body.id; delete body.saved_at; delete body.edited_at;
      if (entry?.id) await api(`/entries/${entry.id}`, { method: 'PUT', body });
      else await api('/entries', { method: 'POST', body });
      onSaved(entry?.id ? 'Diary entry updated' : 'Logged. That counts.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!armed) { setArmed(true); return; }
    try { await api(`/entries/${entry.id}`, { method: 'DELETE' }); onSaved('Entry deleted'); } catch (e) { setErr(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="max-w-3xl mx-auto my-6 px-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="hud-panel border-2 border-violet-500/60 p-5 space-y-5" role="dialog" aria-modal="true" aria-labelledby="pip-h">
          <div className="flex items-center justify-between gap-3">
            <div id="pip-h" className="font-display text-2xl tracking-wider text-violet-300">♥ PIP DIARY · {entry?.id ? 'EDIT' : (f.date === todayKey() ? 'LOG TODAY' : 'LOG A DAY')}</div>
            <button type="button" onClick={onClose} className="hud-btn !text-[12px]">✕ CLOSE</button>
          </div>
          <div className="font-mono text-[12px] text-slate-400">Tap what applies. Skip anything you don't know, it all helps.</div>

          <div className="flex items-center gap-3">
            <Label>DAY</Label>
            <input id="pip-date" type="date" value={f.date} onChange={(e) => set('date')(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-100 [color-scheme:dark] -mt-2" />
          </div>

          <div>
            <Label>SLEEP LAST NIGHT {f.sleep_hours ? `· ${f.sleep_hours}${f.sleep_hours === 9 ? '+' : ''} H` : ''}</Label>
            <div className="flex flex-wrap gap-1.5">
              {SLEEP.map((h) => <Chip key={h} on={f.sleep_hours === h} onClick={() => set('sleep_hours')(f.sleep_hours === h ? null : h)} label={`${h} hours sleep`}>{h}{h === 9 ? '+' : ''}h</Chip>)}
            </div>
          </div>

          <PainRow title="BACK PAIN" value={f.back_pain} onChange={set('back_pain')} />
          <PainRow title="LEG PAIN" value={f.leg_pain} onChange={set('leg_pain')} />

          <div>
            <Label>MOOD</Label>
            <div className="flex flex-wrap gap-1.5">
              {MOODS.map(([m, e]) => <Chip key={m} on={f.mood === m} onClick={() => set('mood')(f.mood === m ? null : m)} label={`Mood ${m}`}>{e} {m}</Chip>)}
            </div>
          </div>

          <div>
            <Label>MEDS</Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <MedTile label="MORNING · 6AM" value={f.meds_morning} onChange={set('meds_morning')} />
              <MedTile label="AFTERNOON BOOSTER" value={f.booster} onChange={set('booster')} />
              <MedTile label="EVENING · 8PM" value={f.meds_evening} onChange={set('meds_evening')} />
            </div>
          </div>

          <div>
            <Label>STRUGGLED WITH TODAY</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {ACTIVITIES.map(([k, l]) => (
                <Chip key={k} on={f.struggles.includes(k)} onClick={() => toggle(k)} className="bg-violet-700 border-violet-300 text-white">
                  <span className="block text-left text-[12px] leading-tight py-1">{l}</span>
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>WHAT HAPPENED (OPTIONAL)</Label>
            <textarea id="pip-note" rows={4} value={f.note} onChange={(e) => set('note')(e.target.value)}
              placeholder="e.g. couldn't stand long enough to cook, had to sit down twice in the shower"
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 text-sm focus:border-violet-400 outline-none" />
          </div>

          {err && <div className="font-mono text-[12px] text-amber-300">{err}</div>}
          <div className="flex flex-wrap justify-between gap-2">
            <div>{entry?.id && (
              <button type="button" onClick={del} className={`hud-btn !text-[11px] ${armed ? '!bg-red-600 !text-white' : 'text-red-300'}`}>{armed ? 'CLICK AGAIN TO DELETE' : 'DELETE ENTRY'}</button>
            )}</div>
            <button type="button" onClick={save} disabled={busy} className="hud-btn hud-btn-primary !text-[13px] !px-6 !py-2.5">{busy ? 'SAVING…' : '✓ SAVE TO DIARY'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Wide tile for the TODAY tab: status, last 7 days as mini tiles, and the three actions.
export function PipTile({ onToast }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // null | 'new' | entry
  const [copyText, setCopyText] = useState('');

  const load = useCallback(async () => {
    try { setData(await api('/entries?days=14')); } catch (e) { setData({ error: e.message, entries: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const copy = async () => {
    try {
      const r = await api('/export?days=7');
      try { await navigator.clipboard.writeText(r.text); onToast && onToast('Last 7 days copied. Paste it into your PIP diary.'); }
      catch (e) { setCopyText(r.text); }
    } catch (e) { onToast && onToast(e.message); }
  };

  const hour = new Date().getHours();
  const nudge = data && !data.logged_today && hour >= 17;
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    last7.push({ key, label: d.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(), entry: (data?.entries || []).find((e) => e.date === key) });
  }

  return (
    <div className={`rounded-lg border-2 ${nudge ? 'border-violet-400 shadow-[0_0_24px_rgba(167,139,250,0.25)]' : 'border-violet-600/60'} bg-violet-950/20 p-4 space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
        <span className="text-[11px] tracking-[0.2em] font-bold text-violet-300">♥ PIP DIARY</span>
        <span className="text-[11px] text-slate-400">
          {data?.error ? data.error : data ? (data.logged_today ? '✓ Logged today' : 'Not logged today') + (data.streak ? ` · ${data.streak}-day streak` : '') : 'Loading…'}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {last7.map((d) => (
          <button key={d.key} type="button" onClick={() => setOpen(d.entry || { ...blank(), date: d.key })}
            className={`rounded-md border p-1.5 min-h-[58px] text-center font-mono ${d.entry ? 'border-violet-500/70 bg-violet-900/30' : 'border-slate-800 bg-slate-900/60 hover:border-slate-600'}`}
            aria-label={d.entry ? `Edit ${d.key}` : `Log ${d.key}`}>
            <div className="text-[9px] tracking-widest text-slate-400">{d.label}</div>
            {d.entry ? (
              <div className="text-[11px] text-violet-100 leading-tight mt-0.5">
                {d.entry.back_pain ?? '–'}/{d.entry.leg_pain ?? '–'}<div className="text-[9px] text-slate-400">{d.entry.sleep_hours ? `${d.entry.sleep_hours}h` : ''}</div>
              </div>
            ) : <div className="text-slate-600 text-lg leading-none mt-1">+</div>}
          </button>
        ))}
      </div>
      <div className="font-mono text-[10px] text-slate-500">Day tiles show back / leg pain and sleep. Tap one to fill in or fix it.</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setOpen('new')} className="hud-btn !border-violet-400 !text-violet-100 !text-[12px]">{data?.logged_today ? '+ ADD ANOTHER NOTE' : '♥ LOG TODAY'}</button>
        <button type="button" onClick={copy} className="hud-btn !text-[12px]">⧉ COPY LAST 7 DAYS</button>
        <a href={PIP_DIARY_URL} target="_blank" rel="noreferrer" className="hud-btn !text-[12px]">OPEN DIARY DOC ↗</a>
      </div>
      {copyText && (
        <div className="space-y-1">
          <div className="font-mono text-[11px] text-amber-300">Couldn't copy automatically. Select this and copy it:</div>
          <textarea id="pip-copy" readOnly rows={6} value={copyText} onFocus={(e) => e.target.select()}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-[12px] text-slate-200" />
        </div>
      )}
      {open && (
        <PipLog entry={open === 'new' ? null : open} onClose={() => setOpen(null)}
          onSaved={(m) => { setOpen(null); onToast && onToast(m); load(); }} />
      )}
    </div>
  );
}
