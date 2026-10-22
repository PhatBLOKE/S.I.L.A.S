import React, { useEffect, useRef, useState } from 'react';

/*
 * SILAS Screen Guard: protects the display from image retention / burn-in.
 *
 *  1. Hue drift      - the whole HUD slowly drifts a few degrees of hue and back (about a
 *                      20-minute cycle), in invisible half-degree steps, so bright neon
 *                      borders never sit on exactly the same colour for hours.
 *  2. Breathing      - brightness eases between 100% and ~92% on a slower cycle.
 *  3. Pixel shift    - the whole layout moves by up to 2 px every few minutes, so hard
 *                      panel edges don't stay on the same row of pixels.
 *  4. Deep dim       - after N minutes without input: background to pure black, everything
 *                      dimmed and desaturated. Any input brings it straight back.
 *  5. Screensaver    - after M minutes: pure black with a small, dim, slowly wandering
 *                      status block (clock, printers, alerts, next event).
 *
 * Idle = no mouse, pen, touch, wheel or keyboard input inside the SILAS window. Using other
 * apps on another monitor counts as idle, which is the point: SILAS still sits there static.
 * A new printer alert wakes the screen. Nothing runs while a webcam view is open.
 * During a Pomodoro round it only dims (never the screensaver), and wakes when the round ends.
 * All steps are discrete (no per-frame animation), so it costs ~nothing in GPU time.
 */

// Wallpaper mode: open SILAS as http://localhost:8000/?wallpaper=1 (e.g. in Lively Wallpaper).
// A wallpaper hardly ever gets input, so it keeps the dashboard up (no screensaver by default)
// and relies on deep dim + hue drift + pixel shift instead. It has its own saved settings.
export const IS_WALLPAPER = (() => {
  try { return new URLSearchParams(window.location.search).has('wallpaper'); } catch (e) { return false; }
})();
const STORAGE_KEY = IS_WALLPAPER ? 'silas_screen_guard_wallpaper' : 'silas_screen_guard';
export const SCREEN_GUARD_DEFAULTS = {
  enabled: true,
  dimMins: 5,
  saverMins: 10,
  hueShift: true,
  breathe: true,
  pixelShift: true,
  ...(IS_WALLPAPER ? { saverMins: 0, dimMins: 5 } : {}), // 0 = never
};

export function useScreenGuardSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return { ...SCREEN_GUARD_DEFAULTS, ...(saved || {}) };
    } catch (e) {
      return { ...SCREEN_GUARD_DEFAULTS };
    }
  });
  const update = (patch) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) {}
      return next;
    });
  return [settings, update];
}

// Triangle wave in [-1, 1] with the given period (ms).
const tri = (t, period) => {
  const p = ((t % period) + period) % period / period;
  return p < 0.5 ? p * 4 - 1 : 3 - p * 4;
};

const HUE_RANGE_DEG = 10;            // +-10 degrees
const HUE_PERIOD = 20 * 60 * 1000;   // full cycle 20 min
const BREATHE_MIN = 0.92;
const BREATHE_PERIOD = 13 * 60 * 1000;
const SHIFT_EVERY = 3 * 60 * 1000;   // new pixel offset every 3 min
const SHIFT_MAX = 2;                 // px
const WAKE_MOVE_PX = 10;             // ignore sub-10px jitter (pen hover, desk knocks)

const setVar = (name, value) => document.documentElement.style.setProperty(name, value);

