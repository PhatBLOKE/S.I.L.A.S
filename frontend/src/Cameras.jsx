import React, { useEffect, useMemo, useState } from 'react';

// Printer cameras: viewer, "find cameras" picker, per-printer manager and a camera wall.
// Backend: POST /api/webcams/discover, cameras stored on each printer as "webcams" (webcams.py).
const API_BASE = '/api';

export const camerasOf = (p) => {
  if (!p) return [];
  if (Array.isArray(p.webcams) && p.webcams.length) return p.webcams;
  return p.webcam_url ? [{ name: 'Camera', stream_url: p.webcam_url, snapshot_url: '', mode: 'mjpeg', rotation: 0 }] : [];
};

const camTransform = (cam) => {
  const parts = [];
  if (cam.rotation) parts.push(`rotate(${cam.rotation}deg)`);
  if (cam.rotation === 90 || cam.rotation === 270) parts.push('scale(0.5625)'); // keep a sideways 16:9 picture inside the frame
  if (cam.flip_h) parts.push('scaleX(-1)');
  if (cam.flip_v) parts.push('scaleY(-1)');
  return parts.join(' ') || undefined;
};

// One camera picture. mjpeg = live stream; snapshot = refreshed still; page = link only.
export function CameraView({ cam, compact = false, refreshMs = 1000 }) {
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const mode = cam.mode || 'mjpeg';
  useEffect(() => { setFailed(false); }, [cam.stream_url, cam.snapshot_url]);
  useEffect(() => {
    if (mode !== 'snapshot') return undefined;
    const t = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(t);
  }, [mode, refreshMs]);

  const openUrl = cam.stream_url || cam.snapshot_url;
  if (mode === 'page') {
    return (
      <div className="w-full h-full grid place-items-center text-center p-4 font-mono text-[12px] text-slate-400">
        <div>
          This camera ({cam.service || 'video'}) can only be watched on the printer's own page.
          <div className="mt-2"><a href={openUrl} target="_blank" rel="noreferrer" className="underline text-cyan-300">Open camera ↗</a></div>
        </div>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="w-full h-full grid place-items-center text-center p-4 font-mono text-[12px] text-red-300">
        <div>
          Camera not answering.{!compact && <> Is the printer on?<div className="mt-2 text-slate-500 break-all">{openUrl}</div></>}
          <div className="mt-2"><button type="button" onClick={() => setFailed(false)} className="underline text-slate-300">Retry</button></div>
        </div>
      </div>
    );
  }
  const src = mode === 'snapshot'
    ? `${cam.snapshot_url}${cam.snapshot_url.includes('?') ? '&' : '?'}_silas=${tick}`
    : cam.stream_url || cam.snapshot_url;
  return (
    <img
      src={src}
      alt={`${cam.name} camera`}
      className="w-full h-full object-contain"
      style={{ transform: camTransform(cam) }}
      onError={() => setFailed(true)}
    />
  );
}

