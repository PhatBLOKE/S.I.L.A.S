import React, { useEffect, useState } from 'react';

const API = '/api/ai-usage';

const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const fmtCountdown = (secs) => {
  if (secs <= 0) return 'any second now';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
};

const fmtClock = (epoch) =>
  new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ago = (epoch) => {
  if (!epoch) return 'never';
  const s = Math.max(0, Date.now() / 1000 - epoch);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const QUICK_RESETS = [
  { label: '1h', mins: 60 },
  { label: '2h', mins: 120 },
  { label: '5h', mins: 300 },
  { label: '1 day', mins: 1440 },
  { label: '1 week', mins: 10080 },
];

export default function AIUsage() {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [limitFor, setLimitFor] = useState(null); // service id whose "hit limit" picker is open
  const [customTime, setCustomTime] = useState('');
  const [editing, setEditing] = useState(null); // service being added/edited
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await fetch(API);
      if (res.ok) setData(await res.json());
    } catch (e) {}
  };

  useEffect(() => {
    load();
    const poll = setInterval(load, 15000);
    const clock = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, []);

  const post = async (url, body, method = 'POST') => {
    setError('');
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.detail || `Request failed (${res.status})`);
      }
    } catch (e) {
      setError(e.message);
    }
    load();
  };

  const markLimited = (id, mins) => {
    post(`${API}/services/${id}/limited`, { reset_in_minutes: mins });
    setLimitFor(null);
  };

  const markLimitedAt = (id) => {
    if (!customTime) return;
    // "21:30" -> today at 21:30 (or tomorrow if that's already passed)
    const [hh, mm] = customTime.split(':').map(Number);
    const t = new Date();
    t.setHours(hh, mm, 0, 0);
    if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(hh)}:${pad(mm)}`;
    post(`${API}/services/${id}/limited`, { reset_at: iso });
    setLimitFor(null);
    setCustomTime('');
  };

  if (!data) {
    return <div className="hud-panel p-6 font-mono text-sm text-slate-400">Loading AI usage…</div>;
  }

  const services = data.services || [];
  const providers = data.providers || [];
  const days = data.daily_tokens || [];
  const maxDay = Math.max(1, ...days.map((d) => d.tokens));
  const limitedCount = services.filter((s) => s.status === 'limited').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="hud-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm tracking-wider text-cyan-300">AI USAGE // ALL CONSTRUCTS</h2>
            <p className="font-mono text-[11px] text-slate-400 mt-1">
              {limitedCount
                ? `${limitedCount} of ${services.length} AI apps locked out. SILAS will ping you when each one is back.`
                : `All ${services.length} AI apps ready. Spend wisely, meatbag.`}
            </p>
          </div>
          <button
            onClick={() => setEditing({ id: null, name: '', url: '', icon: '🤖', notes: '' })}
            className="hud-btn hud-btn-primary text-xs py-1.5 px-3"
          >
            + Add AI app
          </button>
        </div>
        {error && <div className="mt-2 font-mono text-[11px] text-red-400">{error}</div>}
      </div>

      {/* Service cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {services.map((s) => {
          const limited = s.status === 'limited';
          const left = limited && s.reset_at ? s.reset_at - now : null;
          return (
            <div
              key={s.id}
              className={`hud-panel p-4 flex flex-col gap-3 ${limited ? 'border-amber-500/60' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-bold text-white text-sm truncate">
                    <span className="mr-1.5">{s.icon || '🤖'}</span>{s.name}
                  </div>
                  {s.notes && <div className="font-mono text-[10px] text-slate-500 mt-0.5">{s.notes}</div>}
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                    limited
                      ? 'bg-amber-950/60 border-amber-600 text-amber-300'
                      : 'bg-emerald-950/50 border-emerald-700 text-emerald-300'
                  }`}
                >
                  {limited ? '⏳ LIMITED' : '✓ READY'}
                </span>
              </div>

              {limited ? (
                <div className="font-mono">
                  {s.reset_at ? (
                    <>
                      <div className="text-2xl font-bold text-amber-200 tabular-nums">{fmtCountdown(left)}</div>
                      <div className="text-[11px] text-slate-400">back at {fmtClock(s.reset_at)}</div>
                    </>
                  ) : (
                    <div className="text-sm text-amber-200">Reset time unknown</div>
                  )}
                </div>
              ) : (
                <div className="font-mono text-[11px] text-slate-400">
                  {s.limits_7d ? `Hit its limit ${s.limits_7d}× in the last 7 days.` : 'No limits hit in the last 7 days.'}
                </div>
              )}

              {limitFor === s.id && (
                <div className="p-2 rounded border border-slate-700 bg-slate-950/70 font-mono text-[11px] space-y-2">
                  <div className="text-slate-400">Resets in…</div>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_RESETS.map((q) => (
                      <button key={q.label} onClick={() => markLimited(s.id, q.mins)} className="hud-btn !text-[11px] !py-0.5 !px-2">
                        {q.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400">or at</span>
                    <input
                      type="time"
                      value={customTime}
                      onChange={(e) => setCustomTime(e.target.value)}
                      className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-cyan-200"
                    />
                    <button onClick={() => markLimitedAt(s.id)} className="hud-btn hud-btn-primary !text-[11px] !py-0.5 !px-2">Set</button>
                    <button onClick={() => markLimited(s.id, null)} className="underline text-slate-400 ml-auto">Don't know</button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-auto font-mono text-[11px]">
                {limited ? (
                  <button onClick={() => post(`${API}/services/${s.id}/ready`)} className="hud-btn hud-btn-primary !text-[11px] !py-1 !px-2.5">
                    It's back
                  </button>
                ) : (
                  <button
                    onClick={() => setLimitFor(limitFor === s.id ? null : s.id)}
                    className="hud-btn !text-[11px] !py-1 !px-2.5 text-amber-300 border-amber-800"
                  >
                    Hit limit
                  </button>
                )}
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" className="hud-btn !text-[11px] !py-1 !px-2.5">
                    Usage page ↗
                  </a>
                )}
                <button onClick={() => setEditing({ ...s })} className="ml-auto underline text-slate-500 hover:text-slate-300">
                  edit
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* SILAS's own metered AI calls */}
      <div className="hud-panel p-4">
        <h3 className="font-display text-xs tracking-wider text-slate-300 mb-1">SILAS'S OWN AI CALLS (METERED)</h3>
        <p className="font-mono text-[11px] text-slate-500 mb-4">
          Exact token counts and rate limits from every reply SILAS gets from Gemini, Groq, OpenAI, Skippy…
        </p>

        {providers.length === 0 ? (
          <div className="font-mono text-xs text-slate-500">No AI calls yet. Ask Silas something and it'll show up here.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 7-day token bars: one series, one hue */}
            <figure className="lg:col-span-1">
              <figcaption className="font-mono text-[11px] text-slate-400 mb-2">Tokens per day, last 7 days</figcaption>
              <div className="flex items-end gap-2 h-32 border-b border-slate-700 pb-0">
                {days.map((d, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                    <div
                      className="w-full max-w-[28px] rounded-t bg-cyan-400/80 group-hover:bg-cyan-300"
                      style={{ height: `${d.tokens ? Math.max(3, (d.tokens / maxDay) * 100) : 0}%` }}
                      title={`${d.day}: ${d.tokens.toLocaleString()} tokens`}
                    />
                    <span className="pointer-events-none absolute -top-5 hidden group-hover:block font-mono text-[10px] text-slate-200 bg-slate-900 border border-slate-700 rounded px-1">
                      {fmtTokens(d.tokens)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-1">
                {days.map((d, i) => (
                  <span key={i} className="flex-1 text-center font-mono text-[10px] text-slate-500">{d.day}</span>
                ))}
              </div>
            </figure>

            {/* Per-provider table */}
            <div className="lg:col-span-2 overflow-x-auto">
              <table className="w-full font-mono text-[11px] text-slate-300">
                <thead>
                  <tr className="text-slate-500 text-left border-b border-slate-800">
                    <th className="py-1.5 pr-3 font-normal">Provider</th>
                    <th className="py-1.5 pr-3 font-normal text-right">Today</th>
                    <th className="py-1.5 pr-3 font-normal text-right">7 days</th>
                    <th className="py-1.5 pr-3 font-normal">Rate limit left</th>
                    <th className="py-1.5 font-normal">Last call</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => {
                    const rl = p.ratelimit || {};
                    const rem = Number(rl.remaining_requests);
                    const lim = Number(rl.limit_requests);
                    const pct = lim > 0 && !Number.isNaN(rem) ? Math.max(0, Math.min(1, rem / lim)) : null;
                    const recent429 = rl.last_429 && now - rl.last_429 < 3600;
                    return (
                      <tr key={p.provider} className="border-b border-slate-800/60 align-top">
                        <td className="py-2 pr-3 text-white uppercase">
                          {p.provider}
                          {p.last_model && <div className="text-[10px] text-slate-500 normal-case">{p.last_model}</div>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtTokens(p.tokens_today)} tok
                          <div className="text-[10px] text-slate-500">{p.calls_today} calls</div>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {fmtTokens(p.tokens_7d)} tok
                          <div className="text-[10px] text-slate-500">
                            {p.calls_7d} calls{p.errors_7d ? ` • ${p.errors_7d} failed` : ''}
                          </div>
                        </td>
                        <td className="py-2 pr-3 min-w-[140px]">
                          {pct !== null ? (
                            <>
                              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                                <div className="h-full rounded-full bg-cyan-400" style={{ width: `${pct * 100}%` }} />
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {rem}/{lim} requests
                                {rl.remaining_tokens ? ` • ${fmtTokens(Number(rl.remaining_tokens))} tok` : ''}
                                {rl.reset_requests ? ` • resets ${rl.reset_requests}` : ''}
                              </div>
                            </>
                          ) : (
                            <span className="text-[10px] text-slate-500">provider doesn't report it</span>
                          )}
                          {recent429 && <div className="text-[10px] text-amber-300 mt-0.5">⚠ hit a rate limit {ago(rl.last_429)}</div>}
                        </td>
                        <td className="py-2 text-slate-400">{ago(p.last_call)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Add / edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <form
            className="hud-panel w-full max-w-md p-4 space-y-3 font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              post(`${API}/services`, editing);
              setEditing(null);
            }}
          >
            <h3 className="font-display text-sm text-cyan-300">{editing.id ? 'Edit AI app' : 'Add AI app'}</h3>
            <div className="flex gap-2">
              <input value={editing.icon} onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                className="w-12 bg-slate-900 border border-slate-700 rounded p-2 text-center" aria-label="Icon" />
              <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Name (e.g. Perplexity)" className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-white" />
            </div>
            <input value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })}
              placeholder="Usage / account page URL (optional)" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white" />
            <input value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              placeholder="Notes, e.g. plan or how its limit works" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white" />
            <div className="flex items-center gap-2">
              {editing.id && (
                <button type="button" className="text-red-400 underline"
                  onClick={() => { post(`${API}/services/${editing.id}`, null, 'DELETE'); setEditing(null); }}>
                  Remove
                </button>
              )}
              <button type="button" onClick={() => setEditing(null)} className="hud-btn ml-auto !text-xs !py-1 !px-3">Cancel</button>
              <button type="submit" className="hud-btn hud-btn-primary !text-xs !py-1 !px-3">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