export default function ScreenGuard({ settings, fleet = [], alerts = [], briefing = null, paused = false,
  previewToken = 0 }) {
  const [stage, setStage] = useState('awake'); // 'awake' | 'dim' | 'saver'
  const lastInput = useRef(Date.now());
  const lastPos = useRef(null);
  const stageRef = useRef(stage);
  const phaseRef = useRef('idle');
  stageRef.current = stage;

  // ---- idle tracking ------------------------------------------------------
  useEffect(() => {
    const wake = () => {
      lastInput.current = Date.now();
      if (stageRef.current !== 'awake') setStage('awake');
    };
    const onMove = (e) => {
      // The screensaver overlay has its own, larger wake threshold.
      if (stageRef.current === 'saver') { lastPos.current = null; return; }
      const p = lastPos.current;
      lastPos.current = { x: e.clientX, y: e.clientY };
      if (!p) return;
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < WAKE_MOVE_PX) return;
      wake();
    };
    const events = ['keydown', 'wheel', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
    window.addEventListener('pointermove', onMove, { passive: true });
    // In dim mode a press goes straight through to the app. The saver overlay handles its own.
    window.addEventListener('pointerdown', wake, { passive: true });
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, wake));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', wake);
    };
  }, []);

  // Preview button in Settings.
  useEffect(() => {
    if (previewToken) setStage('saver');
  }, [previewToken]);

  // New warning/critical alert wakes the screen.
  const urgent = alerts.filter((a) => a.severity !== 'info').length;
  const prevUrgent = useRef(urgent);
  useEffect(() => {
    if (urgent > prevUrgent.current) {
      lastInput.current = Date.now();
      setStage('awake');
    }
    prevUrgent.current = urgent;
  }, [urgent]);

  // Stage clock.
  useEffect(() => {
    const t = setInterval(() => {
      if (!settings.enabled || paused) {
        lastInput.current = Date.now();
        if (stageRef.current !== 'awake' && !previewToken) setStage('awake');
        return;
      }
      const idleMin = (Date.now() - lastInput.current) / 60000;
      const saverAt = settings.saverMins > 0 ? settings.saverMins : Infinity; // 0 = never
      const dimAt = Math.min(Math.max(1, settings.dimMins), saverAt);
      let want = idleMin >= saverAt ? 'saver' : idleMin >= dimAt ? 'dim' : 'awake';
      // Pomodoro (Learn tab): during a focus/break round, dim at most so the timer stays
      // readable; when a round ends and wants logging, wake the screen.
      let phase = 'idle';
      try { phase = JSON.parse(localStorage.getItem('silas_pomodoro') || '{}').phase || 'idle'; } catch (e) {}
      if (phase === 'review' || phase === 'ready') {
        if (stageRef.current !== 'awake' && phaseRef.current !== phase) { lastInput.current = Date.now(); setStage('awake'); }
        phaseRef.current = phase;
        return;
      }
      phaseRef.current = phase;
      if ((phase === 'focus' || phase === 'break') && want === 'saver') want = 'dim';
      const order = { awake: 0, dim: 1, saver: 2 };
      if ((phase === 'focus' || phase === 'break') && stageRef.current === 'saver') { setStage('dim'); return; }
      // Never step *backwards* on the timer: only input wakes it.
      if (order[want] > order[stageRef.current]) setStage(want);
    }, 5000);
    return () => clearInterval(t);
  }, [settings.enabled, settings.dimMins, settings.saverMins, paused, previewToken]);

  // ---- hue drift, breathing, pixel shift (stepped, not animated) -----------
  useEffect(() => {
    const apply = () => {
      const now = Date.now();
      const on = settings.enabled;
      setVar('--sg-hue', on && settings.hueShift ? `${(tri(now, HUE_PERIOD) * HUE_RANGE_DEG).toFixed(1)}deg` : '0deg');
      const b = on && settings.breathe ? 1 - (1 - BREATHE_MIN) * (tri(now, BREATHE_PERIOD) + 1) / 2 : 1;
      setVar('--sg-breathe', b.toFixed(3));
    };
    const shift = () => {
      if (settings.enabled && settings.pixelShift) {
        const r = () => Math.round(Math.random() * SHIFT_MAX * 2 - SHIFT_MAX);
        setVar('--sg-dx', `${r()}px`);
        setVar('--sg-dy', `${r()}px`);
      } else {
        setVar('--sg-dx', '0px');
        setVar('--sg-dy', '0px');
      }
    };
    apply();
    shift();
    const a = setInterval(apply, 30000);
    const s = setInterval(shift, SHIFT_EVERY);
    return () => { clearInterval(a); clearInterval(s); };
  }, [settings.enabled, settings.hueShift, settings.breathe, settings.pixelShift]);

  // ---- dim stage -> class on <html> ------------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('sg-dim', stage === 'dim');
    root.classList.toggle('sg-saver', stage === 'saver');
    root.classList.toggle('sg-wallpaper', IS_WALLPAPER);
    return () => { root.classList.remove('sg-dim', 'sg-saver'); };
  }, [stage]);

  if (stage !== 'saver') return null;
  return (
    <Screensaver
      fleet={fleet}
      alerts={alerts}
      briefing={briefing}
      onWake={() => { lastInput.current = Date.now(); lastPos.current = null; setStage('awake'); }}
    />
  );
}

