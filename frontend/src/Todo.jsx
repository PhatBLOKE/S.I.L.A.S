import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PipTile } from './Pip';

// TODAY tab + Mission Control focus strip. Todoist is the master copy; SILAS talks to it
// through backend/todoist.py (the token never reaches the browser).
const API = '/api/todoist';

const SECTION_HINTS = {
  now: 'ONE project only. Block 1, 07:00–09:30.',
  next: 'Moves up when Now hits its finish line.',
  money: 'Block 2, 10:00–12:00. Things that could earn something.',
  parked: 'Not dropped, not live. Promote at the Sunday review.',
  'idea inbox': 'One line per idea, then straight back to work.',
};
const hintFor = (name) => {
  const n = (name || '').toLowerCase();
  const k = Object.keys(SECTION_HINTS).find((h) => n.startsWith(h));
  return k ? SECTION_HINTS[k] : '';
};
const isNowSection = (name) => (name || '').toLowerCase().startsWith('now');

const PRIO = {
  p1: { label: 'P1 · urgent', bar: 'border-l-red-500', dot: 'text-red-400' },
  p2: { label: 'P2 · high', bar: 'border-l-amber-500', dot: 'text-amber-300' },
  p3: { label: 'P3 · medium', bar: 'border-l-sky-500', dot: 'text-sky-300' },
  p4: { label: 'P4 · none', bar: 'border-l-slate-700', dot: 'text-slate-500' },
};

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dueInfo = (t) => {
  const d = t?.due?.date;
  if (!d) return null;
  const key = d.slice(0, 10);
  const time = d.length > 10 ? d.slice(11, 16) : '';
  const tk = todayKey();
  const cls = key < tk ? 'text-red-400' : key === tk ? 'text-emerald-300' : 'text-slate-400';
  const label = key === tk ? 'Today' : new Date(`${key}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return { key, time, cls, text: `${label}${time ? ` ${time}` : ''}` };
};
const byDue = (a, b) => (a.due?.date || '9').localeCompare(b.due?.date || '9');

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.detail) || `SILAS answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ token setup
function TokenSetup({ onSaved, compact }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = async (e) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true); setMsg('');
    try {
      const r = await api('/config', { method: 'POST', body: { api_token: token.trim() } });
      setToken('');
      setMsg(`Linked. Found ${r.projects} Todoist projects.`);
      onSaved && onSaved();
    } catch (err) {
      setMsg(err.message);
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className={`hud-panel p-5 font-mono space-y-3 ${compact ? '' : 'max-w-2xl'}`}>
      <div className="text-cyan-300 font-bold tracking-wider text-sm">LINK TODOIST</div>
      <ol className="text-[12px] text-slate-300 list-decimal ml-5 space-y-1">
        <li>Open Todoist → <b>Settings → Integrations → Developer</b>.</li>
        <li>Copy the <b>API token</b> and paste it below.</li>
      </ol>
      <div className="text-[11px] text-slate-500">It's saved in SILAS's config.json on this PC only, and is never shown in full again.</div>
      <div className="flex gap-2">
        <input
          id="todoist-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste your Todoist API token"
          className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-cyan-100 focus:border-cyan-400 outline-none"
        />
        <button type="submit" disabled={busy} className="hud-btn hud-btn-primary">{busy ? 'CHECKING…' : 'LINK'}</button>
      </div>
      {msg && <div className="text-[12px] text-amber-300">{msg}</div>}
    </form>
  );
}


// ------------------------------------------------------------------ tile look
// Everything in this tab is a tile: one glance = one thing. No rows of text to scan.
const LANES = [
  { key: 'now', label: 'NOW', icon: '◉', tone: 'fuchsia' },
  { key: 'next', label: 'NEXT', icon: '▸', tone: 'cyan' },
  { key: 'money', label: 'MONEY', icon: '£', tone: 'emerald' },
  { key: 'admin', label: 'ADMIN', icon: '✎', tone: 'amber' },
  { key: 'parked', label: 'PARKED', icon: '⏸', tone: 'slate' },
  { key: 'idea inbox', label: 'IDEAS', icon: '💡', tone: 'yellow' },
];
const laneFor = (name) => {
  const n = (name || '').toLowerCase();
  return LANES.find((l) => n.startsWith(l.key)) || { key: n, label: (name || 'TASKS').toUpperCase(), icon: '◆', tone: 'sky' };
};
const PROJECT_ICONS = { 'daily routine': '⏱', inbox: '📥', projects: '🗂' };
const projIcon = (p) => PROJECT_ICONS[(p.inbox ? 'inbox' : p.name).toLowerCase()] || '◆';

// Full class strings so Tailwind's CDN picks them up.
const TONE = {
  fuchsia: { ring: 'border-fuchsia-500/70 hover:border-fuchsia-400', glow: 'shadow-[0_0_24px_rgba(217,70,239,0.18)]', text: 'text-fuchsia-300', bg: 'bg-fuchsia-950/30', bar: 'bg-fuchsia-500' },
  cyan: { ring: 'border-cyan-600/60 hover:border-cyan-400', glow: 'shadow-[0_0_24px_rgba(34,211,238,0.15)]', text: 'text-cyan-300', bg: 'bg-cyan-950/30', bar: 'bg-cyan-400' },
  emerald: { ring: 'border-emerald-600/60 hover:border-emerald-400', glow: 'shadow-[0_0_24px_rgba(16,185,129,0.15)]', text: 'text-emerald-300', bg: 'bg-emerald-950/30', bar: 'bg-emerald-400' },
  amber: { ring: 'border-amber-600/60 hover:border-amber-400', glow: 'shadow-[0_0_24px_rgba(245,158,11,0.15)]', text: 'text-amber-300', bg: 'bg-amber-950/30', bar: 'bg-amber-400' },
  slate: { ring: 'border-slate-600/60 hover:border-slate-400', glow: '', text: 'text-slate-300', bg: 'bg-slate-900/50', bar: 'bg-slate-400' },
  yellow: { ring: 'border-yellow-600/60 hover:border-yellow-400', glow: 'shadow-[0_0_24px_rgba(234,179,8,0.12)]', text: 'text-yellow-300', bg: 'bg-yellow-950/20', bar: 'bg-yellow-400' },
  sky: { ring: 'border-sky-700/60 hover:border-sky-400', glow: '', text: 'text-sky-300', bg: 'bg-sky-950/30', bar: 'bg-sky-400' },
  red: { ring: 'border-red-600/70 hover:border-red-400', glow: 'shadow-[0_0_24px_rgba(239,68,68,0.18)]', text: 'text-red-300', bg: 'bg-red-950/30', bar: 'bg-red-500' },
};
const PRIO_TOP = { p1: 'bg-red-500', p2: 'bg-amber-500', p3: 'bg-sky-500', p4: 'bg-slate-700' };

function Tile({ tone = 'sky', className = '', onClick, children, drop, label, ...rest }) {
  const t = TONE[tone] || TONE.sky;
  // A div (not a <button>) so tiles can hold draggable bits and their own buttons.
  const clickable = onClick ? {
    role: 'button', tabIndex: 0, onClick,
    onKeyDown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onClick(e); } },
  } : {};
  return (
    <div
      aria-label={label}
      data-tone={tone}
      {...clickable}
      className={`silas-tile relative text-left rounded-lg border-2 ${t.ring} ${t.bg} ${t.glow} p-4 flex flex-col gap-2 min-w-0 min-h-[140px] transition ${onClick ? 'cursor-pointer' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${drop ? '!border-cyan-300 scale-[1.02]' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
const TileHead = ({ tone, icon, label, right }) => (
  <div className="flex items-center justify-between gap-2 font-mono">
    <span className={`silas-tilehead text-[11px] tracking-[0.2em] font-bold ${TONE[tone]?.text || ''}`}>{icon} {label}</span>
    {right !== undefined && <span className="text-[11px] text-slate-400 tabular-nums">{right}</span>}
  </div>
);
const Big = ({ children, dim }) => (
  <div className={`font-display text-[17px] leading-snug break-words line-clamp-3 ${dim ? 'text-slate-500' : 'text-white'}`}>{children}</div>
);

const parseLocal = (d) => (d && d.length > 10 ? new Date(d.slice(0, 19)) : null);
const hhmm = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '');

// ------------------------------------------------------------------ focus tiles (Mission Control)
export function FocusStrip({ onOpen, compact }) {
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { setF(await api('/focus')); setErr(''); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (!f && !err) return null;
  if (f && f.configured === false) {
    return (
      <Tile tone="slate" onClick={onOpen} className="!min-h-0">
        <TileHead tone="slate" icon="✅" label="TODAY" />
        <div className="text-slate-300 text-sm">Link Todoist to see your Now project here. Tap to set up.</div>
      </Tile>
    );
  }
  const hour = new Date().getHours();
  return (
    <div className={`grid grid-cols-2 ${compact ? 'h-full auto-rows-fr' : 'lg:grid-cols-4'} gap-3`}>
      <Tile tone="fuchsia" onClick={onOpen} className="col-span-2 !min-h-[110px]" label="Open today">
        <TileHead tone="fuchsia" icon="◉" label="NOW PROJECT" right={f?.now?.length > 1 ? `⚠ ${f.now.length} in Now` : undefined} />
        <Big dim={!f?.now?.length}>{f?.now?.[0]?.content || 'Nothing in Now. Pick one.'}</Big>
      </Tile>
      <Tile tone="cyan" onClick={onOpen} className="!min-h-[110px]">
        <TileHead tone="cyan" icon="⏱" label="BLOCK" />
        <div className="text-cyan-100 text-sm line-clamp-3">{f?.current_block?.content || 'Quiet start'}</div>
      </Tile>
      {hour >= 11 && hour < 14 ? (
        <Tile tone="emerald" className="!min-h-[110px]">
          <TileHead tone="emerald" icon="🍽" label="FUEL" />
          <div className="text-emerald-100 text-sm">Eat something around midday.</div>
        </Tile>
      ) : f?.overdue_count ? (
        <Tile tone="red" onClick={onOpen} className="!min-h-[110px]">
          <TileHead tone="red" icon="!" label="OVERDUE" />
          <div className="font-display text-3xl text-red-200 tabular-nums">{f.overdue_count}</div>
        </Tile>
      ) : (
        <Tile tone="slate" onClick={onOpen} className="!min-h-[110px]">
          <TileHead tone="slate" icon="▸" label={`NEXT${f?.next_block?.due?.date ? ' · ' + f.next_block.due.date.slice(11, 16) : ''}`} />
          <div className="text-slate-200 text-sm line-clamp-3">{f?.next_block?.content || err || 'Nothing else timed today'}</div>
        </Tile>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ edit dialog
function EditDialog({ task, sections, onClose, onSave, onDone, onDelete }) {
  const d = dueInfo(task);
  const [content, setContent] = useState(task.content);
  const [description, setDescription] = useState(task.description || '');
  const [priority, setPriority] = useState(task.priority || 'p4');
  const [date, setDate] = useState(d ? d.key : '');
  const [dueString, setDueString] = useState('');
  const curSec = task.section_id && sections.some((s) => s.id === task.section_id) ? task.section_id : '';
  const [section, setSection] = useState(curSec);
  const [armed, setArmed] = useState(false);
  const titleRef = useRef(null);
  useEffect(() => { titleRef.current && titleRef.current.focus(); }, []);

  const submit = (e) => {
    e.preventDefault();
    const up = {};
    if (content.trim() && content.trim() !== task.content) up.content = content.trim();
    if (description !== (task.description || '')) up.description = description;
    if (priority !== (task.priority || 'p4')) up.priority = priority;
    if (dueString.trim()) up.due_string = dueString.trim();
    else if (date && (!d || date !== d.key)) up.date = date;
    onSave(task, up, section !== curSec ? section : null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form onSubmit={submit} className="hud-panel hud-panel-glow w-full max-w-xl mt-[6vh] p-5 space-y-3 font-mono" role="dialog" aria-modal="true" aria-labelledby="td-edit-h">
        <div id="td-edit-h" className="text-cyan-300 font-bold tracking-wider">EDIT TASK</div>
        <label className="block text-[11px] text-slate-400 tracking-wider">TASK
          <input id="td-title" ref={titleRef} value={content} onChange={(e) => setContent(e.target.value)}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 font-sans text-sm focus:border-cyan-400 outline-none" />
        </label>
        <label className="block text-[11px] text-slate-400 tracking-wider">NOTES
          <textarea id="td-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 font-sans text-sm focus:border-cyan-400 outline-none" />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-[11px] text-slate-400 tracking-wider">PRIORITY
            <select id="td-prio" value={priority} onChange={(e) => setPriority(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-slate-100">
              {Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          {sections.length > 0 && (
            <label className="block text-[11px] text-slate-400 tracking-wider">COLUMN
              <select id="td-sec" value={section} onChange={(e) => setSection(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-slate-100">
                <option value="">No section</option>
                {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label className="block text-[11px] text-slate-400 tracking-wider">MOVE TO DATE
            <input id="td-date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-slate-100 [color-scheme:dark]" />
            <span className="block mt-1 text-[10px] text-slate-500 normal-case tracking-normal">
              {task.due?.is_recurring ? `Keeps the repeat (${task.due.string}).` : 'Keeps any set time.'}
            </span>
          </label>
          <label className="block text-[11px] text-slate-400 tracking-wider">OR TYPE A DUE DATE
            <input id="td-due" value={dueString} onChange={(e) => setDueString(e.target.value)}
              placeholder={task.due?.is_recurring ? 'replaces the repeat' : 'friday 10am, every monday'}
              className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-2 text-slate-100" />
            <span className="block mt-1 text-[10px] text-slate-500 normal-case tracking-normal">Type “none” to clear the date.</span>
          </label>
        </div>
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <div className="flex gap-2">
            <button type="button" onClick={() => (armed ? onDelete(task) : setArmed(true))}
              className={`hud-btn !text-[11px] ${armed ? '!bg-red-600 !text-white !border-red-500' : 'text-red-300 border-red-900'}`}>
              {armed ? 'CLICK AGAIN TO DELETE' : 'DELETE'}
            </button>
            <button type="button" onClick={() => onDone(task)} className="hud-btn !text-[11px] text-emerald-300">MARK DONE</button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="hud-btn !text-[11px]">CANCEL</button>
            <button type="submit" className="hud-btn hud-btn-primary !text-[11px]">SAVE</button>
          </div>
        </div>
      </form>
    </div>
  );
}


// ------------------------------------------------------------------ one task = one tile
function TaskTile({ t, onDone, onEdit, onDragStart, onDragEnd, dropHere, sub }) {
  const d = dueInfo(t);
  return (
    <div
      draggable
      onDragStart={(e) => { try { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} onDragStart(t.id); }}
      onDragEnd={onDragEnd}
      data-task={t.id}
      className={`relative rounded-lg border border-slate-700 bg-slate-900/90 hover:border-slate-400 overflow-hidden flex flex-col min-h-[150px] cursor-grab ${dropHere ? 'ring-2 ring-cyan-300' : ''}`}
    >
      <div className={`h-1.5 ${PRIO_TOP[t.priority] || PRIO_TOP.p4}`} />
      <button type="button" onClick={() => onEdit(t)} className="flex-1 text-left p-3 flex flex-col gap-2 min-w-0" aria-label={`Edit ${t.content}`}>
        {sub && <span className="font-mono text-[10px] tracking-widest text-slate-500 truncate">{sub}</span>}
        <span className="text-[15px] leading-snug text-slate-100 break-words line-clamp-4">{t.content}</span>
        <span className="mt-auto flex flex-wrap gap-1.5 font-mono text-[10px]">
          {d && <span className={`px-1.5 py-0.5 rounded bg-slate-800 ${d.cls}`}>{d.text}</span>}
          {t.due?.is_recurring && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">↻</span>}
          {t.description && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">✎</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDone(t)}
        aria-label={`Mark ${t.content} done`}
        className="m-3 mt-0 self-start flex items-center gap-2 px-3 py-1.5 rounded-md border border-emerald-700 text-emerald-300 font-mono text-[11px] tracking-wider hover:bg-emerald-500/20"
      >
        ✓ DONE
      </button>
    </div>
  );
}

function AddTile({ label, onAdd, tone = 'slate' }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (open && ref.current) ref.current.focus(); }, [open]);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="silas-addtile rounded-lg border-2 border-dashed border-slate-700 hover:border-cyan-500 text-slate-500 hover:text-cyan-300 min-h-[150px] flex flex-col items-center justify-center gap-1 font-mono">
        <span className="text-3xl leading-none">+</span>
        <span className="text-[11px] tracking-widest">{label}</span>
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}
      className={`rounded-lg border-2 ${TONE[tone]?.ring || ''} bg-slate-900 min-h-[150px] p-3 flex flex-col gap-2`}
    >
      <span className="font-mono text-[10px] tracking-widest text-slate-400">{label}</span>
      <textarea ref={ref} rows={3} value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } if (e.key === 'Escape') setOpen(false); }}
        placeholder="Type it, press Enter"
        aria-label={label}
        className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100 focus:border-cyan-400 outline-none resize-none" />
      <div className="flex gap-2">
        <button type="submit" className="hud-btn hud-btn-primary !text-[11px] !py-1 flex-1">ADD</button>
        <button type="button" onClick={() => setOpen(false)} className="hud-btn !text-[11px] !py-1">✕</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ drawer: one lane / project, as tiles
function Drawer({ title, icon, tone, groups, laneTargets, onClose, onDone, onEdit, onAdd, onMove, onReorder, note }) {
  const [dragId, setDragId] = useState(null);
  const [overTask, setOverTask] = useState(null);
  const [overLane, setOverLane] = useState(null);
  const end = () => { setDragId(null); setOverTask(null); setOverLane(null); };
  const all = groups.flatMap((g) => g.tasks);
  return (
    <div className="fixed inset-0 z-40 bg-black/75 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="max-w-6xl mx-auto my-6 px-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className={`hud-panel border-2 ${TONE[tone]?.ring || ''} p-4 sm:p-5 space-y-4`} role="dialog" aria-modal="true" aria-label={title}>
          <div className="flex items-center justify-between gap-3">
            <div className={`font-display text-2xl tracking-wider ${TONE[tone]?.text || 'text-white'}`}>{icon} {title}</div>
            <button type="button" onClick={onClose} className="hud-btn !text-[12px]">✕ CLOSE</button>
          </div>
          {note && <div className="font-mono text-[12px] text-slate-400">{note}</div>}

          {laneTargets && laneTargets.length > 0 && (
            <div className="space-y-1.5">
              <div className="font-mono text-[10px] tracking-[0.2em] text-slate-500">DRAG A TILE HERE TO MOVE IT</div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {laneTargets.map((l) => (
                  <div key={l.id}
                    onDragOver={(e) => { if (!dragId) return; e.preventDefault(); setOverLane(l.id); }}
                    onDragLeave={() => setOverLane(null)}
                    onDrop={(e) => { e.preventDefault(); const id = dragId; end(); onMove(id, l.id); }}
                    className={`rounded-md border-2 border-dashed px-2 py-3 text-center font-mono text-[11px] tracking-wider ${overLane === l.id ? `${TONE[l.tone]?.ring} ${TONE[l.tone]?.text} bg-slate-800` : 'border-slate-700 text-slate-400'}`}>
                    {l.icon} {l.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {groups.map((g) => (
            <div key={g.id || 'none'} className="space-y-2">
              {groups.length > 1 && (
                <div className={`font-mono text-[11px] tracking-[0.2em] ${TONE[g.tone]?.text || 'text-slate-400'}`}>{g.icon} {g.label} · {g.tasks.length}</div>
              )}
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}
                onDragOver={(e) => { if (!dragId) return; e.preventDefault(); const c = e.target.closest('[data-task]'); setOverTask(c && c.dataset.task !== dragId ? c.dataset.task : null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = dragId; const before = overTask; end();
                  if (!id) return;
                  const src = all.find((x) => x.id === id);
                  const sameGroup = g.tasks.some((x) => x.id === id);
                  const list = g.tasks.filter((x) => x.id !== id);
                  let idx = before ? list.findIndex((x) => x.id === before) : list.length;
                  if (idx < 0) idx = list.length;
                  list.splice(idx, 0, src);
                  onReorder(id, g.id, list.map((x) => x.id), !sameGroup);
                }}>
                {g.tasks.map((t) => (
                  <TaskTile key={t.id} t={t} sub={g.subFor ? g.subFor(t) : ''} onDone={onDone} onEdit={onEdit}
                    onDragStart={setDragId} onDragEnd={end} dropHere={dragId && overTask === t.id} />
                ))}
                {onAdd && g.canAdd !== false && <AddTile label={`ADD TO ${g.label}`} tone={g.tone} onAdd={(v) => onAdd(v, g.id)} />}
              </div>
              {!g.tasks.length && (!onAdd || g.canAdd === false) && <div className="font-mono text-[12px] text-slate-500">Nothing here.</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ main tab
export default function TodoBoard() {
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [focus, setFocus] = useState(null);
  const [lanes, setLanes] = useState(null);      // board of the "Projects" project
  const [today, setToday] = useState([]);
  const [other, setOther] = useState({});         // project_id -> board, loaded when opened
  const [open, setOpen] = useState(null);          // {kind:'lane'|'project'|'today', id}
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [overLane, setOverLane] = useState(null);
  const [now, setNow] = useState(new Date());

  const say = (m) => { setToast(m); clearTimeout(say.t); say.t = setTimeout(() => setToast(''), 2200); };

  const lanesProject = projects.find((p) => p.name.trim().toLowerCase() === 'projects');

  const loadStatus = useCallback(async () => {
    try { setStatus(await api('/status')); } catch (e) { setError(e.message); }
  }, []);

  const refresh = useCallback(async (fresh) => {
    setBusy(true);
    try {
      const p = await api(`/projects${fresh ? '?fresh=1' : ''}`);
      setProjects(p);
      const lp = p.find((x) => x.name.trim().toLowerCase() === 'projects');
      const [f, t, b] = await Promise.all([
        api('/focus?fresh=1'),
        api('/today'),
        lp ? api(`/board/${lp.id}`) : Promise.resolve(null),
      ]);
      setFocus(f); setToday(t); setLanes(b);
      setError(''); setSynced(new Date());
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);

  const loadProject = useCallback(async (pid) => {
    try { const b = await api(`/board/${pid}`); setOther((o) => ({ ...o, [pid]: b })); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { if (status?.configured) refresh(false); }, [status?.configured, refresh]);
  useEffect(() => {
    const c = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(c);
  }, []);
  useEffect(() => {
    if (!status?.configured) return;
    const t = setInterval(() => { if (!editing && !dragId) refresh(false); }, 90000);
    return () => clearInterval(t);
  }, [status?.configured, editing, dragId, refresh]);

  const afterChange = async () => {
    await refresh(false);
    if (open?.kind === 'project') loadProject(open.id);
  };
  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) say(okMsg); setError(''); }
    catch (e) { setError(e.message); }
    afterChange();
  };

  // optimistic removal everywhere
  const dropLocal = (id) => {
    setToday((ts) => ts.filter((x) => x.id !== id));
    setLanes((b) => (b ? { ...b, tasks: b.tasks.filter((x) => x.id !== id) } : b));
    setOther((o) => Object.fromEntries(Object.entries(o).map(([k, b]) => [k, { ...b, tasks: b.tasks.filter((x) => x.id !== id) }])));
    setFocus((f) => (f ? { ...f, now: (f.now || []).filter((x) => x.id !== id) } : f));
  };
  const complete = (t) => {
    setEditing(null); dropLocal(t.id);
    act(() => api(`/tasks/${t.id}/close`, { method: 'POST' }), t.due?.is_recurring ? 'Done. Next one is scheduled.' : 'Nice. Done.');
  };
  const remove = (t) => {
    setEditing(null); dropLocal(t.id);
    act(() => api(`/tasks/${t.id}`, { method: 'DELETE' }), 'Deleted');
  };
  const save = (t, up, newSection) => {
    setEditing(null);
    act(async () => {
      if (Object.keys(up).length) await api(`/tasks/${t.id}`, { method: 'POST', body: up });
      if (newSection !== null) {
        await api(`/tasks/${t.id}/move`, { method: 'POST', body: newSection ? { section_id: newSection } : { project_id: t.project_id } });
      }
    }, 'Saved');
  };
  const addTask = (content, { projectId, sectionId, dueString }) => act(() => api('/tasks', {
    method: 'POST', body: { content, project_id: projectId, section_id: sectionId || undefined, due_string: dueString },
  }), 'Added');
  const moveToSection = (id, sectionId, projectId) => act(() => api(`/tasks/${id}/move`, {
    method: 'POST', body: sectionId ? { section_id: sectionId } : { project_id: projectId },
  }), 'Moved');
  const reorder = (id, sectionId, ids, moved, projectId) => act(async () => {
    if (moved) await api(`/tasks/${id}/move`, { method: 'POST', body: sectionId ? { section_id: sectionId } : { project_id: projectId } });
    if (ids.length > 1) await api('/reorder', { method: 'POST', body: { ids } });
  }, moved ? 'Moved' : 'Sorted');

  if (!status) return <div className="font-mono text-slate-500 text-sm p-4">Checking Todoist link…</div>;
  if (!status.configured) return <TokenSetup onSaved={loadStatus} />;

  // ---- derived
  const laneSections = lanes ? lanes.sections : [];
  const tasksIn = (sid) => (lanes ? lanes.tasks.filter((t) => t.section_id === sid) : []);
  const laneInfo = laneSections.map((s) => ({ ...s, lane: laneFor(s.name), tasks: tasksIn(s.id) }));
  const nowLane = laneInfo.find((l) => l.lane.key === 'now');
  const ideaLane = laneInfo.find((l) => l.lane.key === 'idea inbox');
  const otherLanes = laneInfo.filter((l) => l.lane.key !== 'now');
  const otherProjects = projects.filter((p) => !lanesProject || p.id !== lanesProject.id);
  const tk = todayKey();
  const overdue = today.filter((t) => t.due?.date && t.due.date.slice(0, 10) < tk);
  const projName = (id) => { const p = projects.find((x) => x.id === id); return p ? (p.inbox ? 'Inbox' : p.name) : ''; };

  const cur = focus?.current_block; const nxt = focus?.next_block;
  const curStart = parseLocal(cur?.due?.date); const nxtStart = parseLocal(nxt?.due?.date);
  let pct = null; let left = '';
  if (curStart && nxtStart && nxtStart > curStart) {
    pct = Math.max(0, Math.min(100, ((now - curStart) / (nxtStart - curStart)) * 100));
    const mins = Math.max(0, Math.round((nxtStart - now) / 60000));
    left = mins >= 60 ? `${Math.floor(mins / 60)}h ${pad(mins % 60)}m left` : `${mins}m left`;
  }
  const hour = now.getHours();
  const nowTask = nowLane?.tasks?.[0] || focus?.now?.[0];

  const laneTargets = laneInfo.map((l) => ({ id: l.id, label: l.lane.label, icon: l.lane.icon, tone: l.lane.tone }));

  // ---- drawer content
  let drawer = null;
  if (open?.kind === 'lane') {
    const l = laneInfo.find((x) => x.id === open.id);
    if (l) {
      drawer = (
        <Drawer title={l.lane.label} icon={l.lane.icon} tone={l.lane.tone} note={hintFor(l.name)}
          groups={[{ id: l.id, label: l.lane.label, icon: l.lane.icon, tone: l.lane.tone, tasks: l.tasks }]}
          laneTargets={laneTargets.filter((x) => x.id !== l.id)}
          onClose={() => setOpen(null)} onDone={complete} onEdit={setEditing}
          onAdd={(v, sid) => addTask(v, { projectId: lanesProject?.id, sectionId: sid })}
          onMove={(id, sid) => moveToSection(id, sid)}
          onReorder={(id, sid, ids, moved) => reorder(id, sid, ids, moved, lanesProject?.id)} />
      );
    }
  } else if (open?.kind === 'project') {
    const p = projects.find((x) => x.id === open.id);
    const b = other[open.id];
    if (p) {
      const isRoutine = p.name.toLowerCase() === 'daily routine';
      const secs = b ? b.sections : [];
      const groups = [];
      if (b) {
        const loose = b.tasks.filter((t) => !t.section_id || !secs.some((s) => s.id === t.section_id));
        if (loose.length || !secs.length) groups.push({ id: '', label: p.inbox ? 'INBOX' : p.name.toUpperCase(), icon: projIcon(p), tone: 'sky', tasks: isRoutine ? [...loose].sort(byDue) : loose });
        secs.forEach((s) => { const l = laneFor(s.name); groups.push({ id: s.id, label: l.label, icon: l.icon, tone: l.tone, tasks: b.tasks.filter((t) => t.section_id === s.id) }); });
      }
      drawer = (
        <Drawer title={p.inbox ? 'INBOX' : p.name.toUpperCase()} icon={projIcon(p)} tone="sky"
          note={b ? '' : 'Loading…'}
          groups={groups}
          laneTargets={secs.length > 1 ? secs.map((s) => { const l = laneFor(s.name); return { id: s.id, label: l.label, icon: l.icon, tone: l.tone }; }) : null}
          onClose={() => setOpen(null)} onDone={complete} onEdit={setEditing}
          onAdd={(v, sid) => addTask(v, { projectId: p.id, sectionId: sid })}
          onMove={(id, sid) => moveToSection(id, sid, p.id)}
          onReorder={(id, sid, ids, moved) => reorder(id, sid, ids, moved, p.id)} />
      );
    }
  } else if (open?.kind === 'today') {
    const dueToday = today.filter((t) => !t.due?.date || t.due.date.slice(0, 10) >= tk).sort(byDue);
    const groups = [];
    if (overdue.length) groups.push({ id: 'over', canAdd: false, label: 'OVERDUE', icon: '!', tone: 'red', tasks: [...overdue].sort(byDue), subFor: (t) => projName(t.project_id).toUpperCase() });
    groups.push({ id: 'today', label: 'TODAY', icon: '☀', tone: 'cyan', tasks: dueToday, subFor: (t) => projName(t.project_id).toUpperCase() });
    drawer = (
      <Drawer title="DUE TODAY" icon="☀" tone="cyan" groups={groups}
        note="Bad day? Meds, eat at midday, one PIP diary line, 15 minutes on anything. That counts."
        onClose={() => setOpen(null)} onDone={complete} onEdit={setEditing}
        onAdd={(v) => addTask(v, { dueString: 'today' })}
        onMove={() => {}} onReorder={() => {}} />
    );
  }

  const openProject = (p) => { setOpen({ kind: 'project', id: p.id }); loadProject(p.id); };
  const editSections = editing
    ? (lanes && editing.project_id === lanes.project_id ? lanes.sections : (other[editing.project_id]?.sections || []))
    : [];

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-display text-xl tracking-wider text-white">TODAY <span className="text-cyan-400">// ONE THING AT A TIME</span></div>
          <div className="font-mono text-[11px] text-slate-500">
            {busy ? 'SYNCING WITH TODOIST…' : synced ? `SYNCED ${hhmm(synced)}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="hud-btn !text-[11px]" onClick={() => refresh(true)}>↻ REFRESH</button>
          <button className="hud-btn !text-[11px]" onClick={() => setShowSettings((s) => !s)}>⚙ LINK</button>
        </div>
      </div>

      {showSettings && (
        <div className="space-y-2">
          <div className="font-mono text-[12px] text-slate-400">Linked with token {status.token}. Paste a new one to replace it.</div>
          <TokenSetup compact onSaved={() => { loadStatus(); refresh(true); setShowSettings(false); }} />
        </div>
      )}

      {error && (
        <div className="hud-panel !border-amber-600/60 p-3 font-mono text-[12px] text-amber-200 flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          <button className="hud-btn !text-[11px] !py-1" onClick={() => refresh(true)}>TRY AGAIN</button>
        </div>
      )}

      {/* ---- the moment: what to do right now */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile tone="fuchsia" className="col-span-2 lg:row-span-2 !min-h-[220px]"
          drop={dragId && overLane === nowLane?.id}
          onDragOver={(e) => { if (!dragId || !nowLane) return; e.preventDefault(); setOverLane(nowLane.id); }}
          onDragLeave={() => setOverLane(null)}
          onDrop={(e) => { e.preventDefault(); const id = dragId; setDragId(null); setOverLane(null); if (nowLane) moveToSection(id, nowLane.id); }}>
          <TileHead tone="fuchsia" icon="◉" label="NOW PROJECT" right={nowLane && nowLane.tasks.length > 1 ? `⚠ ${nowLane.tasks.length} in Now — only one` : undefined} />
          {nowTask ? (
            <>
              <button type="button" onClick={() => setEditing(nowTask)} className="text-left">
                <div className="font-display text-2xl sm:text-3xl text-white leading-tight break-words">{nowTask.content}</div>
              </button>
              {(() => {
                const m = /finish line:\**\s*([^\n]+)/i.exec(nowTask.description || '');
                return m ? <div className="font-mono text-[12px] text-fuchsia-200">▸ Finish line: {m[1].replace(/\*/g, '')}</div> : null;
              })()}
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                <button type="button" onClick={() => complete(nowTask)} className="hud-btn !border-emerald-500 !text-emerald-200 !text-[12px]">✓ FINISHED IT</button>
                <button type="button" onClick={() => setEditing(nowTask)} className="hud-btn !text-[12px]">✎ NOTES</button>
                {nowLane && nowLane.tasks.length > 1 && (
                  <button type="button" onClick={() => setOpen({ kind: 'lane', id: nowLane.id })} className="hud-btn !text-[12px] !text-fuchsia-200">PICK ONE</button>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col justify-center gap-2">
              <Big dim>Nothing in Now.</Big>
              <div className="font-mono text-[12px] text-slate-400">Drag a tile from NEXT here, or open NEXT and pick one.</div>
            </div>
          )}
        </Tile>

        <Tile tone="cyan" onClick={() => focus?.current_block && setEditing(focus.current_block)} label="Current block">
          <TileHead tone="cyan" icon="⏱" label="BLOCK" right={curStart ? hhmm(curStart) : undefined} />
          <div className="text-cyan-50 text-[15px] leading-snug line-clamp-3">{cur?.content || 'Quiet start. No builds yet.'}</div>
          {pct !== null && (
            <div className="mt-auto space-y-1">
              <div className="h-2 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-cyan-400" style={{ width: `${pct}%` }} /></div>
              <div className="font-mono text-[10px] text-slate-400">{left}</div>
            </div>
          )}
        </Tile>

        <Tile tone="slate" onClick={() => nxt && setEditing(nxt)} label="Next block">
          <TileHead tone="slate" icon="▸" label="COMING UP" right={nxtStart ? hhmm(nxtStart) : undefined} />
          <div className="text-slate-100 text-[15px] leading-snug line-clamp-3">{nxt?.content || 'Nothing else timed today.'}</div>
        </Tile>

        <Tile tone={overdue.length ? 'red' : 'sky'} onClick={() => setOpen({ kind: 'today' })} label="Due today">
          <TileHead tone={overdue.length ? 'red' : 'sky'} icon={overdue.length ? '!' : '☀'} label={overdue.length ? 'OVERDUE' : 'DUE TODAY'} right={overdue.length ? `${today.length} today` : undefined} />
          <div className={`font-display text-4xl tabular-nums ${overdue.length ? 'text-red-200' : 'text-sky-100'}`}>{overdue.length || today.length}</div>
          <div className="font-mono text-[10px] text-slate-400 mt-auto">TAP TO SEE THEM</div>
        </Tile>

        {hour >= 11 && hour < 14 ? (
          <Tile tone="emerald">
            <TileHead tone="emerald" icon="🍽" label="FUEL" />
            <div className="text-emerald-50 text-[15px]">Eat a proper meal, then rest flat.</div>
          </Tile>
        ) : (
          <AddTile label="ADD SOMETHING FOR TODAY" tone="sky" onAdd={(v) => addTask(v, { dueString: 'today' })} />
        )}
      </div>

      {/* ---- health log for the PIP claim */}
      <PipTile onToast={say} />

      {/* ---- lanes */}
      {lanesProject ? (
        <div className="space-y-2">
          <div className="font-mono text-[11px] tracking-[0.25em] text-slate-500">LANES · TAP TO OPEN · DRAG ONTO A LANE TO MOVE</div>
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
            {otherLanes.map((l) => (
              <Tile key={l.id} tone={l.lane.tone} onClick={() => setOpen({ kind: 'lane', id: l.id })} label={`Open ${l.lane.label}`}
                drop={dragId && overLane === l.id}
                onDragOver={(e) => { if (!dragId) return; e.preventDefault(); setOverLane(l.id); }}
                onDragLeave={() => setOverLane(null)}
                onDrop={(e) => { e.preventDefault(); const id = dragId; setDragId(null); setOverLane(null); if (id && !l.tasks.some((t) => t.id === id)) moveToSection(id, l.id); }}>
                <TileHead tone={l.lane.tone} icon={l.lane.icon} label={l.lane.label} right={l.tasks.length} />
                {l.tasks[0] ? (
                  <div draggable onDragStart={(e) => { e.stopPropagation(); try { e.dataTransfer.setData('text/plain', l.tasks[0].id); } catch (x) {} setDragId(l.tasks[0].id); }}
                    onDragEnd={() => { setDragId(null); setOverLane(null); }} className="cursor-grab">
                    <Big>{l.tasks[0].content}</Big>
                  </div>
                ) : <Big dim>Empty</Big>}
                {l.tasks.length > 1 && <div className="font-mono text-[10px] text-slate-400 mt-auto">+{l.tasks.length - 1} MORE</div>}
              </Tile>
            ))}
            {ideaLane && (
              <AddTile label="DUMP AN IDEA" tone="yellow" onAdd={(v) => addTask(v, { projectId: lanesProject.id, sectionId: ideaLane.id })} />
            )}
          </div>
        </div>
      ) : (
        <div className="font-mono text-[12px] text-slate-500">No Todoist project called “Projects” found, so there are no lanes to show.</div>
      )}

      {/* ---- everything else in Todoist */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-[0.25em] text-slate-500">OTHER TODOIST PROJECTS</div>
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {otherProjects.map((p) => (
            <Tile key={p.id} tone="sky" onClick={() => openProject(p)} className="!min-h-[100px]" label={`Open ${p.name}`}>
              <div className="text-2xl leading-none">{projIcon(p)}</div>
              <div className="font-display text-[15px] text-white leading-snug break-words">{p.inbox ? 'Inbox' : p.name}</div>
            </Tile>
          ))}
        </div>
      </div>

      {drawer}

      {editing && (
        <EditDialog task={editing} sections={editSections}
          onClose={() => setEditing(null)} onSave={save} onDone={complete} onDelete={remove} />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 hud-panel !border-cyan-400 px-4 py-2 font-mono text-[12px] text-cyan-100">{toast}</div>
      )}
    </div>
  );
}
