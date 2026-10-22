import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// LEARN tab: learning sorted by STYLE, studied in POMODORO rounds. Data: backend/learning.py.
// The Pomodoro engine lives at module level so it keeps running when you switch tabs;
// <PomodoroPill/> (rendered by App on every tab) shows it while you're elsewhere.

const API = '/api/learning';

export const STYLES = {
  watch: { icon: '🎬', label: 'WATCH', desc: 'Videos & tutorials', energy: 'low', tone: 'sky' },
  listen: { icon: '🎧', label: 'LISTEN', desc: 'Audiobooks & podcasts', energy: 'low', tone: 'indigo' },
  recall: { icon: '🧠', label: 'RECALL', desc: 'Quiz yourself, explain it back', energy: 'low', tone: 'fuchsia' },
  read: { icon: '📖', label: 'READ', desc: 'Docs, books, articles', energy: 'ok', tone: 'amber' },
  course: { icon: '🎓', label: 'COURSE', desc: 'Next lesson of a course', energy: 'ok', tone: 'cyan' },
  practise: { icon: '✏️', label: 'PRACTISE', desc: 'Drills, sketches, exercises', energy: 'ok', tone: 'emerald' },
  build: { icon: '🛠️', label: 'BUILD IT', desc: 'Hands-on: model, print, wire', energy: 'high', tone: 'orange' },
};
const STYLE_KEYS = Object.keys(STYLES);

export const PRESETS = {
  short: { key: 'short', label: 'SHORT', focus: 15, brk: 5, long: 15, rounds: 4, desc: '15 on · 5 off' },
  classic: { key: 'classic', label: 'CLASSIC', focus: 25, brk: 5, long: 15, rounds: 4, desc: '25 on · 5 off' },
  deep: { key: 'deep', label: 'DEEP', focus: 45, brk: 10, long: 20, rounds: 3, desc: '45 on · 10 off' },
};
const ENERGY = {
  low: { label: 'LOW', icon: '🔋', desc: 'Foggy, sore or tired', preset: 'short', styles: ['watch', 'listen', 'recall'] },
  ok: { label: 'OK', icon: '⚡', desc: 'Normal day', preset: 'classic', styles: ['course', 'read', 'practise', 'watch'] },
  high: { label: 'HIGH', icon: '🚀', desc: 'Sharp and up for it', preset: 'deep', styles: ['build', 'practise', 'course'] },
};
const TONE = {
  sky: 'border-sky-600/60 hover:border-sky-400 bg-sky-950/30 text-sky-300',
  indigo: 'border-indigo-500/60 hover:border-indigo-300 bg-indigo-950/30 text-indigo-300',
  fuchsia: 'border-fuchsia-600/60 hover:border-fuchsia-400 bg-fuchsia-950/30 text-fuchsia-300',
  amber: 'border-amber-600/60 hover:border-amber-400 bg-amber-950/30 text-amber-300',
  cyan: 'border-cyan-600/60 hover:border-cyan-400 bg-cyan-950/30 text-cyan-300',
  emerald: 'border-emerald-600/60 hover:border-emerald-400 bg-emerald-950/30 text-emerald-300',
  orange: 'border-orange-600/60 hover:border-orange-400 bg-orange-950/30 text-orange-300',
  red: 'border-red-600/60 hover:border-red-400 bg-red-950/30 text-red-300',
  slate: 'border-slate-600/60 hover:border-slate-400 bg-slate-900/50 text-slate-300',
};
const CAT_ICON = { '3D/CAD': '🧊', Art: '🎨', Electronics: '🔌', Coding: '💻', 'Klipper/Printing': '🖨️', Business: '£', Other: '◆' };

const pad = (n) => String(n).padStart(2, '0');
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