function Screensaver({ fleet, alerts, briefing, onWake }) {
  const [now, setNow] = useState(new Date());
  const [pos, setPos] = useState({ x: 30, y: 35 });
  const [visible, setVisible] = useState(true);
  const startPos = useRef(null);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    // Wander: fade out, jump somewhere else, fade in. Every 40 s.
    const wander = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setPos({ x: 5 + Math.random() * 55, y: 8 + Math.random() * 60 });
        setVisible(true);
      }, 1200);
    }, 40000);
    return () => { clearInterval(clock); clearInterval(wander); };
  }, []);

  const printing = fleet.filter((p) => p.state === 'printing' || p.state === 'paused');
  const errors = fleet.filter((p) => p.state === 'error');
  const urgent = alerts.filter((a) => a.severity !== 'info');
  const next = briefing?.next_event;

  return (
    <div
      className="sg-saver-overlay"
      role="button"
      tabIndex={0}
      aria-label="Screensaver. Move the mouse, tap or press a key to wake."
      // Wake on click/tap (not pointerdown) so the tap never lands on a button underneath.
      onClick={onWake}
      onKeyDown={onWake}
      onPointerMove={(e) => {
        if (!startPos.current) { startPos.current = { x: e.clientX, y: e.clientY }; return; }
        if (Math.abs(e.clientX - startPos.current.x) + Math.abs(e.clientY - startPos.current.y) > 40) onWake();
      }}
    >
      <div
        className="sg-saver-block"
        style={{ left: `${pos.x}%`, top: `${pos.y}%`, opacity: visible ? 1 : 0 }}
      >
        <div className="sg-saver-time">
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className="sg-saver-date">
          {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div className="sg-saver-lines">
          {urgent.length > 0 && (
            <div className="sg-saver-alert">⚠ {urgent.length} alert{urgent.length > 1 ? 's' : ''} waiting</div>
          )}
          {errors.map((p) => (
            <div key={p.id} className="sg-saver-alert">✖ {p.name}: error</div>
          ))}
          {printing.map((p) => (
            <div key={p.id}>
              ▸ {p.name} {p.state === 'paused' ? 'paused' : `${Math.round(p.progress_percent || 0)}%`}
              {p.eta_timestamp && p.state === 'printing'
                ? ` · done ${new Date(p.eta_timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </div>
          ))}
          {next && <div>◷ {next.title} @ {next.time}</div>}
          {!printing.length && !urgent.length && !errors.length && !next && <div>All quiet.</div>}
        </div>
      </div>
    </div>
  );
}

export function ScreenGuardSettings({ settings, onChange, onPreview }) {
  const row = 'flex items-center justify-between gap-4 py-2 border-b border-slate-800/80';
  const Toggle = ({ k, label, hint }) => (
    <label className={row}>
      <span>
        <span className="block text-xs font-mono font-bold text-white">{label}</span>
        {hint && <span className="block text-[11px] font-mono text-slate-500">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={!!settings[k]}
        disabled={k !== 'enabled' && !settings.enabled}
        onChange={(e) => onChange({ [k]: e.target.checked })}
        className="w-4 h-4 accent-cyan-400"
      />
    </label>
  );
  const Minutes = ({ k, label, hint, options }) => (
    <label className={row}>
      <span>
        <span className="block text-xs font-mono font-bold text-white">{label}</span>
        {hint && <span className="block text-[11px] font-mono text-slate-500">{hint}</span>}
      </span>
      <select
        value={settings[k]}
        disabled={!settings.enabled}
        onChange={(e) => onChange({ [k]: Number(e.target.value) })}
        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300"
      >
        {options.map((m) => <option key={m} value={m}>{m === 0 ? 'Never' : `${m} min`}</option>)}
      </select>
    </label>
  );
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
        Burn-in protection{IS_WALLPAPER ? ' · wallpaper mode' : ''}
      </h4>
      <p className="text-[11px] font-mono text-slate-400 pb-2">
        Keeps a static HUD from wearing itself into the screen. These settings are saved per device,
        so the drawing display can have different ones to the main monitor.
        {IS_WALLPAPER
          ? ' This is the wallpaper copy of SILAS: it has its own settings, and the screensaver is off by default so the dashboard stays visible.'
          : ' Running SILAS as a desktop wallpaper? Open it as localhost:8000/?wallpaper=1 to get separate wallpaper settings.'}
      </p>
      <Toggle k="enabled" label="Screen guard" hint="Master switch for everything below." />
      <Minutes k="dimMins" label="Deep dim after" hint="Pure black background, HUD dimmed. Any input restores it." options={[2, 3, 5, 8, 10, 15, 20]} />
      <Minutes k="saverMins" label="Screensaver after" hint="Black screen with a dim, wandering clock and printer status." options={[0, 5, 10, 15, 20, 30, 45, 60]} />
      <Toggle k="hueShift" label="Hue drift" hint="Colours slowly drift ±10° and back over 20 minutes. Invisible in use." />
      <Toggle k="breathe" label="Brightness breathing" hint="Very slow 100% → 92% brightness cycle." />
      <Toggle k="pixelShift" label="Pixel shift" hint="Moves the whole layout up to 2 px every 3 minutes." />
      <div className="pt-3 flex items-center gap-3">
        <button type="button" onClick={onPreview} className="hud-btn hud-btn-primary !text-xs !py-1 !px-3">
          Preview screensaver
        </button>
        <span className="text-[11px] font-mono text-slate-500">Tap or move the mouse to wake. A new printer alert wakes it too.</span>
      </div>
    </div>
  );
}
