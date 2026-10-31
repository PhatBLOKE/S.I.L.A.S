import React, { useState } from 'react';

// First-run setup: shown when the backend profile says setup_complete is false, and again
// from the ⋮ menu (YOUR PROFILE) to change details later. Saves to /api/profile, which
// lives in backend/data/config.json (git-ignored, never leaves this PC).
const API_BASE = '/api';

const PRONOUNS = [
  { id: 'he', label: 'He / him' },
  { id: 'she', label: 'She / her' },
];

const STEPS = ['WHO', 'YOU', 'LOOK', 'READY'];

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`hud-btn !px-4 !py-2 font-mono text-[12px] tracking-wider ${on ? 'hud-btn-primary' : ''}`}>
      {children}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="block font-mono text-[11px] tracking-[0.2em] text-slate-400">{label}</span>
      {children}
      {hint && <span className="block font-mono text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

// For button groups: a <label> would forward clicks to the first button, so use a group.
function Group({ label, children }) {
  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      <span className="block font-mono text-[11px] tracking-[0.2em] text-slate-400">{label}</span>
      {children}
    </div>
  );
}

const inputCls = 'w-full bg-slate-950 border border-slate-700 focus:border-cyan-400 outline-none rounded px-3 py-2.5 text-white font-mono text-sm';