// Viewer for one printer, with a tab per camera.
export function CameraModal({ printer, onClose, onManage }) {
  const cams = camerasOf(printer);
  const [idx, setIdx] = useState(0);
  const cam = cams[Math.min(idx, cams.length - 1)];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content p-4 max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-display font-bold text-sm text-white">LIVE CAMERA // {printer.name}</h3>
          <div className="flex items-center gap-3 font-mono text-xs">
            {onManage && <button type="button" onClick={onManage} className="text-slate-400 hover:text-white underline">Manage cameras</button>}
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">✕ CLOSE</button>
          </div>
        </div>
        {cams.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {cams.map((c, i) => (
              <button key={`${c.name}-${i}`} type="button" onClick={() => setIdx(i)}
                className={`hud-btn !px-3 !py-1 font-mono text-[11px] ${i === idx ? 'hud-btn-primary' : ''}`}>{c.name}</button>
            ))}
          </div>
        )}
        <div className="relative aspect-video silas-cam-frame bg-black rounded overflow-hidden border border-slate-800">
          {cam ? <CameraView key={`${idx}-${cam.stream_url}`} cam={cam} /> : (
            <div className="w-full h-full grid place-items-center font-mono text-xs text-slate-400">No cameras yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Find / add / edit the camera list. Used by the Add Machine form and the camera manager.
export function CameraPicker({ cameras, onChange, discoverBody, canDiscover = true }) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [err, setErr] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const have = useMemo(() => new Set((cameras || []).map((c) => c.stream_url || c.snapshot_url)), [cameras]);

  const find = async () => {
    setBusy(true); setErr(''); setFound(null);
    try {
      const res = await fetch(`${API_BASE}/webcams/discover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discoverBody),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setFound(data.cameras || []);
      // First time: tick everything found.
      if (!(cameras || []).length && data.cameras?.length) onChange(data.cameras);
    } catch (e) {
      setErr(`Couldn't search the printer: ${e.message}`);
    } finally { setBusy(false); }
  };

  const toggle = (cam) => {
    const key = cam.stream_url || cam.snapshot_url;
    onChange(have.has(key) ? cameras.filter((c) => (c.stream_url || c.snapshot_url) !== key) : [...(cameras || []), cam]);
  };
  const update = (i, patch) => onChange(cameras.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i) => onChange(cameras.filter((_, j) => j !== i));
  const addManual = () => {
    const url = manualUrl.trim();
    if (!/^https?:\/\//i.test(url)) { setErr('Camera address must start with http:// or https://'); return; }
    const snapshot = /snapshot|\.jpe?g(\?|$)/i.test(url);
    onChange([...(cameras || []), {
      name: `Camera ${(cameras || []).length + 1}`, stream_url: snapshot ? '' : url, snapshot_url: snapshot ? url : '',
      mode: snapshot ? 'snapshot' : 'mjpeg', rotation: 0, flip_h: false, flip_v: false, source: 'manual',
    }]);
    setManualUrl(''); setErr('');
  };

  return (
    <div className="space-y-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={find} disabled={busy || !canDiscover} className="hud-btn hud-btn-primary !px-3 !py-1.5 text-[11px]">
          {busy ? 'SEARCHING…' : '🔍 FIND CAMERAS ON PRINTER'}
        </button>
        {!canDiscover && <span className="text-slate-500">Fill in the printer address first.</span>}
      </div>
      {err && <div className="text-red-300">{err}</div>}

      {found && (
        <div className="space-y-2">
          <div className="text-slate-400">{found.length ? `Found ${found.length}. Tick the ones you want:` : 'No cameras found on that printer. Add one by address below.'}</div>
          <div className="grid grid-cols-2 gap-2">
            {found.map((c) => {
              const on = have.has(c.stream_url || c.snapshot_url);
              return (
                <button type="button" key={c.stream_url || c.snapshot_url} onClick={() => toggle(c)}
                  className={`silas-cam-pick text-left rounded border-2 p-1.5 bg-slate-950 ${on ? 'border-cyan-400' : 'border-slate-800 opacity-70'}`}>
                  <div className="aspect-video silas-cam-frame bg-black rounded overflow-hidden mb-1"><CameraView cam={c} compact refreshMs={2000} /></div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-white">{on ? '☑' : '☐'} {c.name}</span>
                    <span className="text-[10px] text-slate-500">{c.source === 'found' ? 'found' : c.service || c.mode}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-slate-400">{(cameras || []).length ? 'Cameras on this printer:' : 'No cameras added yet.'}</div>
        {(cameras || []).map((c, i) => (
          <div key={`${c.stream_url || c.snapshot_url}-${i}`} className="silas-cam-row flex flex-wrap items-center gap-2 border border-slate-800 rounded p-2">
            <input value={c.name} maxLength={40} onChange={(e) => update(i, { name: e.target.value })} aria-label="Camera name"
              className="w-32 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white" />
            <span className="flex-1 min-w-[120px] truncate text-slate-500" title={c.stream_url || c.snapshot_url}>{c.stream_url || c.snapshot_url}</span>
            <select value={c.rotation || 0} onChange={(e) => update(i, { rotation: parseInt(e.target.value, 10) })} aria-label="Rotation"
              className="bg-slate-900 border border-slate-700 rounded px-1 py-1 text-white">
              {[0, 90, 180, 270].map((r) => <option key={r} value={r}>{r}°</option>)}
            </select>
            <label className="flex items-center gap-1 text-slate-400"><input type="checkbox" checked={!!c.flip_h} onChange={(e) => update(i, { flip_h: e.target.checked })} />flip ↔</label>
            <label className="flex items-center gap-1 text-slate-400"><input type="checkbox" checked={!!c.flip_v} onChange={(e) => update(i, { flip_v: e.target.checked })} />flip ↕</label>
            <button type="button" onClick={() => remove(i)} className="text-red-300 hover:text-red-200 px-1" aria-label={`Remove ${c.name}`}>✕</button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} placeholder="Or paste a camera address: http://192.168.1.50/webcam/?action=stream"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
          className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-white" />
        <button type="button" onClick={addManual} className="hud-btn !px-3 text-[11px]">+ ADD</button>
      </div>
    </div>
  );
}

// Manage the cameras of a printer that already exists.
export function CameraManager({ printer, onClose, onSaved }) {
  const [config, setConfig] = useState(null);
  const [cams, setCams] = useState(() => camerasOf(printer));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`${API_BASE}/printers`).then((r) => r.json()).then((list) => {
      const cfg = (list || []).find((p) => p.id === printer.id);
      setConfig(cfg || null);
      if (cfg && Array.isArray(cfg.webcams)) setCams(cfg.webcams);
    }).catch(() => setErr("Couldn't load this printer's settings."));
  }, [printer.id]);

  const save = async () => {
    if (!config) return;
    setSaving(true); setErr('');
    try {
      const res = await fetch(`${API_BASE}/printers/${encodeURIComponent(printer.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, webcams: cams }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved && onSaved();
      onClose();
    } catch (e) { setErr(`Save failed: ${e.message}`); } finally { setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-sm text-white">📷 CAMERAS // {printer.name}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white font-mono text-xs">✕ CLOSE</button>
        </div>
        <CameraPicker cameras={cams} onChange={setCams} discoverBody={{ printer_id: printer.id }} canDiscover={!!config} />
        {err && <div className="mt-3 font-mono text-xs text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="hud-btn !px-4 text-xs">Cancel</button>
          <button type="button" onClick={save} disabled={saving || !config} className="hud-btn hud-btn-primary !px-4 text-xs">{saving ? 'SAVING…' : 'SAVE CAMERAS'}</button>
        </div>
      </div>
    </div>
  );
}

// Every camera from every printer at once.
export function CameraWall({ printers, onClose, onOpen }) {
  const tiles = [];
  (printers || []).forEach((p) => camerasOf(p).forEach((cam, i) => tiles.push({ p, cam, key: `${p.id}-${i}` })));
  return (
    <div className="fixed inset-0 z-[90] bg-black/95 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Camera wall">
      <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg tracking-wider text-white">📹 CAMERA WALL <span className="text-slate-500 text-sm">({tiles.length})</span></h2>
          <button type="button" onClick={onClose} className="hud-btn !px-4 text-xs">✕ CLOSE</button>
        </div>
        {tiles.length === 0 ? (
          <div className="font-mono text-sm text-slate-400">No cameras yet. Use 📷 on a printer card on the Fleet tab to find them.</div>
        ) : (
          <div className={`grid gap-4 ${tiles.length === 1 ? 'grid-cols-1 max-w-4xl' : tiles.length <= 4 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'}`}>
            {tiles.map(({ p, cam, key }) => (
              <button type="button" key={key} onClick={() => onOpen && onOpen(p)} className="text-left">
                <div className="aspect-video silas-cam-frame bg-black rounded overflow-hidden border border-slate-800"><CameraView cam={cam} compact /></div>
                <div className="mt-1 font-mono text-xs text-slate-300 flex justify-between gap-2">
                  <span className="truncate">{p.name} · {cam.name}</span>
                  <span className={p.state === 'printing' ? 'text-emerald-300' : 'text-slate-500'}>{(p.state || '').toUpperCase()}{p.state === 'printing' && p.progress_percent != null ? ` ${Math.round(p.progress_percent)}%` : ''}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