async function api(path, opts = {}) {
  const res = await fetch(path.startsWith('/api') ? path : `${API}${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === 'string' ? d : `SILAS answered ${res.status}`);
  }
  return data;
}

// ------------------------------------------------------------------ Pomodoro engine (module level)
// phase: idle | focus | review (round done, log it) | break | ready (break over) | done
const KEY = 'silas_pomodoro';
const idle = () => ({ phase: 'idle', itemId: null, topic: '', nextStep: '', style: '', preset: 'classic', round: 1, endsAt: null, pausedLeft: null, focusStartedAt: null, minimised: false });
let pomo = (() => { try { return { ...idle(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { return idle(); } })();
const listeners = new Set();
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(pomo)); } catch (e) {} };
const emit = () => { persist(); listeners.forEach((fn) => fn(pomo)); };
export const setPomo = (patch) => { pomo = { ...pomo, ...(typeof patch === 'function' ? patch(pomo) : patch) }; emit(); };

let audioCtx = null;
function chime(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'focus-end' ? [659, 784, 988] : [988, 784, 659];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = audioCtx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.55);
    });
  } catch (e) {}
}
function notify(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, silent: true }); } catch (e) {}
}

function tick() {
  if (!pomo.endsAt || pomo.pausedLeft != null) return;
  if (Date.now() < pomo.endsAt) return;
  const p = PRESETS[pomo.preset] || PRESETS.classic;
  if (pomo.phase === 'focus') {
    chime('focus-end');
    notify('🍅 Round done', `${pomo.topic || 'Study'}: log it, then take ${p.brk} minutes off.`);
    setPomo({ phase: 'review', endsAt: null, minimised: false });
  } else if (pomo.phase === 'break') {
    chime('break-end');
    const finished = pomo.round > p.rounds;
    notify(finished ? '🏁 Session complete' : '⏱ Break over', finished ? 'Nice work. That counts.' : `Ready for round ${pomo.round}?`);
    setPomo({ phase: finished ? 'done' : 'ready', endsAt: null, minimised: false });
  }
}
if (typeof window !== 'undefined' && !window.__silasPomoTimer) {
  window.__silasPomoTimer = setInterval(() => { tick(); listeners.forEach((fn) => fn(pomo)); }, 500);
  window.addEventListener('storage', (e) => { if (e.key === KEY) { try { pomo = { ...idle(), ...JSON.parse(e.newValue || '{}') }; listeners.forEach((fn) => fn(pomo)); } catch (x) {} } });
}

export function usePomo() {
  const [s, setS] = useState(pomo);
  useEffect(() => { const fn = (v) => setS({ ...v }); listeners.add(fn); return () => listeners.delete(fn); }, []);
  return s;
}

export function startPomodoro(item, presetKey, style) {
  const p = PRESETS[presetKey] || PRESETS.classic;
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
  chime('break-end'); // also unlocks audio from this click
  setPomo({
    phase: 'focus', itemId: item?.id || null, topic: item?.topic || 'Free study', nextStep: item?.next_step || '',
    style: style || item?.styles?.[0] || '', preset: p.key, round: 1, endsAt: Date.now() + p.focus * 60000,
    pausedLeft: null, focusStartedAt: Date.now(), minimised: false,
  });
}
const startNextRound = () => {
  const p = PRESETS[pomo.preset] || PRESETS.classic;
  setPomo({ phase: 'focus', endsAt: Date.now() + p.focus * 60000, pausedLeft: null, focusStartedAt: Date.now(), minimised: false });
};
const startBreak = () => {
  const p = PRESETS[pomo.preset] || PRESETS.classic;
  const longOne = pomo.round >= p.rounds;
  setPomo({ phase: 'break', round: pomo.round + 1, endsAt: Date.now() + (longOne ? p.long : p.brk) * 60000, pausedLeft: null });
};
const togglePause = () => {
  if (pomo.pausedLeft != null) setPomo({ endsAt: Date.now() + pomo.pausedLeft, pausedLeft: null });
  else if (pomo.endsAt) setPomo({ pausedLeft: Math.max(0, pomo.endsAt - Date.now()) });
};
const addFive = () => {
  if (pomo.pausedLeft != null) setPomo({ pausedLeft: pomo.pausedLeft + 300000 });
  else if (pomo.endsAt) setPomo({ endsAt: pomo.endsAt + 300000 });
};

// Small floating timer shown on every tab while a session is running.
export function PomodoroPill({ onLearnTab, onOpen }) {
  const s = usePomo();
  if (s.phase === 'idle' || (onLearnTab && !s.minimised)) return null;
  const left = s.pausedLeft != null ? s.pausedLeft : s.endsAt ? s.endsAt - Date.now() : 0;
  const label = s.phase === 'focus' ? `🍅 ${mmss(left)}` : s.phase === 'break' ? `☕ ${mmss(left)}` : s.phase === 'review' ? '🍅 LOG IT' : s.phase === 'ready' ? '▶ NEXT ROUND' : '🏁 DONE';
  return (
    <button type="button" onClick={() => { setPomo({ minimised: false }); onOpen && onOpen(); }}
      data-phase={s.phase} className={`silas-pomo-pill fixed bottom-4 right-4 z-[60] flex items-center gap-3 px-4 py-2.5 rounded-full border-2 font-mono text-[13px] shadow-[0_0_24px_rgba(0,0,0,0.6)] ${s.phase === 'focus' ? 'border-red-400 bg-red-950/90 text-red-100' : s.phase === 'break' ? 'border-emerald-400 bg-emerald-950/90 text-emerald-100' : 'border-amber-400 bg-amber-950/90 text-amber-100 animate-pulse'}`}
      style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Open the study timer">
      <span className="font-bold tabular-nums">{label}</span>
      <span className="max-w-[160px] truncate text-[11px] opacity-80">{s.topic}{s.pausedLeft != null ? ' · paused' : ''}</span>
    </button>
  );
}

// ------------------------------------------------------------------ focus screen
function Ring({ frac, tone }) {
  const r = 120, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 280 280" className="w-[min(70vw,300px)] h-[min(70vw,300px)] -rotate-90" aria-hidden="true">
      <circle cx="140" cy="140" r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth="14" />
      <circle cx="140" cy="140" r={r} fill="none" stroke={tone} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, frac)))} style={{ filter: `drop-shadow(0 0 10px ${tone})`, transition: 'stroke-dashoffset .5s linear' }} />
    </svg>
  );
}

function FocusScreen({ items, onLogged }) {
  const s = usePomo();
  const p = PRESETS[s.preset] || PRESETS.classic;
  const item = items.find((i) => i.id === s.itemId);
  const [note, setNote] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [progress, setProgress] = useState(item?.progress ?? 0);
  const [stopArmed, setStopArmed] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (s.phase === 'review') { setNote(''); setNextStep(item?.next_step || ''); setProgress(item?.progress ?? 0); } }, [s.phase]); // eslint-disable-line

  if (s.phase === 'idle' || s.minimised) return null;
  const left = s.pausedLeft != null ? s.pausedLeft : s.endsAt ? s.endsAt - Date.now() : 0;
  const total = s.phase === 'focus' ? p.focus * 60000 : (s.round - 1 >= p.rounds ? p.long : p.brk) * 60000;
  const st = STYLES[s.style];

  const logRound = async (minutes) => {
    setErr('');
    try {
      await api('/sessions', { method: 'POST', body: { item_id: s.itemId, minutes, note, preset: s.preset, style: s.style, next_step: nextStep, progress: s.itemId ? progress : undefined } });
      onLogged && onLogged();
      return true;
    } catch (e) { setErr(e.message); return false; }
  };
  const stopNow = async () => {
    if (!stopArmed) { setStopArmed(true); setTimeout(() => setStopArmed(false), 4000); return; }
    if (s.phase === 'focus' && s.focusStartedAt) {
      const mins = Math.round((Date.now() - s.focusStartedAt - (s.pausedLeft != null ? 0 : 0)) / 60000);
      if (mins >= 5) await logRound(mins);
    }
    setPomo(idle());
  };

  const dots = Array.from({ length: p.rounds }, (_, i) => {
    const doneRounds = s.phase === 'focus' || s.phase === 'review' ? s.round - 1 : s.round - 1;
    return i < doneRounds ? '🍅' : i === doneRounds && (s.phase === 'focus' || s.phase === 'review') ? '⏳' : '○';
  });

  return (
    <div className="silas-focus fixed inset-0 z-50 bg-[#05070c]/95 backdrop-blur-sm overflow-y-auto" role="dialog" aria-modal="true" aria-label="Study timer">
      <div className="min-h-full flex flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="font-mono text-[12px] tracking-[0.3em] text-slate-400">
          {p.label} POMODORO · ROUND {Math.min(s.phase === 'break' || s.phase === 'ready' || s.phase === 'done' ? s.round - 1 : s.round, p.rounds)} OF {p.rounds}
        </div>
        <div className="font-display text-3xl sm:text-4xl text-white max-w-3xl leading-tight">{st ? `${st.icon} ` : ''}{s.topic}</div>
        {s.nextStep && s.phase === 'focus' && <div className="font-mono text-sm text-cyan-200 max-w-2xl">▸ {s.nextStep}</div>}

        {(s.phase === 'focus' || s.phase === 'break') && (
          <>
            <div className="relative grid place-items-center">
              <Ring frac={left / total} tone={s.phase === 'focus' ? '#f87171' : '#34d399'} />
              <div className="absolute flex flex-col items-center">
                <div className={`font-display text-6xl tabular-nums ${s.phase === 'focus' ? 'text-red-100' : 'text-emerald-100'}`}>{mmss(left)}</div>
                <div className="font-mono text-[12px] tracking-[0.25em] text-slate-400 mt-1">{s.pausedLeft != null ? 'PAUSED' : s.phase === 'focus' ? 'FOCUS' : (s.round - 1 >= p.rounds ? 'LONG BREAK' : 'BREAK')}</div>
              </div>
            </div>
            {s.phase === 'break' && (
              <div className="font-mono text-[13px] text-emerald-200 max-w-md">
                Off the screen: stand up, stretch gently, get some water.{new Date().getHours() >= 11 && new Date().getHours() < 14 ? ' And eat something.' : ''}
              </div>
            )}
            <div className="text-2xl tracking-widest" aria-label="Rounds">{dots.join(' ')}</div>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={togglePause} className="hud-btn !text-[13px] !px-5">{s.pausedLeft != null ? '▶ RESUME' : '❚❚ PAUSE'}</button>
              <button type="button" onClick={addFive} className="hud-btn !text-[13px]">+5 MIN</button>
              {s.phase === 'break' && <button type="button" onClick={startNextRound} className="hud-btn !text-[13px]">SKIP BREAK</button>}
              <button type="button" onClick={() => setPomo({ minimised: true })} className="hud-btn !text-[13px]">▾ MINIMISE</button>
              <button type="button" onClick={stopNow} className={`hud-btn !text-[13px] ${stopArmed ? '!bg-red-600 !text-white' : 'text-red-300'}`}>{stopArmed ? 'TAP AGAIN TO STOP' : '■ STOP'}</button>
            </div>
            <div className="font-mono text-[11px] text-slate-500">The timer keeps going if you switch tabs. Look for it bottom-right.</div>
          </>
        )}

        {s.phase === 'review' && (
          <div className="w-full max-w-xl hud-panel border-2 border-red-500/50 p-5 space-y-4 text-left">
            <div className="font-display text-2xl text-red-100 text-center">🍅 ROUND DONE · {p.focus} MIN</div>
            <label className="block font-mono text-[11px] tracking-[0.2em] text-slate-400">WHAT DID YOU GET DONE? (OPTIONAL)
              <input id="pomo-note" value={note} onChange={(e) => setNote(e.target.value)} autoFocus
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 font-sans text-sm normal-case tracking-normal focus:border-cyan-400 outline-none" />
            </label>
            {s.itemId && (
              <>
                <label className="block font-mono text-[11px] tracking-[0.2em] text-slate-400">NEXT STEP FOR NEXT TIME
                  <input id="pomo-next" value={nextStep} onChange={(e) => setNextStep(e.target.value)}
                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 font-sans text-sm normal-case tracking-normal focus:border-cyan-400 outline-none" />
                </label>
                <label className="block font-mono text-[11px] tracking-[0.2em] text-slate-400">HOW FAR THROUGH · {progress}%
                  <input id="pomo-progress" type="range" min="0" max="100" step="5" value={progress} onChange={(e) => setProgress(Number(e.target.value))} className="mt-2 w-full accent-cyan-400" />
                </label>
              </>
            )}
            {err && <div className="font-mono text-[12px] text-amber-300">{err}</div>}
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" onClick={async () => { if (await logRound(p.focus)) setPomo(idle()); }} className="hud-btn !text-[12px]">LOG & FINISH</button>
              <button type="button" onClick={async () => { if (await logRound(p.focus)) startBreak(); }} className="hud-btn hud-btn-primary !text-[13px] !px-5">
                ✓ LOG & TAKE {s.round >= p.rounds ? p.long : p.brk} MIN BREAK
              </button>
            </div>
          </div>
        )}

        {s.phase === 'ready' && (
          <div className="space-y-4">
            <div className="font-display text-3xl text-emerald-100">☕ BREAK OVER</div>
            <div className="text-2xl tracking-widest">{dots.join(' ')}</div>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={startNextRound} className="hud-btn hud-btn-primary !text-[14px] !px-6 !py-3">▶ START ROUND {s.round}</button>
              <button type="button" onClick={() => setPomo(idle())} className="hud-btn !text-[13px]">CALL IT A DAY</button>
            </div>
          </div>
        )}

        {s.phase === 'done' && (
          <div className="space-y-4">
            <div className="font-display text-4xl text-emerald-100">🏁 SESSION COMPLETE</div>
            <div className="text-2xl tracking-widest">{'🍅'.repeat(p.rounds)}</div>
            <div className="font-mono text-sm text-slate-300">{p.rounds} rounds, {p.rounds * p.focus} minutes. That counts.</div>
            <button type="button" onClick={() => setPomo(idle())} className="hud-btn hud-btn-primary !text-[14px] !px-6 !py-3">CLOSE</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ edit dialog
function ItemDialog({ item, categories, statuses, onClose, onSaved }) {
  const [f, setF] = useState({
    topic: '', category: 'Other', resource: '', platform: '', url: '', styles: [], status: 'Queued', priority: 2,
    progress: 0, est_hours: '', next_step: '', linked_project: '', notes: '', ...(item || {}),
  });
  const [err, setErr] = useState('');
  const [armed, setArmed] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? e.target.value : e }));
  const toggleStyle = (k) => setF((x) => ({ ...x, styles: x.styles.includes(k) ? x.styles.filter((s) => s !== k) : [...x.styles, k] }));
  const save = async (e) => {
    e.preventDefault(); setErr('');
    const body = { ...f, priority: Number(f.priority) || 2, progress: Number(f.progress) || 0, est_hours: f.est_hours === '' || f.est_hours == null ? null : Number(f.est_hours) };
    ['id', 'created_at', 'updated_at', 'hours_done', 'last_studied'].forEach((k) => delete body[k]);
    try {
      if (item?.id) await api(`/items/${item.id}`, { method: 'PUT', body }); else await api('/items', { method: 'POST', body });
      onSaved(item?.id ? 'Saved' : 'Added to your learning');
    } catch (x) { setErr(x.message); }
  };
  const del = async () => {
    if (!armed) { setArmed(true); return; }
    try { await api(`/items/${item.id}`, { method: 'DELETE' }); onSaved('Deleted'); } catch (x) { setErr(x.message); }
  };
  const inp = 'mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-100 font-sans text-sm normal-case tracking-normal focus:border-cyan-400 outline-none';
  const lab = 'block font-mono text-[11px] tracking-[0.2em] text-slate-400';
  return (
    <div className="fixed inset-0 z-50 bg-black/75 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form onSubmit={save} className="hud-panel border-2 border-cyan-500/50 max-w-2xl mx-auto my-8 p-5 space-y-4" role="dialog" aria-modal="true" aria-labelledby="learn-h">
        <div className="flex items-center justify-between gap-3">
          <div id="learn-h" className="font-display text-2xl tracking-wider text-cyan-300">{item?.id ? 'EDIT LEARNING' : '+ NEW THING TO LEARN'}</div>
          <button type="button" onClick={onClose} className="hud-btn !text-[12px]">✕</button>
        </div>
        <label className={lab}>TOPIC<input id="learn-topic" required value={f.topic} onChange={set('topic')} placeholder="e.g. Klipper macros" className={inp} autoFocus /></label>
        <div>
          <div className={lab}>HOW DO YOU LEARN THIS? (PICK ANY)</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2">
            {STYLE_KEYS.map((k) => (
              <button key={k} type="button" onClick={() => toggleStyle(k)} aria-pressed={f.styles.includes(k)}
                className={`rounded-md border-2 px-2 py-2 text-left font-mono text-[11px] ${f.styles.includes(k) ? 'border-cyan-300 bg-cyan-800/60 text-white' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-400'}`}>
                {STYLES[k].icon} {STYLES[k].label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className={lab}>RESOURCE<input id="learn-res" value={f.resource} onChange={set('resource')} placeholder="course / book / video" className={inp} /></label>
          <label className={lab}>PLATFORM<input id="learn-plat" value={f.platform} onChange={set('platform')} placeholder="Udemy, YouTube, Book…" className={inp} /></label>
          <label className={lab}>LINK<input id="learn-url" value={f.url} onChange={set('url')} placeholder="https://…" className={inp} /></label>
          <label className={lab}>CATEGORY
            <select id="learn-cat" value={f.category} onChange={set('category')} className={inp}>{categories.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <label className={lab}>STATUS
            <select id="learn-status" value={f.status} onChange={set('status')} className={inp}>{statuses.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
          <div>
            <div className={lab}>PRIORITY</div>
            <div className="flex gap-1.5 mt-1">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" onClick={() => setF((x) => ({ ...x, priority: n }))} aria-pressed={Number(f.priority) === n}
                  className={`flex-1 rounded-md border-2 py-2 font-mono text-[12px] ${Number(f.priority) === n ? 'border-cyan-300 bg-cyan-800/60 text-white' : 'border-slate-700 bg-slate-900 text-slate-300'}`}>
                  {n === 1 ? 'HIGH' : n === 2 ? 'MID' : 'LOW'}
                </button>
              ))}
            </div>
          </div>
          <label className={lab}>HOW FAR THROUGH · {f.progress}%<input id="learn-prog" type="range" min="0" max="100" step="5" value={f.progress} onChange={set('progress')} className="mt-3 w-full accent-cyan-400" /></label>
          <label className={lab}>ESTIMATED HOURS<input id="learn-est" type="number" min="0" step="0.5" value={f.est_hours ?? ''} onChange={set('est_hours')} className={inp} /></label>
        </div>
        <label className={lab}>NEXT STEP (THE VERY NEXT SMALL ACTION)<input id="learn-next" value={f.next_step} onChange={set('next_step')} placeholder="e.g. watch lesson 4 and copy the model" className={inp} /></label>
        <label className={lab}>LINKED PROJECT<input id="learn-proj" value={f.linked_project} onChange={set('linked_project')} placeholder="SV08 toolchanger, MAX Kraken, Bloke's Depot…" className={inp} /></label>
        <label className={lab}>NOTES<textarea id="learn-notes" rows={3} value={f.notes} onChange={set('notes')} className={inp} /></label>
        {err && <div className="font-mono text-[12px] text-amber-300">{err}</div>}
        <div className="flex justify-between gap-2">
          <div>{item?.id && <button type="button" onClick={del} className={`hud-btn !text-[11px] ${armed ? '!bg-red-600 !text-white' : 'text-red-300'}`}>{armed ? 'CLICK AGAIN TO DELETE' : 'DELETE'}</button>}</div>
          <button type="submit" className="hud-btn hud-btn-primary !text-[13px] !px-6">SAVE</button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ tiles
function Tile({ tone = 'slate', className = '', onClick, children, label }) {
  const clickable = onClick ? { role: 'button', tabIndex: 0, onClick, onKeyDown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onClick(e); } } } : {};
  return (
    <div aria-label={label} {...clickable}
      data-tone={tone} className={`silas-tile relative rounded-lg border-2 ${TONE[tone] || TONE.slate} p-4 flex flex-col gap-2 min-w-0 ${onClick ? 'cursor-pointer' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${className}`}>
      {children}
    </div>
  );
}

function ItemTile({ it, presetKey, onEdit }) {
  const st = it.styles.map((s) => STYLES[s]).filter(Boolean);
  const done = it.status === 'Done' || it.status === 'Dropped';
  return (
    <Tile tone={it.status === 'Active' ? 'cyan' : 'slate'} onClick={() => onEdit(it)} label={`Edit ${it.topic}`} className={`min-h-[190px] ${done ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.2em]">
        <span className="text-slate-400">{CAT_ICON[it.category] || '◆'} {it.category.toUpperCase()}</span>
        <span className={it.status === 'Active' ? 'text-cyan-300' : 'text-slate-500'}>{it.status.toUpperCase()}{it.priority === 1 ? ' · ★' : ''}</span>
      </div>
      <div className="font-display text-[19px] text-white leading-snug break-words">{it.topic}</div>
      {(it.resource || it.platform) && <div className="font-mono text-[11px] text-slate-400 truncate">{it.resource}{it.platform ? ` · ${it.platform}` : ''}</div>}
      {it.next_step && <div className="text-[13px] text-cyan-100 line-clamp-2">▸ {it.next_step}</div>}
      <div className="mt-auto space-y-1.5">
        <div className="h-1.5 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-cyan-400" style={{ width: `${it.progress || 0}%` }} /></div>
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-slate-400">
          <span>{it.progress || 0}% · {it.hours_done}h{it.est_hours ? ` of ${it.est_hours}h` : ''}</span>
          <span className="text-base leading-none" aria-label={st.map((s) => s.label).join(', ')}>{st.map((s) => s.icon).join(' ')}</span>
        </div>
        <div className="flex gap-2 pt-1">
          {!done && (
            <button type="button" onClick={(e) => { e.stopPropagation(); startPomodoro(it, presetKey); }} className="hud-btn !border-red-500 !text-red-100 !text-[11px] !py-1.5 flex-1 justify-center">
              ▶ START {PRESETS[presetKey].focus} MIN
            </button>
          )}
          {it.url && <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="hud-btn !text-[11px] !py-1.5" aria-label={`Open ${it.topic} resource`}>↗</a>}
        </div>
      </div>
    </Tile>
  );
}

// ------------------------------------------------------------------ main tab
export default function LearnBoard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [energy, setEnergy] = useState(() => { try { return localStorage.getItem('silas_learn_energy') || 'ok'; } catch (e) { return 'ok'; } });
  const [presetKey, setPresetKey] = useState(ENERGY[energy]?.preset || 'classic');
  const [styleFilter, setStyleFilter] = useState(null);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState('');
  const [bookAt, setBookAt] = useState('');
  const [showBook, setShowBook] = useState(false);
  const s = usePomo();

  const say = (m) => { setToast(m); clearTimeout(say.t); say.t = setTimeout(() => setToast(''), 2400); };
  const load = useCallback(async () => {
    try { setData(await api('')); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pickEnergy = (k) => {
    setEnergy(k); setPresetKey(ENERGY[k].preset);
    try { localStorage.setItem('silas_learn_energy', k); } catch (e) {}
  };

  const items = data?.items || [];
  const live = items.filter((i) => i.status !== 'Done' && i.status !== 'Dropped');
  const suggestion = useMemo(() => {
    const wants = ENERGY[energy].styles;
    const pool = live.filter((i) => i.status === 'Active' || i.status === 'Queued');
    return pool.find((i) => i.styles.some((st) => wants.includes(st))) || pool[0] || null;
  }, [live, energy]);
  const suggestStyle = suggestion ? (suggestion.styles.find((st) => ENERGY[energy].styles.includes(st)) || suggestion.styles[0]) : null;
  const shown = styleFilter ? items.filter((i) => i.styles.includes(styleFilter)) : items;
  const stats = data?.stats;
  const maxDay = Math.max(25, ...(stats?.week || []).map((d) => d.minutes));

  const book = async () => {
    if (!bookAt || !suggestion) return;
    const p = PRESETS[presetKey];
    const today = new Date();
    const [h, m] = bookAt.split(':').map(Number);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
    const totalMin = p.rounds * p.focus + (p.rounds - 1) * p.brk;
    const end = new Date(start.getTime() + totalMin * 60000);
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    try {
      await api('/api/calendar/events', { method: 'POST', body: { title: `Study: ${suggestion.topic} (${p.rounds}× ${p.focus} min)`, start: iso(start), end: iso(end), location: 'Desk', description: suggestion.next_step || '' } });
      setShowBook(false); say(`Booked ${bookAt}–${pad(end.getHours())}:${pad(end.getMinutes())}. The collision radar knows.`);
    } catch (e) { say(e.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-display text-xl tracking-wider text-white">LEARN <span className="text-red-400">// ONE ROUND AT A TIME</span></div>
          <div className="font-mono text-[11px] text-slate-500">Pick your energy, press start, log what you did. Breaks are part of it.</div>
        </div>
        <button className="hud-btn !text-[11px]" onClick={() => setEditing({})}>+ ADD SOMETHING TO LEARN</button>
      </div>

      {error && <div className="hud-panel !border-amber-600/60 p-3 font-mono text-[12px] text-amber-200">{error}</div>}

      {/* ---- study now */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div data-tone="red" className="silas-tile silas-study lg:col-span-2 rounded-lg border-2 border-red-500/60 bg-red-950/20 shadow-[0_0_24px_rgba(239,68,68,0.15)] p-4 sm:p-5 space-y-4">
          <div className="font-mono text-[11px] tracking-[0.2em] font-bold text-red-300">🍅 STUDY NOW · HOW'S YOUR ENERGY?</div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(ENERGY).map(([k, e]) => (
              <button key={k} type="button" onClick={() => pickEnergy(k)} aria-pressed={energy === k}
                className={`rounded-lg border-2 p-3 text-left ${energy === k ? 'border-red-300 bg-red-900/40' : 'border-slate-700 bg-slate-900/60 hover:border-slate-400'}`}>
                <div className="font-display text-lg text-white">{e.icon} {e.label}</div>
                <div className="font-mono text-[10px] text-slate-400">{e.desc}</div>
              </button>
            ))}
          </div>
          {suggestion ? (
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[10px] tracking-[0.2em] text-slate-400">SUGGESTED{suggestStyle ? ` · ${STYLES[suggestStyle].icon} ${STYLES[suggestStyle].label}` : ''}</div>
                <div className="font-display text-2xl sm:text-3xl text-white leading-tight break-words">{suggestion.topic}</div>
                {suggestion.next_step && <div className="text-[14px] text-cyan-100 mt-1">▸ {suggestion.next_step}</div>}
              </div>
              <div className="flex flex-col items-stretch gap-2">
                <div className="flex gap-1">
                  {Object.values(PRESETS).map((p) => (
                    <button key={p.key} type="button" onClick={() => setPresetKey(p.key)} aria-pressed={presetKey === p.key} title={p.desc}
                      className={`px-2.5 py-1.5 rounded border font-mono text-[10px] tracking-wider ${presetKey === p.key ? 'border-red-300 bg-red-800/50 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                      {p.label}<div className="text-[9px] opacity-70">{p.desc}</div>
                    </button>
                  ))}
                </div>
                <button type="button" disabled={s.phase !== 'idle'} onClick={() => startPomodoro(suggestion, presetKey, suggestStyle)}
                  className="hud-btn !border-red-400 !bg-red-700/60 !text-white !text-[15px] !py-3 justify-center disabled:opacity-40">
                  {s.phase === 'idle' ? `▶ START ${PRESETS[presetKey].focus} MIN` : 'SESSION RUNNING'}
                </button>
                <button type="button" onClick={() => setShowBook((v) => !v)} className="font-mono text-[11px] text-slate-400 hover:text-white underline">📅 book it for later today</button>
              </div>
            </div>
          ) : (
            <div className="font-mono text-[13px] text-slate-400">Nothing queued yet. Add something to learn and SILAS will suggest it here.</div>
          )}
          {showBook && suggestion && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-slate-300">
              <span>Start at</span>
              <input id="learn-book" type="time" value={bookAt} onChange={(e) => setBookAt(e.target.value)} className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100 [color-scheme:dark]" />
              <span>for {PRESETS[presetKey].rounds} rounds</span>
              <button type="button" onClick={book} disabled={!bookAt} className="hud-btn hud-btn-primary !text-[11px] !py-1 disabled:opacity-40">ADD TO SCHEDULE</button>
            </div>
          )}
        </div>

        <Tile tone={stats?.days_since >= 3 ? 'amber' : 'slate'}>
          <div className="font-mono text-[11px] tracking-[0.2em] font-bold">📈 PROGRESS</div>
          <div className="flex items-end gap-4">
            <div><div className="font-display text-4xl text-white tabular-nums">{stats?.today_rounds ?? 0}</div><div className="font-mono text-[10px] text-slate-400">🍅 TODAY</div></div>
            <div><div className="font-display text-2xl text-white tabular-nums">{Math.round((stats?.week_minutes ?? 0) / 6) / 10}h</div><div className="font-mono text-[10px] text-slate-400">THIS WEEK</div></div>
            <div><div className="font-display text-2xl text-white tabular-nums">{stats?.streak ?? 0}</div><div className="font-mono text-[10px] text-slate-400">DAY STREAK</div></div>
          </div>
          <div className="flex items-end gap-1.5 h-16 mt-1" aria-label="Minutes studied each day this week">
            {(stats?.week || []).map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full rounded-t bg-red-400/80" style={{ height: `${Math.max(3, (d.minutes / maxDay) * 48)}px`, opacity: d.minutes ? 1 : 0.25 }} title={`${d.minutes} min`} />
                <div className="font-mono text-[9px] text-slate-500">{new Date(`${d.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'narrow' })}</div>
              </div>
            ))}
          </div>
          {stats?.days_since >= 3 && <div className="font-mono text-[12px] text-amber-200">{stats.days_since} days since your last round. One short 15-minute round?</div>}
        </Tile>
      </div>

      {/* ---- styles */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-[0.25em] text-slate-500">STYLES OF LEARNING · TAP TO FILTER</div>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
          {STYLE_KEYS.map((k) => {
            const st = STYLES[k]; const n = live.filter((i) => i.styles.includes(k)).length;
            const on = styleFilter === k;
            return (
              <Tile key={k} tone={st.tone} onClick={() => setStyleFilter(on ? null : k)} label={`Show ${st.label} learning`} className={`min-h-[110px] ${on ? 'ring-2 ring-white/70' : ''}`}>
                <div className="flex items-center justify-between"><span className="text-2xl leading-none">{st.icon}</span><span className="font-mono text-[11px] text-slate-400">{n}</span></div>
                <div className="font-mono text-[12px] tracking-[0.15em] font-bold">{st.label}</div>
                <div className="text-[11px] text-slate-400 leading-snug">{st.desc}</div>
              </Tile>
            );
          })}
        </div>
      </div>

      {/* ---- items */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-[0.25em] text-slate-500">
          YOUR LEARNING{styleFilter ? ` · ${STYLES[styleFilter].label} ONLY` : ''} · TAP TO EDIT
          {styleFilter && <button type="button" onClick={() => setStyleFilter(null)} className="ml-2 underline">show all</button>}
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {shown.map((it) => <ItemTile key={it.id} it={it} presetKey={presetKey} onEdit={setEditing} />)}
          <button type="button" onClick={() => setEditing({ styles: styleFilter ? [styleFilter] : [] })}
            className="silas-addtile rounded-lg border-2 border-dashed border-slate-700 hover:border-cyan-500 text-slate-500 hover:text-cyan-300 min-h-[190px] flex flex-col items-center justify-center gap-1 font-mono">
            <span className="text-3xl leading-none">+</span><span className="text-[11px] tracking-widest">ADD SOMETHING TO LEARN</span>
          </button>
        </div>
      </div>

      {editing && (
        <ItemDialog item={editing.id ? editing : { ...editing }} categories={data?.categories || Object.keys(CAT_ICON)} statuses={data?.statuses || ['Idea', 'Queued', 'Active', 'Paused', 'Done', 'Dropped']}
          onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); say(m); load(); }} />
      )}
      <FocusScreen items={items} onLogged={() => { say('Round logged. 🍅'); load(); }} />
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] hud-panel !border-cyan-400 px-4 py-2 font-mono text-[12px] text-cyan-100">{toast}</div>}
    </div>
  );
}