export default function Setup({ initial, editing, themes, currentTheme, onTheme, onDone, onCancel }) {
  const [step, setStep] = useState(0);
  const [p, setP] = useState(() => ({
    name: '', call_me: '', pronouns: 'he', about: '', spelling: 'british', units: 'metric',
    lunch_reminder: false, work_folder: '', ...(initial || {}),
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setP((o) => ({ ...o, [k]: v }));
  const callMe = (p.call_me || p.name || '').trim();

  const canNext = step !== 0 || p.name.trim().length > 0;
  const next = () => { if (canNext) { setErr(''); setStep((s) => Math.min(s + 1, STEPS.length - 1)); } else setErr('Pop your name in first.'); };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const finish = async () => {
    if (!p.name.trim()) { setStep(0); setErr('Pop your name in first.'); return; }
    setSaving(true); setErr('');
    try {
      const body = {
        name: p.name, call_me: p.call_me, pronouns: p.pronouns, about: p.about, spelling: p.spelling,
        units: p.units, lunch_reminder: !!p.lunch_reminder, work_folder: p.work_folder, setup_complete: true,
      };
      const res = await fetch(`${API_BASE}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const data = await res.json();
      onDone && onDone(data.profile);
    } catch (e) {
      setErr(`${e.message || e}. Is the SILAS server running?`);
    } finally { setSaving(false); }
  };

  // A short, readable theme list: LCARS plus a handful of the cyberpunk accents.
  const themeChoices = (themes || []).slice(0, 7);

  return (
    <div className="silas-setup fixed inset-0 z-[120] bg-[#03050a] overflow-y-auto" role="dialog" aria-modal="true" aria-label="SILAS setup">
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 sm:p-8">
        <div className="hud-panel w-full max-w-2xl p-5 sm:p-8 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[11px] tracking-[0.3em] text-cyan-400">S.I.L.A.S // {editing ? 'PROFILE' : 'FIRST-RUN SETUP'}</div>
              <h1 className="font-display text-2xl sm:text-3xl text-white mt-1">
                {step === 0 && (editing ? 'Your details' : 'Welcome aboard.')}
                {step === 1 && `How should I help${callMe ? `, ${callMe}` : ''}?`}
                {step === 2 && 'Pick a look'}
                {step === 3 && (editing ? 'Save changes?' : 'Systems ready.')}
              </h1>
            </div>
            {editing && onCancel && (
              <button type="button" onClick={onCancel} className="font-mono text-[12px] underline text-slate-400 hover:text-white">Close</button>
            )}
          </div>

          {/* Step dots */}
          <ol className="flex gap-2" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li key={s} className="flex-1">
                <button type="button" onClick={() => (i <= step || p.name.trim()) && setStep(i)}
                  className={`w-full h-1.5 rounded-full ${i <= step ? 'bg-cyan-400' : 'bg-slate-800'}`} aria-label={`Step ${i + 1}: ${s}`} />
                <span className={`block mt-1 font-mono text-[10px] tracking-[0.2em] ${i === step ? 'text-cyan-300' : 'text-slate-600'}`}>{s}</span>
              </li>
            ))}
          </ol>

          {/* Step bodies */}
          {step === 0 && (
            <div className="space-y-5">
              {!editing && (
                <p className="font-mono text-[13px] text-slate-300 leading-relaxed">
                  I'm Silas, the AI that runs this console: printers, schedule, tasks and the occasional sarcastic remark.
                  Tell me who you are. Everything here stays on this PC.
                </p>
              )}
              <Field label="YOUR NAME">
                <input autoFocus className={inputCls} value={p.name} maxLength={60} placeholder="e.g. Alex Smith"
                  onChange={(e) => set('name', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && next()} />
              </Field>
              <Field label="WHAT SHOULD SILAS CALL YOU?" hint="Optional. Leave blank to use your name.">
                <input className={inputCls} value={p.call_me} maxLength={40} placeholder={p.name.trim().split(' ')[0] || 'e.g. Alex, Boss, Captain'}
                  onChange={(e) => set('call_me', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && next()} />
              </Field>
              <Group label="PRONOUNS">
                <div className="flex flex-wrap gap-2">
                  {PRONOUNS.map((o) => <Chip key={o.id} on={p.pronouns === o.id} onClick={() => set('pronouns', o.id)}>{o.label}</Chip>)}
                </div>
              </Group>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <Field label="ABOUT YOU" hint="Optional. Silas reads this before every answer. Up to 600 characters.">
                <textarea className={`${inputCls} min-h-[110px] resize-y`} value={p.about} maxLength={600}
                  placeholder="e.g. I have ADHD, keep me on one thing at a time. I print on a Voron and a Bambu. Be blunt."
                  onChange={(e) => set('about', e.target.value)} />
              </Field>
              <div className="grid sm:grid-cols-2 gap-5">
                <Group label="SPELLING">
                  <div className="flex flex-wrap gap-2">
                    <Chip on={p.spelling === 'british'} onClick={() => set('spelling', 'british')}>British</Chip>
                    <Chip on={p.spelling === 'american'} onClick={() => set('spelling', 'american')}>American</Chip>
                  </div>
                </Group>
                <Group label="UNITS">
                  <div className="flex flex-wrap gap-2">
                    <Chip on={p.units === 'metric'} onClick={() => set('units', 'metric')}>mm · °C</Chip>
                    <Chip on={p.units === 'imperial'} onClick={() => set('units', 'imperial')}>in · °F</Chip>
                  </div>
                </Group>
              </div>
              <label className="flex items-center gap-3 font-mono text-[13px] text-slate-300 cursor-pointer">
                <input type="checkbox" checked={!!p.lunch_reminder} onChange={(e) => set('lunch_reminder', e.target.checked)} className="w-4 h-4 accent-cyan-400" />
                Nag me to eat something around midday
              </label>
              <Field label="WORK FOLDER" hint="Optional. The folder the Drives tab opens on, e.g. D:\3D Prints\To sort.">
                <input className={inputCls} value={p.work_folder} maxLength={260} placeholder="Leave blank if you don't use the Drives tab"
                  onChange={(e) => set('work_folder', e.target.value)} />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="font-mono text-[13px] text-slate-300">Tap one to try it. You can change it any time in Preferences.</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {themeChoices.map((t) => (
                  <button key={t.id} type="button" onClick={() => onTheme && onTheme(t.id)} aria-pressed={currentTheme === t.id}
                    className={`text-left rounded-lg border-2 p-3 bg-slate-950 ${currentTheme === t.id ? 'border-white' : 'border-slate-800 hover:border-slate-500'}`}>
                    <div className="flex gap-1 mb-2">
                      {t.lcars
                        ? ['#ff9900', '#cc99cc', '#9999ff', '#ffcc99'].map((c) => <span key={c} className="h-4 flex-1 rounded-full" style={{ background: c }} />)
                        : <span className="h-4 flex-1 rounded" style={{ background: t.glow, boxShadow: `0 0 12px ${t.glow}` }} />}
                    </div>
                    <div className="font-mono text-[12px] text-white">{t.name}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 font-mono text-[13px] text-slate-300 leading-relaxed">
              <p>
                {editing ? 'Silas will use these details from now on.' : <>Good to meet you, <span className="text-white">{callMe}</span>. Once you're in, connect the rest:</>}
              </p>
              {!editing && (
                <ul className="space-y-1.5 text-slate-400">
                  <li>▸ <span className="text-slate-200">Printers</span>: + Add Machine (Klipper/Moonraker or OctoPrint)</li>
                  <li>▸ <span className="text-slate-200">Calendar</span>: Sync Google Cal (your private iCal link)</li>
                  <li>▸ <span className="text-slate-200">Tasks</span>: Today tab → Link Todoist</li>
                  <li>▸ <span className="text-slate-200">AI brain</span>: Preferences → API keys (Gemini, Groq, OpenAI…)</li>
                </ul>
              )}
              <p className="text-slate-500 text-[12px]">You can change any of this later from ⋮ → Your profile.</p>
            </div>
          )}

          {err && <div role="alert" className="font-mono text-[12px] text-red-300">{err}</div>}

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <button type="button" onClick={back} disabled={step === 0}
              className="hud-btn !px-4 !py-2 font-mono text-[12px] disabled:opacity-30">◂ BACK</button>
            {step < STEPS.length - 1
              ? <button type="button" onClick={next} className="hud-btn hud-btn-primary !px-6 !py-2 font-mono text-[12px] tracking-wider">NEXT ▸</button>
              : <button type="button" onClick={finish} disabled={saving} className="hud-btn hud-btn-primary !px-6 !py-2 font-mono text-[12px] tracking-wider">
                  {saving ? 'SAVING…' : editing ? 'SAVE' : 'ENGAGE ▸'}
                </button>}
          </div>
        </div>
      </div>
    </div>
  );
}
