import React, { useState, useEffect, useRef } from 'react';
import DrivesManager from './DrivesManager';
import AIUsage from './AIUsage';
import TodoBoard, { FocusStrip } from './Todo';
import LearnBoard, { PomodoroPill } from './Learn';
import ScreenGuard, { useScreenGuardSettings, ScreenGuardSettings } from './ScreenGuard';

const API_BASE = '/api';
const KEY_MASK = '\u2022';
const CLEAR_KEY = '__CLEAR__';

// API keys live on the server only. Never persist them in browser storage.
const stripKeys = (cfg) => {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const { api_key, provider_keys, keys_set, ...rest } = cfg;
  return rest;
};
const persistAiPrefs = (cfg) => {
  try {
    localStorage.setItem('havoc_ai_config', JSON.stringify(stripKeys(cfg)));
  } catch (e) {}
};
// ---- Printer alert helpers -------------------------------------------------
// Two sound styles, both pure Web Audio (no files):
//   'starship' (default) - console chirps and a red-alert style rising whoop
//   'classic'            - the original square-wave beeps and wailing siren
let alarmCtx = null;
const SOUND_STYLE_KEY = 'silas_alarm_style';
const getSoundStyle = () => {
  try { return localStorage.getItem(SOUND_STYLE_KEY) === 'classic' ? 'classic' : 'starship'; } catch (e) { return 'starship'; }
};
const getAudio = () => {
  alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (alarmCtx.state === 'suspended') alarmCtx.resume().catch(() => {});
  return alarmCtx;
};

// One console chirp: a short sine blip that glides between two pitches.
const chirp = (ctx, t, f1, f2, len = 0.11, vol = 0.14) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f1, t);
  osc.frequency.exponentialRampToValueAtTime(f2, t + len);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
};

// One red-alert whoop: two detuned brassy oscillators sweeping upwards.
const whoop = (ctx, t, vol = 0.22, len = 0.5) => {
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2200;
  tone.Q.value = 3;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.04);
  gain.gain.setValueAtTime(vol, t + len - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  tone.connect(gain).connect(ctx.destination);
  [['square', 0], ['sawtooth', 7]].forEach(([type, detune]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(330, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + len);
    osc.connect(tone);
    osc.start(t);
    osc.stop(t + len + 0.02);
  });
};

const playAlarm = (severity) => {
  // Short alert sound. Browsers only allow sound after the page has had a click,
  // which the Edge app window always has.
  try {
    const ctx = getAudio();
    const now = ctx.currentTime;
    if (getSoundStyle() === 'starship') {
      if (severity === 'critical') { whoop(ctx, now, 0.18); whoop(ctx, now + 0.75, 0.18); }
      else if (severity === 'info') { chirp(ctx, now, 1200, 1500); chirp(ctx, now + 0.13, 1500, 1900); }
      else { chirp(ctx, now, 880, 660, 0.16); chirp(ctx, now + 0.2, 880, 660, 0.16); chirp(ctx, now + 0.4, 1100, 880, 0.2); }
      return;
    }
    const pattern = severity === 'critical' ? [880, 660, 880, 660, 880, 660] : severity === 'info' ? [660, 880, 1320] : [740, 990];
    pattern.forEach((freq, i) => {
      const t = now + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
  } catch (e) {}
};

// ---- Siren -------------------------------------------------------------------
// Loud alarm for "your print has stopped" alerts. Keeps going until every siren alert
// is acknowledged or silenced. Built only from free-running oscillators (no timers),
// so it keeps sounding even when the window is in the background.
const SIREN_VOLUME = 0.5;
let sirenNodes = null;

// Classic: a sawtooth swept 500-1400 Hz by a slow LFO.
const buildClassicSiren = (ctx, out) => {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 950;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 0.45;
  const depth = ctx.createGain();
  depth.gain.value = 450;
  lfo.connect(depth).connect(osc.frequency);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200;
  osc.connect(tone).connect(out);
  osc.start();
  lfo.start();
  return [osc, lfo];
};

// Starship: a rising whoop about once a second with a gap between pulses.
// A rising-sawtooth LFO sweeps the pitch upwards each cycle; a square LFO in step
// with it gates the sound on for the half of each cycle where the pitch climbs 350-700 Hz.
const STARSHIP_RATE = 1.05; // whoops per second
const buildStarshipSiren = (ctx, out) => {
  const sweep = ctx.createOscillator();
  sweep.type = 'sawtooth';
  sweep.frequency.value = STARSHIP_RATE;
  const sweepDepth = ctx.createGain();
  sweepDepth.gain.value = 350;
  sweep.connect(sweepDepth);

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2200;
  tone.Q.value = 3;
  const voices = [['square', 0], ['sawtooth', 7]].map(([type, detune]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = 350; // the sweep adds 0..+350 Hz while the gate is open
    osc.detune.value = detune;
    sweepDepth.connect(osc.frequency);
    osc.connect(tone);
    return osc;
  });

  // Gate: 0.5 + 0.5 * square -> 1 for the first half of each cycle, 0 for the second,
  // smoothed so the edges don't click.
  const gate = ctx.createGain();
  gate.gain.value = 0.5;
  const gateLfo = ctx.createOscillator();
  gateLfo.type = 'square';
  gateLfo.frequency.value = STARSHIP_RATE;
  const gateDepth = ctx.createGain();
  gateDepth.gain.value = 0.5;
  const smooth = ctx.createBiquadFilter();
  smooth.type = 'lowpass';
  smooth.frequency.value = 40;
  gateLfo.connect(gateDepth).connect(smooth).connect(gate.gain);
  const trim = ctx.createGain();
  trim.gain.value = 0.6; // two voices through a resonant filter: keep peaks below clipping
  tone.connect(trim).connect(gate).connect(out);

  // Start the two LFOs on the same tick so the gate stays in step with the sweep.
  const t = ctx.currentTime + 0.02;
  sweep.start(t);
  gateLfo.start(t);
  voices.forEach((v) => v.start(t));
  return [sweep, gateLfo, ...voices];
};

const startSiren = () => {
  if (sirenNodes) return;
  try {
    const ctx = getAudio();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(speaking ? 0.08 : SIREN_VOLUME, ctx.currentTime + 0.3);
    gain.connect(ctx.destination);
    const oscs = getSoundStyle() === 'starship' ? buildStarshipSiren(ctx, gain) : buildClassicSiren(ctx, gain);
    sirenNodes = { oscs, gain };
  } catch (e) { sirenNodes = null; }
};
const stopSiren = () => {
  if (!sirenNodes) return;
  const { oscs, gain } = sirenNodes;
  sirenNodes = null;
  try {
    const t = alarmCtx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0002), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    oscs.forEach((o) => o.stop(t + 0.2));
  } catch (e) {}
};

// ---- Voice alerts ------------------------------------------------------------
// After the alert sound, the browser's built-in text-to-speech reads the problem out
// ("Red alert. Snapmaker U1: Print stopped. ..."). Works offline with the voices
// Windows already has; prefers a British "Natural" voice when one is installed.
const VOICE_KEY = 'silas_alarm_voice';
const getVoiceOn = () => { try { return localStorage.getItem(VOICE_KEY) !== 'off'; } catch (e) { return true; } };
let pickedVoice = null;
let speaking = false;
const pickVoice = () => {
  const vs = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  if (!vs.length) return null;
  const score = (v) => (v.lang === 'en-GB' ? 4 : /^en/i.test(v.lang || '') ? 2 : 0)
    + (/natural|online/i.test(v.name) ? 2 : 0)
    + (/female|libby|sonia|maisie|hazel|susan|aria|jenny|zira/i.test(v.name) ? 1 : 0);
  return [...vs].sort((a, b) => score(b) - score(a))[0];
};
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.addEventListener?.('voiceschanged', () => { pickedVoice = pickVoice(); });
}
// Keep spoken text short: drop raw error codes, stop at a sentence end.
const tidySpeech = (t, max = 160) => {
  let s = String(t || '').replace(/\b\d{4}-\d{4}-\d{4}-\d{4}\b/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const dot = cut.lastIndexOf('. ');
    s = dot > 60 ? cut.slice(0, dot + 1) : cut.replace(/\s\S*$/, '') + '.';
  }
  return s;
};
// Turn the siren down while the computer is talking, then back up.
const duckSiren = (on) => {
  speaking = on;
  if (!sirenNodes || !alarmCtx) return;
  try {
    const g = sirenNodes.gain.gain, t = alarmCtx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0002), t);
    g.exponentialRampToValueAtTime(on ? 0.08 : SIREN_VOLUME, t + 0.2);
  } catch (e) {}
};
const speak = (text, delayMs = 0) => {
  const synth = window.speechSynthesis;
  if (!synth || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  pickedVoice = pickedVoice || pickVoice();
  if (pickedVoice) { u.voice = pickedVoice; u.lang = pickedVoice.lang; } else u.lang = 'en-GB';
  u.rate = 0.95;
  u.pitch = 1;
  u.onstart = () => duckSiren(true);
  u.onend = u.onerror = () => duckSiren(false);
  setTimeout(() => { synth.cancel(); synth.speak(u); }, delayMs);
};
const describeAlerts = (alerts, worst) => {
  const lead = worst === 'critical' ? 'Red alert.' : worst === 'info' ? 'Attention.' : 'Warning.';
  const parts = alerts.slice(0, 3).map((a) => {
    const title = tidySpeech(a.title, 80).replace(/[.!?]+$/, '');
    const msg = tidySpeech(a.message);
    return `${a.printer_name || 'SILAS'}: ${title}.${msg && msg !== title ? ' ' + msg : ''}`;
  });
  if (alerts.length > 3) parts.push(`Plus ${alerts.length - 3} more in the alert log.`);
  return `${lead} ${parts.join(' ')}`;
};

const timeAgo = (epochSec) => {
  if (!epochSec) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 - epochSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const ALERT_STYLES = {
  critical: { box: 'bg-red-950/90 border-red-500 text-red-100', badge: 'bg-red-600 text-white', icon: '🚨' },
  warning: { box: 'bg-amber-950/90 border-amber-500 text-amber-100', badge: 'bg-amber-500 text-black', icon: '⚠️' },
  info: { box: 'bg-sky-950/90 border-sky-500 text-sky-100', badge: 'bg-sky-500 text-black', icon: 'ℹ️' },
};

// Typing into a masked field should replace the mask, not append to it.
const unmaskInput = (val) => (val && val.includes(KEY_MASK) ? val.split(KEY_MASK).join('') : val);

// ==========================================
// SILAS CUSTOMIZATION MATRIX: THEMES & FONTS
// ==========================================
const THEMES = [
  {
    // Full LCARS-style console: switches on the html.theme-lcars frame in index.css
    id: 'lcars',
    name: 'Starship Ops (LCARS)',
    glow: '#ff9900',
    dim: '#cc6600',
    rgb: '255, 153, 0',
    borderBright: 'rgba(255, 153, 0, 0.6)',
    borderDim: 'rgba(204, 153, 204, 0.3)',
    desc: 'LCARS-style console: elbow frame, pill keys, pastel blocks',
    lcars: true
  },
  {
    id: 'cyan',
    name: 'Cyber Cyan',
    glow: '#00f2fe',
    dim: '#0284c7',
    rgb: '0, 242, 254',
    borderBright: 'rgba(0, 242, 254, 0.45)',
    borderDim: 'rgba(0, 242, 254, 0.18)',
    desc: 'Classic Jarvis HUD'
  },
  {
    id: 'green',
    name: 'Matrix Emerald',
    glow: '#10b981',
    dim: '#059669',
    rgb: '16, 185, 129',
    borderBright: 'rgba(16, 185, 129, 0.45)',
    borderDim: 'rgba(16, 185, 129, 0.18)',
    desc: 'Phosphor green terminal'
  },
  {
    id: 'amber',
    name: 'Cyberpunk Gold',
    glow: '#f59e0b',
    dim: '#d97706',
    rgb: '245, 158, 11',
    borderBright: 'rgba(245, 158, 11, 0.45)',
    borderDim: 'rgba(245, 158, 11, 0.18)',
    desc: 'Industrial warning amber'
  },
  {
    id: 'purple',
    name: 'Synthwave Purple',
    glow: '#c084fc',
    dim: '#9333ea',
    rgb: '192, 132, 252',
    borderBright: 'rgba(192, 132, 252, 0.45)',
    borderDim: 'rgba(192, 132, 252, 0.18)',
    desc: 'Retro cyber neon violet'
  },
  {
    id: 'red',
    name: 'Crimson Hazard',
    glow: '#f43f5e',
    dim: '#e11d48',
    rgb: '244, 63, 94',
    borderBright: 'rgba(244, 63, 94, 0.45)',
    borderDim: 'rgba(244, 63, 94, 0.18)',
    desc: 'Red alert combat telemetry'
  },
  {
    id: 'pink',
    name: 'Hot Magenta',
    glow: '#f472b6',
    dim: '#db2777',
    rgb: '244, 114, 182',
    borderBright: 'rgba(244, 114, 182, 0.45)',
    borderDim: 'rgba(244, 114, 182, 0.18)',
    desc: 'Tokyo night magenta'
  },
  {
    id: 'orange',
    name: 'Solar Flare',
    glow: '#fb923c',
    dim: '#ea580c',
    rgb: '251, 146, 60',
    borderBright: 'rgba(251, 146, 60, 0.45)',
    borderDim: 'rgba(251, 146, 60, 0.18)',
    desc: 'High-energy plasma glow'
  },
  {
    id: 'blue',
    name: 'Cryo Cobalt',
    glow: '#38bdf8',
    dim: '#0369a1',
    rgb: '56, 189, 248',
    borderBright: 'rgba(56, 189, 248, 0.45)',
    borderDim: 'rgba(56, 189, 248, 0.18)',
    desc: 'Sub-zero military optic'
  }
];

const FONTS = [
  // Google Webfonts (instant render)
  { id: 'Orbitron', name: 'Orbitron', type: 'Google Webfont', stack: "'Orbitron', -apple-system, sans-serif", preview: 'SILAS FLEET // COMMAND' },
  { id: 'Rajdhani', name: 'Rajdhani', type: 'Google Webfont', stack: "'Rajdhani', sans-serif", preview: 'TACTICAL TELEMETRY // 220°C' },
  { id: 'Oxanium', name: 'Oxanium', type: 'Google Webfont', stack: "'Oxanium', sans-serif", preview: 'ANGULAR HARDWARE V1.1' },
  { id: 'Chakra Petch', name: 'Chakra Petch', type: 'Google Webfont', stack: "'Chakra Petch', sans-serif", preview: 'MECHA KINETICS ACTIVE' },
  { id: 'Michroma', name: 'Michroma', type: 'Google Webfont', stack: "'Michroma', sans-serif", preview: 'WIDE HORIZON DISPLAY' },
  { id: 'Space Grotesk', name: 'Space Grotesk', type: 'Google Webfont', stack: "'Space Grotesk', sans-serif", preview: 'BRUTALIST PROTOCOL' },
  { id: 'Share Tech Mono', name: 'Share Tech Mono', type: 'Google Webfont', stack: "'Share Tech Mono', monospace", preview: 'BUFFER 30M // CLEAR' },
  { id: 'Syne', name: 'Syne', type: 'Google Webfont', stack: "'Syne', sans-serif", preview: 'AVANT-GARDE INTELLIGENCE' },

  // Karl's Curated Local Fonts
  { id: 'Perfect Dark', name: 'Perfect Dark BRK', type: 'Local Font (public/fonts)', stack: "'Perfect Dark', 'Orbitron', sans-serif", preview: 'AGENT COMBAT READY' },
  { id: 'Zero Hour', name: 'Zero Hour', type: 'Local Font (public/fonts)', stack: "'Zero Hour', 'Chakra Petch', sans-serif", preview: 'COUNTDOWN INITIALIZED' },
  { id: 'Univox', name: 'Univox', type: 'Local Font (public/fonts)', stack: "'Univox', 'Michroma', sans-serif", preview: 'ULTRA-WIDE FUTURE DISPLAY' },
  { id: 'Bladeline', name: 'Bladeline', type: 'Local Font (public/fonts)', stack: "'Bladeline', 'Rajdhani', sans-serif", preview: 'SHARP CYBERNETIC EDGE' },
  { id: 'Ailerons', name: 'Ailerons Typeface', type: 'Local Font (public/fonts)', stack: "'Ailerons', 'Orbitron', sans-serif", preview: 'AEROSPACE GEOMETRIC' },
  { id: 'Futurepolis', name: 'Futurepolis 3000', type: 'Local Font (public/fonts)', stack: "'Futurepolis', 'Chakra Petch', sans-serif", preview: 'METROPOLIS ARCHITECTURE' },
  { id: 'Anurati', name: 'ANURATI', type: 'Local Font (public/fonts)', stack: "'Anurati', 'Orbitron', sans-serif", preview: 'MINIMAL FUTURISTIC CUTS' },
  { id: 'Osiris', name: 'Osiris Decorative', type: 'Local Font (public/fonts)', stack: "'Osiris', 'Space Grotesk', sans-serif", preview: 'DECORATIVE SPACE AGE' },
  { id: 'NuMono', name: 'NuMono Dystopian', type: 'Local Font (public/fonts)', stack: "'NuMono', 'Share Tech Mono', monospace", preview: 'DYSTOPIAN CODING MONO' },
  { id: 'Bios', name: 'Bios Typeface', type: 'Local Font (public/fonts)', stack: "'Bios', 'Oxanium', sans-serif", preview: 'FIRMWARE OPERATIONAL' },
  { id: 'Wraith', name: 'Wraith Cyberpunk', type: 'Local Font (public/fonts)', stack: "'Wraith', 'Syne', sans-serif", preview: 'WIDE CYBERPUNK DRIFT' },
  { id: 'YKAR', name: 'YKAR Decorative', type: 'Local Font (public/fonts)', stack: "'YKAR', 'Orbitron', sans-serif", preview: 'EXPERIMENTAL TYPOGRAPHY' },
];

const DEFAULT_PANEL_ORDER = [
  { id: 'ai', name: 'Silas AI Co-Pilot Console', icon: '🤖', enabled: true, desc: 'Interactive LLM chat, instant diagnostics & TARS humor slider' },
  { id: 'intel', name: 'Executive Intelligence Banner', icon: '⚡', enabled: true, desc: 'Operational briefing, PA radar buffer assessment & collision alerts' },
  { id: 'fleet', name: 'Active Fleet Telemetry', icon: '🖨️', enabled: true, desc: 'Live extruder/bed temperatures, print progress bars & toolhead status' },
  { id: 'schedule', name: 'Executive Agenda & Schedule', icon: '📅', enabled: true, desc: 'Upcoming calendar engagements synced with iCal' },
];

export default function App() {
  const getInitialTab = () => {
    try {
      const hash = window.location.hash.replace('#', '');
      if (['mission', 'todo', 'fleet', 'learn', 'calendar', 'ai', 'mobile', 'drives', 'usage'].includes(hash)) return hash;
      const saved = localStorage.getItem('havoc_active_tab');
      if (saved && ['mission', 'todo', 'fleet', 'learn', 'calendar', 'ai', 'mobile', 'drives', 'usage'].includes(saved)) return saved;
    } catch (e) {}
    return 'mission';
  };

  const [activeTab, setActiveTabState] = useState(getInitialTab);

  const setActiveTab = (tab) => {
    setActiveTabState(tab);
    try {
      localStorage.setItem('havoc_active_tab', tab);
      if (window.location.hash.replace('#', '') !== tab) {
        window.location.hash = tab;
      }
    } catch (e) {}
  };
  const [systemInfo, setSystemInfo] = useState({ local_ip: '127.0.0.1', mobile_url: '' });
  const [briefing, setBriefing] = useState(null);
  const [fleet, setFleet] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [previewModalImg, setPreviewModalImg] = useState(null);

  // Printer Visibility Filter States
  const [hideOfflinePrinters, setHideOfflinePrinters] = useState(() => {
    try {
      return localStorage.getItem('havoc_hide_offline_printers') === 'true';
    } catch (e) {
      return false;
    }
  });

  const [hiddenPrinterIds, setHiddenPrinterIds] = useState(() => {
    try {
      const saved = localStorage.getItem('havoc_manually_hidden_printers');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const toggleHideOffline = () => {
    setHideOfflinePrinters(prev => {
      const next = !prev;
      try {
        localStorage.setItem('havoc_hide_offline_printers', String(next));
      } catch (e) {}
      return next;
    });
  };

  const toggleManualHidePrinter = (printerId) => {
    setHiddenPrinterIds(prev => {
      const next = prev.includes(printerId)
        ? prev.filter(id => id !== printerId)
        : [...prev, printerId];
      try {
        localStorage.setItem('havoc_manually_hidden_printers', JSON.stringify(next));
      } catch (e) {}
      return next;
    });
  };

  const isPrinterWorking = (p) => {
    if (!p) return false;
    if (p.online === false) return false;
    const s = (p.state || '').toLowerCase();
    if (['offline', 'error', 'disconnected', 'unreachable', 'timeout'].includes(s)) return false;
    return true;
  };

  const workingPrinters = fleet.filter(isPrinterWorking);
  const offlinePrinterCount = fleet.filter(p => !isPrinterWorking(p)).length;

  const activeFleetList = fleet.filter(p => {
    if (hiddenPrinterIds.includes(p.id)) return false;
    if (hideOfflinePrinters && !isPrinterWorking(p)) return false;
    return true;
  });

  // Settings & Customization
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [settingsTab, setSettingsTab] = useState('colors'); // 'colors' | 'fonts' | 'layout' | 'api' | 'screen'
  // Burn-in protection (hue drift, pixel shift, deep dim, screensaver) - saved per device
  const [screenGuard, setScreenGuard] = useScreenGuardSettings();
  const [saverPreview, setSaverPreview] = useState(0);

  const getInitialTheme = () => {
    try {
      const saved = localStorage.getItem('havoc_theme_accent');
      if (saved && THEMES.some(t => t.id === saved)) return saved;
    } catch (e) {}
    return 'cyan';
  };

  const getInitialFont = () => {
    try {
      const saved = localStorage.getItem('havoc_display_font');
      if (saved && FONTS.some(f => f.id === saved)) return saved;
    } catch (e) {}
    return 'Orbitron';
  };

  const getInitialPanels = () => {
    try {
      const saved = localStorage.getItem('havoc_mission_panels');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const validIds = new Set(DEFAULT_PANEL_ORDER.map(p => p.id));
          const filtered = parsed.filter(p => validIds.has(p.id));
          const existingIds = new Set(filtered.map(p => p.id));
          DEFAULT_PANEL_ORDER.forEach(def => {
            if (!existingIds.has(def.id)) filtered.push(def);
          });
          return filtered;
        }
      }
    } catch (e) {}
    return DEFAULT_PANEL_ORDER;
  };

  const [themeAccent, setThemeAccent] = useState(getInitialTheme);
  const [displayFont, setDisplayFont] = useState(getInitialFont);
  const [missionPanels, setMissionPanels] = useState(getInitialPanels);

  const applyTheme = (themeId) => {
    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    const root = document.documentElement;
    root.style.setProperty('--cyan-glow', theme.glow);
    root.style.setProperty('--cyan-dim', theme.dim);
    root.style.setProperty('--border-bright', theme.borderBright);
    root.style.setProperty('--border-dim', theme.borderDim);
    root.style.setProperty('--accent-rgb', theme.rgb);
    root.classList.toggle('theme-lcars', !!theme.lcars);

    let styleEl = document.getElementById('havoc-dynamic-theme');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'havoc-dynamic-theme';
      document.head.appendChild(styleEl);
    }
    styleEl.innerHTML = `
      :root {
        --cyan-glow: ${theme.glow};
        --cyan-dim: ${theme.dim};
        --border-bright: ${theme.borderBright};
        --border-dim: ${theme.borderDim};
        --accent-rgb: ${theme.rgb};
      }
      .text-cyan-400, .text-cyan-300 { color: ${theme.glow} !important; }
      .text-cyan-500 { color: ${theme.dim} !important; }
      .border-cyan-500, .border-cyan-400, .border-cyan-600 { border-color: ${theme.glow} !important; }
      .border-cyan-800, .border-cyan-700, .border-cyan-900 { border-color: ${theme.dim} !important; }
      .bg-cyan-950, .bg-cyan-950\\/40, .bg-cyan-950\\/60, .bg-cyan-950\\/70, .bg-cyan-950\\/80 { background-color: rgba(${theme.rgb}, 0.15) !important; }
      .bg-cyan-500, .bg-cyan-400 { background-color: ${theme.glow} !important; }
      .shadow-\\[0_0_15px_rgba\\(0\\,242\\,254\\,0\\.3\\)\\] { box-shadow: 0 0 15px rgba(${theme.rgb}, 0.35) !important; }
      .shadow-\\[0_0_25px_rgba\\(0\\,242\\,254\\,0\\.1\\)\\] { box-shadow: 0 0 25px rgba(${theme.rgb}, 0.2) !important; }
    `;
    try {
      localStorage.setItem('havoc_theme_accent', themeId);
    } catch (e) {}
    setThemeAccent(themeId);
  };

  const applyFont = (fontId) => {
    const fontObj = FONTS.find(f => f.id === fontId) || FONTS[0];
    document.documentElement.style.setProperty('--font-display', fontObj.stack);
    try {
      localStorage.setItem('havoc_display_font', fontId);
    } catch (e) {}
    setDisplayFont(fontId);
  };

  const updatePanels = (newPanels) => {
    setMissionPanels(newPanels);
    try {
      localStorage.setItem('havoc_mission_panels', JSON.stringify(newPanels));
    } catch (e) {}
  };

  const movePanel = (index, direction) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= missionPanels.length) return;
    const next = [...missionPanels];
    const [moved] = next.splice(index, 1);
    next.splice(targetIdx, 0, moved);
    updatePanels(next);
  };

  const togglePanelVisibility = (id) => {
    const next = missionPanels.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p);
    updatePanels(next);
  };

  const applyPanelPreset = (presetKey) => {
    let nextOrder = [];
    if (presetKey === 'ai_first') {
      nextOrder = ['ai', 'intel', 'fleet', 'schedule'];
    } else if (presetKey === 'intel_first') {
      nextOrder = ['intel', 'ai', 'fleet', 'schedule'];
    } else if (presetKey === 'fleet_first') {
      nextOrder = ['fleet', 'intel', 'ai', 'schedule'];
    } else if (presetKey === 'schedule_first') {
      nextOrder = ['intel', 'schedule', 'fleet', 'ai'];
    }
    const map = {};
    missionPanels.forEach(p => { map[p.id] = { ...p, enabled: true }; });
    const ordered = nextOrder.map(id => map[id] || DEFAULT_PANEL_ORDER.find(d => d.id === id));
    updatePanels(ordered);
  };

  // Mount effect to restore theme & font
  useEffect(() => {
    applyTheme(themeAccent);
    applyFont(displayFont);
  }, []);


  // Modals
  const [showAddPrinter, setShowAddPrinter] = useState(false);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [showCalSync, setShowCalSync] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [dismissedConflictKeys, setDismissedConflictKeys] = useState(new Set());
  const [webcamModal, setWebcamModal] = useState(null);
  const getInitialAiConfig = () => {
    try {
      const saved = localStorage.getItem('havoc_ai_config');
      if (saved) {
        const parsed = stripKeys(JSON.parse(saved));
        if (parsed && typeof parsed === 'object') {
          // Scrub keys older builds left in localStorage.
          try { localStorage.setItem('havoc_ai_config', JSON.stringify(parsed)); } catch (e) {}
          if (!parsed.provider_keys || typeof parsed.provider_keys !== 'object') {
            parsed.provider_keys = {
              gemini: parsed.provider === 'gemini' ? parsed.api_key || '' : '',
              groq: parsed.provider === 'groq' ? parsed.api_key || '' : '',
              openai: parsed.provider === 'openai' ? parsed.api_key || '' : '',
              custom: parsed.provider === 'custom' ? parsed.api_key || '' : ''
            };
          }
          if (!parsed.custom_url) {
            parsed.custom_url = 'https://skippy.ai.studio';
          }
          if (parsed.model === 'gemini-3.6-flash') {
            parsed.model = 'gemini-2.0-flash';
          }
          return parsed;
        }
      }
    } catch (e) {}
    return {
      provider: 'gemini',
      api_key: '',
      model: 'gemini-2.0-flash',
      custom_url: 'https://skippy.ai.studio',
      provider_keys: { gemini: '', groq: '', openai: '', custom: '' }
    };
  };


  const [aiConfig, setAiConfigState] = useState(getInitialAiConfig);
  const aiConfigRef = useRef(aiConfig);
  aiConfigRef.current = aiConfig;
  const [aiSavedFeedback, setAiSavedFeedback] = useState(false);
  const aiSaveTimeoutRef = useRef(null);
  const chatInputRef = useRef(null);
  const tabChatInputRef = useRef(null);

  const setAiConfig = (updater) => {
    setAiConfigState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      aiConfigRef.current = next;
      persistAiPrefs(next);
      if (aiSaveTimeoutRef.current) clearTimeout(aiSaveTimeoutRef.current);
      aiSaveTimeoutRef.current = setTimeout(() => {
        handleSaveAiConfig(null, next);
      }, 500);
      return next;
    });
  };


  // Forms
  const [newPrinter, setNewPrinter] = useState({
    name: '',
    type: 'moonraker',
    host: '192.168.1.',
    port: 7125,
    api_key: '',
    webcam_url: '',
    enabled: true,
    notes: ''
  });

  const [newEvent, setNewEvent] = useState({
    title: '',
    start: '',
    end: '',
    location: '',
    description: ''
  });

  const [icalInput, setIcalInput] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  // AI Companion state
  const [humorLevel, setHumorLevel] = useState(100); // TARS humor setting
  const [chatMessages, setChatMessages] = useState([
    {
      sender: 'havoc',
      text: "🤖 [TARS HUMOR: 100% // HONESTY: 95%]\n\nSilas online, Karl. You engineered the prompts, now I keep the workshop running. What 3D printing fault or schedule collision are we tackling today?"
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedPrinterForDiag, setSelectedPrinterForDiag] = useState('');
  const overviewChatScrollRef = useRef(null);
  const tabAiChatScrollRef = useRef(null);

  // Front-page Top AI states
  const [topAiInput, setTopAiInput] = useState('');
  const [topAiResponse, setTopAiResponse] = useState(null);
  const [topAiLoading, setTopAiLoading] = useState(false);
  const [topAiExpanded, setTopAiExpanded] = useState(true);

  // Clock update
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Scroll only the chat containers to bottom, NEVER the browser window
  useEffect(() => {
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    if (overviewChatScrollRef.current) {
      overviewChatScrollRef.current.scrollTop = overviewChatScrollRef.current.scrollHeight;
    }
    if (tabAiChatScrollRef.current) {
      tabAiChatScrollRef.current.scrollTop = tabAiChatScrollRef.current.scrollHeight;
    }
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
  }, [chatMessages]);

  // Re-sync AI config from backend whenever the Settings modal opens
  useEffect(() => {
    if (showSettingsModal) {
      fetch(`${API_BASE}/ai/config`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) {
            setAiConfigState((prev) => {
              const provKeys = {
                ...(prev.provider_keys || {}),
                ...(data.provider_keys || {})
              };
              const activeProv = prev.provider || data.provider || 'gemini';
              const next = {
                ...prev,
                ...data,
                provider: activeProv,
                api_key: prev.api_key || provKeys[activeProv] || data.api_key || '',
                provider_keys: provKeys
              };
              aiConfigRef.current = next;
              return next;
            });
          }
        })
        .catch(() => {});
    }
  }, [showSettingsModal]);


  // Extract actual warning conflicts (ignoring clear / nominal status)
  const actualConflicts = (briefing?.conflicts || []).filter(
    c => c.severity === 'high' || c.severity === 'medium'
  );

  const handleDismissWarningModal = () => {
    setShowWarningModal(false);
    try {
      sessionStorage.setItem('havoc_warnings_dismissed', 'true');
    } catch (e) {}
    setDismissedConflictKeys(prev => {
      const next = new Set(prev);
      actualConflicts.forEach(c => {
        next.add(`${c.printer_id || c.printer_name}__${c.event_title}`);
      });
      return next;
    });
  };

  // Auto pop-up warning modal ONLY for real overruns, and NEVER if already dismissed in this session
  useEffect(() => {
    let isDismissed = false;
    try {
      isDismissed = sessionStorage.getItem('havoc_warnings_dismissed') === 'true';
    } catch (e) {}

    if (!isDismissed && actualConflicts.length > 0) {
      const hasUnacknowledged = actualConflicts.some(c => {
        const key = `${c.printer_id || c.printer_name}__${c.event_title}`;
        return !dismissedConflictKeys.has(key);
      });
      if (hasUnacknowledged && !showWarningModal) {
        setShowWarningModal(true);
      }
    }
  }, [actualConflicts.length, dismissedConflictKeys]);

  // Sync tab with URL hash navigation (browser back/forward)
  useEffect(() => {
    const handleHashChange = () => {
      try {
        const hash = window.location.hash.replace('#', '');
        if (['mission', 'todo', 'fleet', 'learn', 'calendar', 'ai', 'mobile', 'drives', 'usage'].includes(hash)) {
          setActiveTabState(hash);
          localStorage.setItem('havoc_active_tab', hash);
        }
      } catch (e) {}
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Live data feed. The backend hub pushes one snapshot (fleet + calendar + briefing)
  // per tick over /ws; REST polling of /api/snapshot is only the fallback.
  const [feedStatus, setFeedStatus] = useState('connecting'); // 'live' | 'polling' | 'connecting' | 'locked'

  // Printer alerts (U1 exceptions, Klipper errors) forwarded by the backend alert centre.
  const [alerts, setAlerts] = useState([]);          // unacknowledged, newest first
  const [alertLog, setAlertLog] = useState(null);    // history panel (null = closed)
  const [alertSoundOn, setAlertSoundOn] = useState(() => {
    try { return localStorage.getItem('havoc_alert_sound') !== 'off'; } catch (e) { return true; }
  });
  const [notifyPerm, setNotifyPerm] = useState(() =>
    (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'));
  const seenAlertsRef = useRef(null);  // id -> count already announced
  const alertSoundRef = useRef(alertSoundOn);
  alertSoundRef.current = alertSoundOn;

  // Siren: armed/disarmed is remembered; sound needs one click on the page after it loads.
  const [sirenArmed, setSirenArmed] = useState(() => {
    try { return localStorage.getItem('havoc_siren') !== 'off'; } catch (e) { return true; }
  });
  const [audioReady, setAudioReady] = useState(false);
  const [silencedIds, setSilencedIds] = useState([]);
  const [sirenClock, setSirenClock] = useState(() => Date.now());
  const sirenAlerts = alerts.filter((a) => a.siren && !silencedIds.includes(a.id) &&
    (!a.siren_delay || (a.active !== false && sirenClock / 1000 - (a.first_seen || 0) >= a.siren_delay)));
  const sirenOn = sirenArmed && sirenAlerts.length > 0;
  const sirenOnRef = useRef(sirenOn);
  sirenOnRef.current = sirenOn;

  // Any click or key press on SILAS unlocks audio for the siren.
  useEffect(() => {
    const unlock = () => {
      try {
        const ctx = getAudio();
        if (ctx.state === 'running') setAudioReady(true);
        else ctx.resume().then(() => setAudioReady(ctx.state === 'running')).catch(() => {});
      } catch (e) {}
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  useEffect(() => {
    if (sirenOn) startSiren(); else stopSiren();
  }, [sirenOn]);
  useEffect(() => () => stopSiren(), []);

  // "Lost contact" only sirens after it has stayed lost for a while, so re-check now and then.
  const hasDelayedSiren = alerts.some((a) => a.siren && a.siren_delay);
  useEffect(() => {
    if (!hasDelayedSiren) return;
    const t = setInterval(() => setSirenClock(Date.now()), 5000);
    return () => clearInterval(t);
  }, [hasDelayedSiren]);

  const silenceSiren = () => setSilencedIds((ids) => Array.from(new Set([...ids, ...sirenAlerts.map((a) => a.id)])));

  const toggleSiren = () => {
    try { getAudio(); } catch (e) {}
    setSirenArmed((on) => {
      const next = !on;
      try { localStorage.setItem('havoc_siren', next ? 'on' : 'off'); } catch (e) {}
      if (next) playAlarm('info');
      return next;
    });
  };

  const [alarmStyle, setAlarmStyle] = useState(getSoundStyle);
  const toggleAlarmStyle = () => {
    const next = alarmStyle === 'starship' ? 'classic' : 'starship';
    try { localStorage.setItem(SOUND_STYLE_KEY, next); } catch (e) {}
    setAlarmStyle(next);
    // Restart a running siren in the new style.
    if (sirenOnRef.current) { stopSiren(); setTimeout(() => { if (sirenOnRef.current) startSiren(); }, 250); }
    else playAlarm('warning');
  };

  const [voiceOn, setVoiceOn] = useState(getVoiceOn);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const toggleVoice = () => {
    const next = !voiceOn;
    try { localStorage.setItem(VOICE_KEY, next ? 'on' : 'off'); } catch (e) {}
    setVoiceOn(next);
    if (next) speak('Voice alerts online. Warning. Snapmaker U1: Example alert. This is a test of the voice alert system.');
    else { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {} }
  };

  const testSiren = () => {
    if (sirenOnRef.current) return;
    startSiren();
    setTimeout(() => { if (!sirenOnRef.current) stopSiren(); }, 3000);
  };

  const announceAlerts = (list, fromPush) => {
    if (!Array.isArray(list)) return;
    const seen = seenAlertsRef.current;
    const next = new Map();
    list.forEach((a) => next.set(a.id, a.count));
    // First load: remember what's already there without sounding off for old news.
    if (seen === null) { seenAlertsRef.current = next; return; }
    const fresh = list.filter((a) => !a.acknowledged && (seen.get(a.id) || 0) < a.count && (a.severity !== 'info' || a.source === 'ai'));
    seenAlertsRef.current = next;
    if (!fresh.length || !fromPush) return;
    const worst = fresh.some((a) => a.severity === 'critical') ? 'critical' : fresh.every((a) => a.severity === 'info') ? 'info' : 'warning';
    if (alertSoundRef.current) {
      playAlarm(worst);
      if (voiceOnRef.current) speak(describeAlerts(fresh, worst), worst === 'critical' ? 1400 : 700);
    }
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        fresh.slice(0, 3).forEach((a) => {
          const n = new Notification(`SILAS // ${a.printer_name}: ${a.title}`, {
            body: `${a.code ? a.code + ' - ' : ''}${a.message}`,
            tag: `havoc-${a.id}`,
            requireInteraction: a.severity === 'critical',
          });
          n.onclick = () => { window.focus(); n.close(); };
        });
      }
    } catch (e) {}
  };

  const applyAlerts = (list, fromPush = false) => {
    if (!Array.isArray(list)) return;
    announceAlerts(list, fromPush);
    setAlerts(list);
  };

  const acknowledgeAlert = async (id = null) => {
    setAlerts((prev) => (id ? prev.filter((a) => a.id !== id) : []));
    try {
      await fetch(`${API_BASE}/alerts/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id } : {}),
      });
    } catch (e) {}
    if (alertLog) openAlertLog();
  };

  const openAlertLog = async () => {
    try {
      const res = await fetch(`${API_BASE}/alerts?limit=100`);
      if (res.ok) setAlertLog(await res.json());
    } catch (e) {}
  };

  const fireTestAlert = async () => {
    try { await fetch(`${API_BASE}/alerts/test`, { method: 'POST' }); } catch (e) {}
  };

  const enableDesktopAlerts = async () => {
    try {
      if (typeof Notification === 'undefined') return;
      const perm = await Notification.requestPermission();
      setNotifyPerm(perm);
      playAlarm('warning'); // also unlocks audio for later alarms
    } catch (e) {}
  };

  const toggleAlertSound = () => {
    setAlertSoundOn((on) => {
      const next = !on;
      try { localStorage.setItem('havoc_alert_sound', next ? 'on' : 'off'); } catch (e) {}
      if (next) playAlarm('warning');
      return next;
    });
  };

  // Tab title flashes while anything is unacknowledged, so you notice from another window.
  useEffect(() => {
    const base = 'SILAS // Personal Operational Intelligence';
    if (!alerts.length) { document.title = base; return; }
    let on = false;
    const t = setInterval(() => {
      on = !on;
      document.title = on ? `🚨 ${alerts.length} PRINTER ALERT${alerts.length > 1 ? 'S' : ''}` : base;
    }, 1000);
    return () => { clearInterval(t); document.title = base; };
  }, [alerts.length]);

  const applySnapshot = (snap) => {
    if (!snap || !Array.isArray(snap.fleet)) return;
    const fData = snap.fleet;
    setFleet(fData);
    setSelectedPrinterForDiag((prev) => {
      if (prev && fData.some((p) => p.id === prev)) {
        return prev;
      }
      const active = fData.find((p) => p.state === 'printing') || fData.find((p) => p.online) || fData[0];
      return active ? active.id : '';
    });
    if (Array.isArray(snap.events)) setEvents(snap.events);
    if (snap.briefing) setBriefing(snap.briefing);
    if (Array.isArray(snap.alerts)) applyAlerts(snap.alerts, true);
    setLoading(false);
  };

  const fetchSystemInfo = async () => {
    try {
      const res = await fetch(`${API_BASE}/system`);
      if (res.status === 401) { setFeedStatus('locked'); return; }
      if (res.ok) setSystemInfo(await res.json());
    } catch (e) {}
  };

  const fetchAllData = async () => {
    try {
      const res = await fetch(`${API_BASE}/snapshot`);
      if (res.status === 401) { setFeedStatus('locked'); return; }
      if (res.ok) applySnapshot(await res.json());
    } catch (err) {
      console.error("Telemetry fetch failed:", err);
    }
  };

  // Fetch AI credentials from backend once on initial load (preserving any local key)
  useEffect(() => {
    fetch(`${API_BASE}/ai/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setAiConfigState((prev) => {
            const provKeys = {
              ...(prev.provider_keys || {}),
              ...(data.provider_keys || {})
            };
            if (data.api_key && data.provider) {
              provKeys[data.provider] = data.api_key;
            }
            const activeProv = prev.provider || data.provider || 'gemini';
            const merged = {
              ...prev,
              ...data,
              provider: activeProv,
              api_key: prev.api_key || provKeys[activeProv] || data.api_key || '',
              provider_keys: provKeys
            };
            aiConfigRef.current = merged;
            persistAiPrefs(merged);
            return merged;
          });
        }
      })
      .catch(() => {});
  }, []);


  useEffect(() => {
    let ws = null;
    let pollTimer = null;
    let retryTimer = null;
    let retryDelay = 1000;
    let stopped = false;

    const startPolling = () => {
      if (pollTimer) return;
      setFeedStatus((s) => (s === 'locked' ? s : 'polling'));
      fetchAllData();
      pollTimer = setInterval(fetchAllData, 4000);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const connect = () => {
      if (stopped) return;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      } catch (e) {
        startPolling();
        return;
      }
      ws.onopen = () => {
        retryDelay = 1000;
        stopPolling();
        setFeedStatus('live');
      };
      ws.onmessage = (msg) => {
        try {
          const snap = JSON.parse(msg.data);
          if (snap.type === 'snapshot') applySnapshot(snap);
          else if (snap.type === 'alert' || snap.type === 'alerts') applyAlerts(snap.alerts, true);
        } catch (e) {}
      };
      ws.onclose = (ev) => {
        if (stopped) return;
        if (ev.code === 4401) { setFeedStatus('locked'); return; }
        startPolling();
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (e) {}
      };
    };

    fetchSystemInfo();
    fetchAllData();
    connect();
    const sysTimer = setInterval(fetchSystemInfo, 30000);

    return () => {
      stopped = true;
      stopPolling();
      clearTimeout(retryTimer);
      clearInterval(sysTimer);
      if (ws) { try { ws.close(); } catch (e) {} }
    };
  }, []);

  // Printer commands
  const handlePrinterCommand = async (printerId, command, params = {}) => {
    try {
      setStatusMsg(`Executing ${command} on ${printerId}...`);
      const res = await fetch(`${API_BASE}/printers/${printerId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, params })
      });
      const data = await res.json();
      if (data.success) {
        setStatusMsg(`Executed ${command} successfully.`);
      } else {
        setStatusMsg(`Command failed: ${data.error || 'Unknown error'}`);
      }
      setTimeout(() => setStatusMsg(''), 4000);
      fetchAllData();
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
      setTimeout(() => setStatusMsg(''), 4000);
    }
  };

  // Switch Toolhead
  const handleSelectTool = async (printerId, toolId, state) => {
    if (state === 'printing' || state === 'paused') {
      setStatusMsg('Tool changes are locked while a job is running.');
      setTimeout(() => setStatusMsg(''), 3000);
      return;
    }
    try {
      setStatusMsg(`Switching ${printerId} to ${toolId}...`);
      const res = await fetch(`${API_BASE}/printers/${printerId}/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolId })
      });
      if (res.ok) {
        setStatusMsg(`Active tool switched to ${toolId}`);
        setTimeout(() => setStatusMsg(''), 3000);
        fetchAllData();
      }
    } catch (err) {
      setStatusMsg(`Tool switch failed: ${err.message}`);
      setTimeout(() => setStatusMsg(''), 3000);
    }
  };

  const handleAddPrinter = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/printers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newPrinter)
      });
      if (res.ok) {
        setShowAddPrinter(false);
        setNewPrinter({
          name: '',
          type: 'moonraker',
          host: '192.168.1.',
          port: 7125,
          api_key: '',
          webcam_url: '',
          enabled: true,
          notes: ''
        });
        fetchAllData();
      }
    } catch (err) {
      alert("Failed to add printer: " + err.message);
    }
  };

  const handleDeletePrinter = async (printerId, printerName) => {
    if (!confirm(`Confirm decommissioning ${printerName}?`)) return;
    try {
      await fetch(`${API_BASE}/printers/${printerId}`, { method: 'DELETE' });
      fetchAllData();
    } catch (err) {
      alert("Failed to delete printer: " + err.message);
    }
  };

  const handleAddEvent = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/calendar/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEvent)
      });
      if (res.ok) {
        setShowAddEvent(false);
        setNewEvent({ title: '', start: '', end: '', location: '', description: '' });
        fetchAllData();
      }
    } catch (err) {
      alert("Failed to add event: " + err.message);
    }
  };

  const handleDeleteEvent = async (eventId) => {
    try {
      await fetch(`${API_BASE}/calendar/events/${eventId}`, { method: 'DELETE' });
      fetchAllData();
    } catch (err) {
      alert("Failed to delete event: " + err.message);
    }
  };

  const handleSaveIcal = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/calendar/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ical_url: icalInput })
      });
      if (res.ok) {
        setShowCalSync(false);
        setStatusMsg("Google Calendar iCal synced!");
        setTimeout(() => setStatusMsg(''), 4000);
        fetchAllData();
      }
    } catch (err) {
      alert("Failed to update calendar URL: " + err.message);
    }
  };

  const handleSaveAiConfig = async (e, configToSave = null) => {
    if (e && e.preventDefault) e.preventDefault();
    const cfg = configToSave || aiConfigRef.current;
    try {
      persistAiPrefs(cfg);
      const res = await fetch(`${API_BASE}/ai/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
      if (res.ok) {
        setStatusMsg("Silas AI intelligence credentials saved!");
        setAiSavedFeedback(true);
        setTimeout(() => setStatusMsg(''), 4000);
        setTimeout(() => setAiSavedFeedback(false), 4000);
      }
    } catch (err) {
      console.error("Failed to save AI config:", err);
    }
  };

  const handleCloseSettings = async () => {
    await handleSaveAiConfig(null, aiConfigRef.current);
    setShowSettingsModal(false);
  };

  // AI Chat Handlers
  const handleSendAiMessage = async (queryText = chatInput, printerId = selectedPrinterForDiag) => {
    if (!queryText.trim() && !printerId) return;
    const userMsg = queryText.trim() || `Diagnose ${printerId}`;
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    setChatMessages((prev) => [...prev, { sender: 'user', text: userMsg }]);
    setChatInput('');
    setAiLoading(true);

    requestAnimationFrame(() => {
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      const activeInput = activeTab === 'ai' ? tabChatInputRef.current : chatInputRef.current;
      if (activeInput && document.activeElement !== activeInput) {
        activeInput.focus({ preventScroll: true });
      }
    });

    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, printer_id: printerId || null, humor_level: humorLevel })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server returned status ${res.status}: ${errText || res.statusText}`);
      }
      const data = await res.json();
      setChatMessages((prev) => [
        ...prev,
        { sender: 'havoc', text: data.reply || "Diagnostic completed." }
      ]);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { sender: 'havoc', text: `Diagnostic processing error: ${err.message}` }
      ]);
    } finally {
      setAiLoading(false);
      requestAnimationFrame(() => {
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      });
    }
  };


  const handleTriggerMachineDiagnosis = (printer) => {
    setSelectedPrinterForDiag(printer.id);
    setActiveTab('ai');
    handleSendAiMessage(`Diagnose telemetry for ${printer.name}`, printer.id);
  };

  const handleTopAiSubmit = async (queryText = topAiInput) => {
    if (!queryText.trim()) return;
    const userMsg = queryText.trim();
    setTopAiInput('');
    setTopAiLoading(true);
    setChatMessages((prev) => [...prev, { sender: 'user', text: userMsg }]);

    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          printer_id: selectedPrinterForDiag || null,
          humor_level: humorLevel
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server returned status ${res.status}: ${errText || res.statusText}`);
      }
      const data = await res.json();
      const reply = data.reply || "Diagnostic completed.";
      setTopAiResponse(reply);
      setChatMessages((prev) => [...prev, { sender: 'havoc', text: reply }]);
    } catch (err) {
      setTopAiResponse(`Diagnostic error: ${err.message}`);
    } finally {
      setTopAiLoading(false);
    }
  };

  const formatTime = (isoStr) => {
    if (!isoStr) return '--:--';
    try {
      return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  };

  const formatDate = (isoStr) => {
    if (!isoStr) return '';
    try {
      return new Date(isoStr).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      return isoStr;
    }
  };

  const renderPrinterAlertBox = (p) => {
    const mine = alerts.filter((a) => a.printer_id === p.id);
    const live = (p.printer_exceptions || []).filter(
      (e) => !mine.some((a) => a.key === `u1:${e.id}-${e.index}-${e.code}`)
    );
    if (!mine.length && !live.length && p.state !== 'error') return null;
    const worst = mine.some((a) => a.severity === 'critical') || p.state === 'error' ? 'critical' : 'warning';
    const st = ALERT_STYLES[worst];
    return (
      <div className={`mb-3 p-2 rounded border text-[11px] font-mono ${st.box}`}>
        {mine.slice(0, 3).map((a) => (
          <div key={a.id} className="flex items-start justify-between gap-2 py-0.5">
            <span className="min-w-0">
              {ALERT_STYLES[a.severity]?.icon || '⚠️'} <b>{a.title}</b>
              {a.code && <span className="opacity-70"> [{a.code}]</span>}
              <span className="block opacity-80 truncate">{a.message}</span>
            </span>
            <button onClick={() => acknowledgeAlert(a.id)} className="shrink-0 underline opacity-80 hover:opacity-100">ACK</button>
          </div>
        ))}
        {live.map((e) => (
          <div key={`${e.id}-${e.index}-${e.code}`} className="py-0.5 opacity-90">
            ⚠️ Printer still reports: {e.message}
          </div>
        ))}
        {!mine.length && !live.length && p.state === 'error' && (
          <div>🚨 {p.error_message || 'Printer is in an error state.'}</div>
        )}
      </div>
    );
  };

  const renderStateBadge = (state) => {
    const s = (state || 'offline').toLowerCase();
    if (s === 'printing') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-cyan-950/80 border border-cyan-500 text-cyan-300 animate-pulse-glow">
          <span className="w-2 h-2 rounded-full bg-cyan-400"></span> PRINTING
        </span>
      );
    }
    if (s === 'standby' || s === 'ready') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-emerald-950/80 border border-emerald-500 text-emerald-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400"></span> STANDBY
        </span>
      );
    }
    if (s === 'paused') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-amber-950/80 border border-amber-500 text-amber-300">
          <span className="w-2 h-2 rounded-full bg-amber-400"></span> PAUSED
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-slate-900/80 border border-slate-700 text-slate-400">
        <span className="w-2 h-2 rounded-full bg-slate-500"></span> {s.toUpperCase()}
      </span>
    );
  };



  // ==========================================
  // MODULAR MISSION CONTROL PANEL RENDERERS
  // ==========================================
  const renderAiSection = () => (
      <div className="hud-panel p-3 mb-6 border-cyan-500/40 bg-slate-950/80 shadow-[0_0_25px_rgba(0,242,254,0.1)] flex flex-col h-full">
        {/* Panel Header */}
        <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-cyan-950 border border-cyan-500 flex items-center justify-center text-base font-display font-black text-cyan-400 shadow-[0_0_10px_rgba(0,242,254,0.3)]">
              🤖
            </div>
            <div>
              <h3 className="font-display font-bold text-sm text-white flex items-center gap-2">
                SILAS AI CONSTRUCT <span className="text-[10px] font-mono text-cyan-400 font-normal">TARS HUMOR: {humorLevel}%</span>
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {/* TARS Humor Slider */}
            <div className="flex items-center gap-1.5 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800 text-xs font-mono" title="TARS humor">
              <span className="text-[10px] text-slate-400">😏</span>
              <input
                type="range"
                min="50"
                max="100"
                step="5"
                value={humorLevel}
                onChange={(e) => setHumorLevel(parseInt(e.target.value))}
                className="w-12 accent-cyan-400 cursor-pointer"
                title="Adjust TARS humor parameter"
              />
              <span className="text-cyan-400 text-xs font-bold w-7 text-right">{humorLevel}%</span>
            </div>

            {/* Target Rig Selector */}
            {fleet.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs font-mono">
                <select
                  value={selectedPrinterForDiag}
                  onChange={(e) => setSelectedPrinterForDiag(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-cyan-300 max-w-[150px]"
                  title="Rig for Silas to look at"
                >
                  {fleet.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.state.toUpperCase()} | {p.active_toolhead || 'T0'})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const target = fleet.find((p) => p.id === selectedPrinterForDiag);
                    const targetName = target ? target.name : 'active printer';
                    handleSendAiMessage(`Diagnose telemetry for ${targetName}`, selectedPrinterForDiag);
                  }}
                  className="hud-btn hud-btn-primary !text-[11px] !py-0.5 !px-2"
                  title="Run instant telemetry scan on selected rig"
                >
                  Scan
                </button>
              </div>
            )}



            <button
              onClick={() => {
                setChatMessages([
                  {
                    sender: 'havoc',
                    text: `🤖 [TARS HUMOR: ${humorLevel}% // HONESTY: 95%]\n\nChat logs cleared, Karl. What 3D printing fault or schedule task are we tackling?`
                  }
                ]);
              }}
              className="text-xs font-mono text-slate-400 hover:text-red-400 px-1.5 py-0.5 rounded border border-slate-800"
              title="Clear chat history"
            >
              🗑️
            </button>

            <button
              onClick={() => setActiveTab('ai')}
              className="text-xs font-mono text-slate-400 hover:text-cyan-300 px-1.5 py-0.5 rounded border border-slate-700"
              title="Open the full-screen Silas co-pilot"
              aria-label="Open the full-screen Silas co-pilot"
            >
              ⤢
            </button>

            <button
              onClick={() => setTopAiExpanded(!topAiExpanded)}
              className="text-xs font-mono text-slate-400 hover:text-white px-1.5 py-0.5 rounded border border-slate-700"
              title={topAiExpanded ? 'Collapse' : 'Expand'}
            >
              {topAiExpanded ? '▲' : '▼'}
            </button>
          </div>
        </div>

        {topAiExpanded && (
          <div className="mt-2 flex flex-col space-y-2 flex-1">
            {/* Quick Prompt Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs font-mono">
              <span className="text-[10px] text-slate-500 uppercase shrink-0">QUICK:</span>
              <button
                onClick={() => {
                  const target = fleet.find((p) => p.id === selectedPrinterForDiag);
                  const targetName = target ? target.name : 'active printer';
                  handleSendAiMessage(`Diagnose telemetry for ${targetName}`, selectedPrinterForDiag);
                }}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap text-cyan-300 border-cyan-800"
              >
                🔍 Scan {fleet.find((p) => p.id === selectedPrinterForDiag)?.name || 'Rig'}
              </button>
              <button
                onClick={() => handleSendAiMessage("Critique your creator's prompt engineering and code")}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap text-purple-300 border-purple-800"
              >
                🧠 Rate Creator's Prompts
              </button>
              <button
                onClick={() => handleSendAiMessage("Why is my first layer peeling and lifting off the bed?")}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap"
              >
                🪵 Bed Adhesion
              </button>
              <button
                onClick={() => handleSendAiMessage("I have terrible stringing and oozing on PETG")}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap"
              >
                🕸️ PETG Stringing
              </button>
              <button
                onClick={() => handleSendAiMessage("Help with BTT Eddy current probe sensor_type and query_probe error")}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap"
              >
                ⚠️ BTT Eddy Probe Error
              </button>
              <button
                onClick={() => handleSendAiMessage("What is on my schedule today and are there any print collisions?")}
                className="hud-btn !text-[10px] !py-0.5 !px-2 !gap-1 whitespace-nowrap text-amber-300 border-amber-800"
              >
                📡 Schedule & Radar Check
              </button>
            </div>

            {/* Chat Messages Stream */}
            <div ref={overviewChatScrollRef} className="h-[110px] overflow-y-auto overscroll-contain space-y-2 p-2 bg-slate-900/50 rounded-lg border border-slate-800/80 pr-2">
              {chatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-lg p-3 text-xs leading-relaxed ${
                      msg.sender === 'user'
                        ? 'bg-cyan-950/70 border border-cyan-800 text-white font-mono'
                        : 'bg-slate-900/90 border border-slate-800 text-slate-200 font-sans'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1 pb-1 border-b border-slate-800/80">
                      <span className="font-mono font-bold text-[10px] text-cyan-400 uppercase">
                        {msg.sender === 'user' ? 'Karl (Operator)' : 'Silas AI Construct'}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
              {aiLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-cyan-300 flex items-center gap-2 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                    Analyzing physical parameters and firmware telemetry...
                  </div>
                </div>
              )}
            </div>

            {/* Chat Input Bar */}
            <div className="flex items-center gap-2">
              <input
                ref={chatInputRef}
                type="text"
                placeholder="Ask Silas anything about print failures, G-code macros, or your daily schedule..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!aiLoading && chatInput.trim()) {
                      handleSendAiMessage(chatInput);
                    }
                  }
                }}
                className="flex-1 min-w-0 bg-slate-900/90 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-white focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!aiLoading && chatInput.trim()) handleSendAiMessage(chatInput);
                }}
                className={`hud-btn hud-btn-primary !px-3 !py-1.5 !text-[11px] font-mono font-bold ${aiLoading ? 'opacity-75 cursor-not-allowed' : ''}`}
              >
                {aiLoading ? 'THINKING...' : 'ASK'}
              </button>
            </div>
          </div>
        )}
      </div>
  );

  const renderIntelSection = (stacked = false) => (
      briefing ? (
        <div className={`hud-panel p-4 mb-6 border-cyan-500/30 bg-cyan-950/10 shadow-[0_0_15px_rgba(0,242,254,0.05)] ${stacked ? 'h-full' : ''}`}>
          <div className={`flex flex-col ${stacked ? '' : 'lg:flex-row lg:items-center'} justify-between gap-4`}>
            {/* Left: Silas Title & Sarcastic Status */}
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="text-xs font-mono text-cyan-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
                  <span>SILAS EXECUTIVE INTELLIGENCE // {briefing.date_display}</span>
                </div>
                {briefing.time_display && (
                  <span className="text-[10px] font-mono text-slate-500 border border-slate-800 px-1.5 py-0.5 rounded">
                    SYNC {briefing.time_display}
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-200 mt-1.5 font-sans">
                <span className="italic font-mono text-xs text-slate-300">
                  "{briefing.greeting} {briefing.fleet_summary} {briefing.agenda_summary}"
                </span>
              </div>
            </div>

            {/* Right: Telemetry & Radar Widgets */}
            <div className="flex items-center gap-3 flex-wrap shrink-0">
              {/* Active Collision Warnings Button (Click to reopen popup) */}
              {actualConflicts.length > 0 && (
                <button
                  onClick={() => setShowWarningModal(true)}
                  className="bg-amber-950/80 border border-amber-500/80 hover:bg-amber-900 px-3 py-2 rounded-lg text-left transition-all animate-pulse flex items-center gap-2 cursor-pointer shadow-[0_0_15px_rgba(245,158,11,0.25)]"
                  title="Click to open schedule collision warning pop-up"
                >
                  <span className="text-base">⚠️</span>
                  <div>
                    <div className="text-[10px] font-mono text-amber-400 font-bold uppercase tracking-wider">
                      COLLISION ALERT
                    </div>
                    <div className="text-xs font-mono text-amber-200 font-bold flex items-center gap-1.5">
                      <span>{actualConflicts.length} Warning(s)</span>
                      <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40 uppercase">
                        View (✕)
                      </span>
                    </div>
                  </div>
                </button>
              )}

              {/* PA Radar Buffer Telemetry */}
              {briefing.radar_assessment && (
                <div className={`px-3 py-2 rounded-lg border font-mono text-xs shrink-0 ${
                  briefing.radar_assessment.status === 'alert'
                    ? 'bg-red-950/40 border-red-800/80 text-red-300'
                    : briefing.radar_assessment.status === 'tight'
                    ? 'bg-amber-950/40 border-amber-800/80 text-amber-300'
                    : 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
                }`}>
                  <div className="text-[10px] text-slate-400 uppercase font-bold flex items-center gap-1">
                    <span>📡 PA RADAR</span>
                    <span className="uppercase text-[9px] px-1 rounded bg-slate-900 border border-slate-800">
                      {briefing.radar_assessment.status}
                    </span>
                  </div>
                  <div className="font-bold mt-0.5">
                    {briefing.radar_assessment.buffer_minutes}m buffer • ETA {briefing.radar_assessment.estimated_completion}
                  </div>
                </div>
              )}

              {/* Upcoming Engagement */}
              {briefing.next_event && (
                <div className="bg-slate-900/80 border border-slate-800 px-3 py-2 rounded-lg text-right shrink-0">
                  <div className="text-[10px] font-mono text-slate-400">UPCOMING ENGAGEMENT</div>
                  <div className="text-xs font-mono font-bold text-cyan-300">
                    {briefing.next_event.title} @ {briefing.next_event.time}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null
  );

  const renderFleetSection = (isFullWidth = false) => (
            <div className={`${isFullWidth ? "w-full" : "lg:col-span-2"} space-y-4`}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-display text-sm tracking-wider text-slate-300 flex items-center gap-2">
                  <span>⚡ ACTIVE FLEET TELEMETRY</span>
                  <span className="text-xs font-mono text-cyan-400">({workingPrinters.length} ONLINE)</span>
                </h2>
                <div className="flex items-center gap-3">
                  {offlinePrinterCount > 0 && (
                    <button
                      onClick={toggleHideOffline}
                      className={`hud-btn text-[11px] py-1 px-2.5 font-mono flex items-center gap-1.5 transition-all ${
                        hideOfflinePrinters ? 'hud-btn-primary bg-cyan-950/80 text-cyan-300 border-cyan-500' : 'text-slate-400 border-slate-700'
                      }`}
                      title={hideOfflinePrinters ? "Active nodes only. Click to reveal all." : "Click to hide offline nodes."}
                    >
                      <span>{hideOfflinePrinters ? '👁️' : '👁️‍🗨️'}</span>
                      <span>{hideOfflinePrinters ? `Hiding ${offlinePrinterCount} Offline` : `Hide Offline (${offlinePrinterCount})`}</span>
                    </button>
                  )}
                  <button onClick={() => setActiveTab('fleet')} className="text-xs font-mono text-cyan-400 hover:underline">
                    View Full Fleet →
                  </button>
                </div>
              </div>

              <div className={`grid grid-cols-1 ${isFullWidth ? "md:grid-cols-2 lg:grid-cols-3" : "md:grid-cols-2"} gap-4`}>
                {activeFleetList.length === 0 ? (
                  <div className="col-span-full hud-panel p-6 text-center font-mono text-xs text-slate-400">
                    <p className="text-sm font-bold text-slate-300 mb-1">📭 ALL REGISTERED NODES ARE CURRENTLY INACTIVE</p>
                    <p className="text-slate-500 mb-3">{fleet.length} machine(s) registered. All are powered off or unreachable.</p>
                    <button onClick={toggleHideOffline} className="hud-btn text-xs py-1.5 px-3 hud-btn-primary font-bold">
                      👁️ Reveal Offline Nodes
                    </button>
                  </div>
                ) : (
                  activeFleetList.map((p) => (
                  <div key={p.id} className="hud-panel p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-sm text-white font-mono">{p.name}</h3>
                          {/* Active Toolhead Badge */}
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-900/60 text-cyan-300 border border-cyan-700">
                            TOOL: {p.active_toolhead || 'T0'}
                          </span>
                        </div>
                        {renderStateBadge(p.state)}
                      </div>
                      {renderPrinterAlertBox(p)}
                      <div className="text-[11px] font-mono text-slate-400 mb-3 flex items-center justify-between">
                        <span>{p.type.toUpperCase()} // {p.host}:{p.port}</span>
                        <button
                          onClick={() => handleTriggerMachineDiagnosis(p)}
                          className="text-cyan-400 hover:text-cyan-200 text-[10px] flex items-center gap-1"
                        >
                          🤖 Diagnose
                        </button>
                      </div>

                      {/* Print Progress & 3D Thumbnail */}
                      {p.state === 'printing' ? (
                        <div className="mb-4">
                          {p.thumbnail_url && (
                            <div className="mb-3 relative group">
                              <div
                                onClick={() => setPreviewModalImg({
                                  url: p.thumbnail_url,
                                  filename: p.filename,
                                  printerName: p.name,
                                  slicerMeta: p.slicer_metadata
                                })}
                                className="relative w-full h-36 bg-slate-950/90 rounded-lg overflow-hidden border border-cyan-500/30 group-hover:border-cyan-400 transition-all cursor-pointer flex items-center justify-center shadow-inner"
                                title="Click to enlarge 3D print preview"
                              >
                                <img
                                  src={p.thumbnail_url}
                                  alt={p.filename || 'Print Preview'}
                                  className="w-full h-full object-contain p-2 transition-transform duration-300 group-hover:scale-105"
                                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent pointer-events-none"></div>
                                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px] font-mono pointer-events-none">
                                  <span className="bg-slate-900/90 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-800/60 shadow flex items-center gap-1">
                                    <span>🔍</span> 3D PREVIEW
                                  </span>
                                  {p.slicer_metadata?.filament_type && (
                                    <span className="bg-cyan-950/90 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-700/70 font-bold shadow">
                                      {p.slicer_metadata.filament_type}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="flex justify-between text-xs font-mono mb-1">
                            <span className="text-cyan-400 font-bold truncate max-w-[180px]">{p.filename || 'Job'}</span>
                            <span className="text-white font-bold">{p.progress_percent}%</span>
                          </div>
                          <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                            <div
                              className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full transition-all duration-500"
                              style={{ width: `${p.progress_percent}%` }}
                            ></div>
                          </div>
                          <div className="flex justify-between text-[11px] font-mono text-slate-400 mt-1">
                            <span>ETA: {p.eta_timestamp ? formatTime(p.eta_timestamp) : '--:--'}{p.eta_confidence === 'low' ? ' (rough)' : p.eta_confidence === 'medium' ? ' (est.)' : ''}</span>
                            <span>Left: {Math.round(p.time_left_seconds / 60)}m</span>
                          </div>

                          {p.slicer_metadata && (
                            <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-slate-800/60 text-[10px] font-mono text-slate-400">
                              {p.slicer_metadata.layer_count && (
                                <span className="bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 text-slate-300">
                                  Layers: {p.slicer_metadata.layer_count}
                                </span>
                              )}
                              {p.slicer_metadata.layer_height && (
                                <span className="bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 text-slate-300">
                                  {p.slicer_metadata.layer_height}mm
                                </span>
                              )}
                              {p.slicer_metadata.filament_name && (
                                <span className="bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 text-cyan-400 truncate max-w-[140px]" title={p.slicer_metadata.filament_name}>
                                  {p.slicer_metadata.filament_name}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs font-mono text-slate-500 py-2 border-y border-slate-800/60 my-2">
                          {p.online ? 'Idle. Ready for dispatch.' : p.error_message || 'Controller Offline'}
                        </div>
                      )}

                      {/* Thermals */}
                      <div className="grid grid-cols-2 gap-2 my-3 text-xs font-mono">
                        <div className="bg-slate-900/60 p-2 rounded border border-slate-800">
                          <div className="text-slate-400 text-[10px]">
                            ACTIVE NOZZLE ({p.active_toolhead || 'T0'})
                          </div>
                          <div className="text-white font-bold flex items-center gap-1">
                            <span className={p.extruder_temp > 50 ? 'text-amber-400' : 'text-slate-300'}>
                              {p.extruder_temp}°C
                            </span>
                            <span className="text-slate-500 text-[10px]">/ {p.extruder_target}°C</span>
                          </div>
                        </div>

                        <div className="bg-slate-900/60 p-2 rounded border border-slate-800">
                          <div className="text-slate-400 text-[10px]">HEATED BED</div>
                          <div className="text-white font-bold flex items-center gap-1">
                            <span className={p.bed_temp > 40 ? 'text-red-400' : 'text-slate-300'}>
                              {p.bed_temp}°C
                            </span>
                            <span className="text-slate-500 text-[10px]">/ {p.bed_target}°C</span>
                          </div>
                        </div>
                      </div>

                      {/* Multi-Tool Selector if multiple tools present */}
                      {p.toolheads && p.toolheads.length > 1 && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-3 bg-slate-950/60 p-1.5 rounded border border-slate-800">
                          <span className="text-[10px] font-mono text-slate-400">TOOLS:</span>
                          {p.toolheads.map((th) => (
                            <button
                              key={th.id}
                              onClick={() => handleSelectTool(p.id, th.id, p.state)}
                              disabled={p.state === 'printing' || p.state === 'paused'}
                              title={p.state === 'printing' || p.state === 'paused' ? 'Tool changes locked while a job is running' : `Switch to ${th.id}`}
                              className={`text-[10px] font-mono px-2 py-0.5 rounded border disabled:cursor-not-allowed ${
                                th.id === p.active_toolhead
                                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 font-bold'
                                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
                              }`}
                            >
                              {th.id} ({th.extruder_temp}°C{th.extruder_target > 0 ? `→${th.extruder_target}` : ''})
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Controls Footer */}
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
                      {p.online && (
                        <>
                          <button
                            onClick={() => handlePrinterCommand(p.id, 'preheat', { material: 'PLA' })}
                            className="hud-btn text-[11px] py-1 px-2"
                            title="Preheat PLA (210C/60C)"
                          >
                            Preheat PLA
                          </button>
                          <button
                            onClick={() => handlePrinterCommand(p.id, 'cooldown')}
                            className="hud-btn text-[11px] py-1 px-2"
                            title="Cooldown heaters"
                          >
                            Cool
                          </button>
                          {p.state === 'printing' && (
                            <button
                              onClick={() => handlePrinterCommand(p.id, 'pause')}
                              className="hud-btn text-[11px] py-1 px-2 text-amber-300"
                            >
                              Pause
                            </button>
                          )}
                          {p.state === 'paused' && (
                            <button
                              onClick={() => handlePrinterCommand(p.id, 'resume')}
                              className="hud-btn text-[11px] py-1 px-2 text-emerald-300"
                            >
                              Resume
                            </button>
                          )}
                        </>
                      )}
                      {p.webcam_url && (
                        <button
                          onClick={() => setWebcamModal(p)}
                          className="hud-btn text-[11px] py-1 px-2 ml-auto text-cyan-400"
                        >
                          👁️ Cam
                        </button>
                      )}
                    </div>
                  </div>
                )))}
              </div>
            </div>
  );

  const renderScheduleSection = (isFullWidth = false) => (
            <div className={`${isFullWidth ? "w-full" : ""} space-y-4`}>
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-display text-sm tracking-wider text-slate-300 flex items-center gap-2">
                  <span>📅 EXECUTIVE AGENDA</span>
                  <span className="text-xs font-mono text-cyan-400">({events.length})</span>
                </h2>
                <button
                  onClick={() => setShowAddEvent(true)}
                  className="hud-btn text-xs py-1 px-2.5 hud-btn-primary"
                >
                  + Add Event
                </button>
              </div>

              <div className="hud-panel p-4 space-y-3 max-h-[580px] overflow-y-auto">
                {events.length === 0 ? (
                  <div className="text-xs font-mono text-slate-500 text-center py-8">
                    No scheduled engagements found.
                  </div>
                ) : (
                  events.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition"
                    >
                      <div className="flex items-start justify-between">
                        <div className="font-bold text-xs text-white font-mono">{ev.title}</div>
                        <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-900">
                          {formatDate(ev.start)}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-1 flex items-center gap-2">
                        <span>🕒 {formatTime(ev.start)} - {formatTime(ev.end)}</span>
                        {ev.location && <span>📍 {ev.location}</span>}
                      </div>
                      {ev.description && (
                        <p className="text-[11px] text-slate-500 mt-1.5 line-clamp-2">
                          {ev.description}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
  );

  // Keys that live elsewhere: the chat is on Mission Control, Mobile is in the ⋮ menu.
  // A hidden key still shows while you're on its page, so you can see where you are.
  const navHidden = (id) => {
    if (id === 'ai') return activeTab !== 'ai' && missionPanels.some((p) => p.id === 'ai' && p.enabled);
    if (id === 'mobile') return activeTab !== 'mobile';
    return false;
  };

  const renderMissionPanels = () => {
    // Smart dock: the AI construct always sits BESIDE whatever is next to it on the page
    // (today tiles, briefing, agenda or fleet) instead of floating on its own half-row.
    // Panels with nothing to show (e.g. no briefing yet) are skipped so nothing is left hanging.
    const enabled = missionPanels.filter(p => p.enabled);
    // The chat is the front door now (its own nav key is hidden), so it is pinned to the
    // top row, first in reading order, with the TODAY tiles docked beside it.
    const aiOn = enabled.some(p => p.id === 'ai');
    const seq = [...(aiOn ? ['ai', 'today'] : ['today']), ...enabled.map(p => p.id).filter(id => id !== 'ai')]
      .filter(id => id !== 'intel' || briefing);
    const elements = [];
    const aiIdx = seq.indexOf('ai');
    const partner = aiOn ? 'today' : null;
    const aiLeft = true;

    const single = (id, wide) => {
      if (id === 'today') return <FocusStrip onOpen={() => setActiveTab('todo')} />;
      if (id === 'intel') return renderIntelSection(!wide);
      if (id === 'fleet') return <div className="space-y-4">{renderFleetSection(wide)}</div>;
      if (id === 'schedule') return <div className="space-y-4">{renderScheduleSection(wide)}</div>;
      return null;
    };
    const dock = (id) => {
      const other = id === 'today'
        ? <FocusStrip compact onOpen={() => setActiveTab('todo')} />
        : single(id, false);
      // Wide partners (fleet) get two thirds; everything else splits evenly.
      const cols = id === 'fleet' ? 'lg:grid-cols-3' : 'lg:grid-cols-2';
      const otherSpan = id === 'fleet' ? 'lg:col-span-2' : '';
      return (
        <div key={`dock_${id}`} className={`grid grid-cols-1 ${cols} gap-6 items-stretch [&>div>.hud-panel]:mb-0`}>
          <div className={`min-w-0 ${otherSpan} ${aiLeft ? 'lg:order-2' : ''}`}>{other}</div>
          <div className={`min-w-0 ${aiLeft ? 'lg:order-1' : ''}`}>{renderAiSection()}</div>
        </div>
      );
    };

    for (let i = 0; i < seq.length; i++) {
      const id = seq[i];
      if (id === 'ai') {
        if (!partner) elements.push(<div key="panel_ai">{renderAiSection()}</div>);
        continue; // otherwise drawn with its partner
      }
      if (id === partner) { elements.push(dock(id)); continue; }

      const nextId = seq.slice(i + 1).find(x => x !== 'ai');
      const nextIsFree = nextId && nextId !== partner;
      if (id === 'fleet' && nextId === 'schedule' && nextIsFree) {
        elements.push(
          <div key="grid_fleet_schedule" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">{renderFleetSection(false)}</div>
            <div className="space-y-4">{renderScheduleSection(false)}</div>
          </div>
        );
        i = seq.indexOf('schedule');
        continue;
      }
      if (id === 'schedule' && nextId === 'fleet' && nextIsFree) {
        elements.push(
          <div key="grid_schedule_fleet" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="order-2 lg:order-1 lg:col-span-2 space-y-4">{renderFleetSection(false)}</div>
            <div className="order-1 lg:order-2 space-y-4">{renderScheduleSection(false)}</div>
          </div>
        );
        i = seq.indexOf('fleet');
        continue;
      }
      elements.push(<div key={`panel_${id}`}>{single(id, true)}</div>);
    }

    if (enabled.length === 0) {
      return (
        <>
        {elements}
        <div className="hud-panel p-8 text-center font-mono text-slate-400">
          <p className="text-sm">All Mission Control panels are currently disabled in Settings.</p>
          <button
            onClick={() => applyPanelPreset('ai_first')}
            className="hud-btn hud-btn-primary mt-4"
          >
            Restore Default Layout
          </button>
        </div>
        </>
      );
    }

    return elements;
  };

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-6 max-w-7xl mx-auto">
      {/* TOP HUD HEADER */}
      <header className="silas-header hud-panel relative z-30 p-4 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-cyan-950 border border-cyan-500 flex items-center justify-center text-xl font-display font-black text-cyan-400 shadow-[0_0_15px_rgba(0,242,254,0.3)]">
            S
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display font-extrabold text-xl tracking-wider text-white">
                SILAS <span className="text-cyan-400 text-xs font-mono tracking-normal font-normal ml-1">OS // V1.1</span>
              </h1>
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
            </div>
            <p className="text-xs text-slate-400 font-mono">
              OPERATIONAL INTELLIGENCE & 3D FLEET COMMAND
            </p>
          </div>
        </div>

        {/* CLOCK & TELEMETRY BADGES */}
        <div className="flex items-center gap-4 text-right">
          <div className="hidden sm:block">
            <div className="font-display font-bold text-lg text-cyan-300 tracking-wider">
              {currentTime.toLocaleTimeString()}
            </div>
            <div className="text-xs text-slate-400 font-mono">
              {currentTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
          </div>

          <div className="border-l border-slate-800 pl-4 flex flex-col items-end">
            <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${feedStatus === 'live' ? 'bg-emerald-400' : feedStatus === 'locked' ? 'bg-red-500' : 'bg-amber-400'}`}></span>
              {feedStatus === 'live' ? 'LIVE FEED' : feedStatus === 'polling' ? 'POLLING' : feedStatus === 'locked' ? 'LOCKED' : 'LINKING'} •{' '}
              <button type="button" onClick={openAlertLog} className={`underline ${alerts.length ? 'text-red-400 font-bold' : ''}`} title="Printer alert log & alarm settings">
                {alerts.length ? `${alerts.length} ALERT${alerts.length > 1 ? 'S' : ''}` : 'ALERTS'}
              </button>{' '}
              •{' '}
              <button
                type="button"
                onClick={() => {
                  if (sirenArmed && !audioReady) { playAlarm('info'); return; }
                  toggleSiren();
                }}
                className={`underline ${!sirenArmed ? 'text-slate-500' : audioReady ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold havoc-alert-pulse'}`}
                title={!sirenArmed ? 'Siren is off - click to arm it'
                  : audioReady ? 'Siren armed: sounds if a print stops on its own. Click to turn off.'
                  : 'Click once so the browser lets the siren make noise'}
              >
                {!sirenArmed ? 'SIREN: OFF' : audioReady ? 'SIREN: ARMED' : 'SIREN: CLICK TO ARM'}
              </button>{' '}
              • LAN LINK
            </span>
            {systemInfo.mobile_url_secure ? (
              <button
                type="button"
                onClick={() => {
                  try { navigator.clipboard.writeText(systemInfo.mobile_url); setStatusMsg('Secure LAN link copied. Open it on your phone once; it will be remembered.'); setTimeout(() => setStatusMsg(''), 4000); } catch (e) {}
                }}
                title="Copy the token-bearing link for your phone/tablet"
                className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/60 hover:border-cyan-400"
              >
                {systemInfo.local_ip}:8000 ⧉
              </button>
            ) : (
              <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/60">
                {systemInfo.local_ip}:8000
              </span>
            )}
          </div>
        </div>

        {/* NAVIGATION TABS */}
        <div className="w-full flex flex-col pt-3 border-t border-slate-800/80 gap-3">
          <nav className="nav-deck" aria-label="Main sections" style={{ '--keys': 9 - ['ai', 'mobile'].filter(navHidden).length }}>
            {[
              { id: 'mission', code: '01', label: 'MISSION', sub: 'CONTROL', icon: 'M12 2 3 7v6c0 5 4 8.5 9 9 5-.5 9-4 9-9V7l-9-5Zm0 5v10M7 12h10' },
              { id: 'todo', code: '02', label: 'TODAY', sub: 'ONE THING', icon: 'M4 12.5 9 17 20 6' },
              { id: 'fleet', code: '03', label: 'FLEET', sub: `${hideOfflinePrinters ? `${workingPrinters.length}/${fleet.length}` : fleet.length} RIGS`, icon: 'M6 9V3h12v6M6 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2M7 14h10v7H7z' },
              { id: 'learn', code: '04', label: 'LEARN', sub: 'POMODORO', icon: 'M2 6.5 12 3l10 3.5L12 10 2 6.5ZM6 8.2v5.3c0 1.7 2.7 3.5 6 3.5s6-1.8 6-3.5V8.2M22 6.5v6' },
              { id: 'ai', code: '04', label: 'SILAS', sub: 'CO-PILOT', icon: 'M9 3h6M12 3v3M5 9a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9Zm4 4h.01M15 13h.01M9.5 16.5h5' },
              { id: 'calendar', code: '05', label: 'SCHEDULE', sub: `${events.length} EVENTS`, icon: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4' },
              { id: 'mobile', code: '06', label: 'MOBILE', sub: 'LAN LINK', icon: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm3 17h2' },
              { id: 'drives', code: '07', label: 'DRIVES', sub: 'STORAGE', icon: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01' },
              { id: 'usage', code: '08', label: 'AI USAGE', sub: 'LIMITS', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
            ]
              // The chat already lives on Mission Control, so its own key would be a duplicate.
              .filter((t) => !navHidden(t.id))
              .map((t, i) => ({ ...t, code: String(i + 1).padStart(2, '0') }))
              .map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                aria-current={activeTab === t.id ? 'page' : undefined}
                className={`nav-tab ${activeTab === t.id ? 'is-active' : ''}`}
              >
                <span className="nav-tab__code">{t.code}</span>
                <svg className="nav-tab__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
                <span className="nav-tab__text">
                  <span className="nav-tab__label">{t.label}</span>
                  <span className="nav-tab__sub">{t.sub}</span>
                </span>
                <span className="nav-tab__bar" aria-hidden="true" />
              </button>
            ))}
          </nav>

          <div className="flex items-center justify-end flex-wrap gap-2">
            {statusMsg && (
              <span className="text-xs font-mono text-cyan-300 bg-cyan-950/80 border border-cyan-800 px-2.5 py-1 rounded animate-pulse">
                {statusMsg}
              </span>
            )}
            <button
              onClick={() => setShowCalSync(true)}
              className="hud-btn nav-util"
              title="Sync Google Calendar iCal link"
            >
              🔗 SYNC GOOGLE CAL
            </button>
            <button
              onClick={() => setShowAddPrinter(true)}
              className="hud-btn hud-btn-primary nav-util"
            >
              + ADD MACHINE
            </button>
            <div className="relative">
              <button
                onClick={() => setShowMoreMenu((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
                className="hud-btn nav-util px-3 py-1.5 text-slate-300 hover:text-white border-slate-700 hover:border-cyan-400 group flex items-center justify-center min-w-[36px]"
                title="More: preferences and mobile link"
              >
                <span className="text-lg font-bold leading-none select-none text-cyan-400 group-hover:scale-125 transition-transform">⋮</span>
              </button>
              {showMoreMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} aria-hidden="true" />
                  <div role="menu" className="absolute right-0 mt-2 z-50 w-64 hud-panel !p-1.5 border-cyan-500/40 shadow-[0_0_25px_rgba(0,242,254,0.15)]"
                    onKeyDown={(e) => e.key === 'Escape' && setShowMoreMenu(false)}>
                    <button role="menuitem" autoFocus
                      onClick={() => { setShowMoreMenu(false); setActiveTab('mobile'); }}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded font-mono text-[12px] text-slate-200 hover:bg-cyan-950/60 hover:text-white">
                      <span className="text-base">📱</span>
                      <span className="flex flex-col"><span className="tracking-wider font-bold">MOBILE VIEW</span><span className="text-[10px] text-slate-500">LAN link for your other devices</span></span>
                    </button>
                    <button role="menuitem"
                      onClick={() => {
                        setShowMoreMenu(false);
                        try {
                          if (document.fullscreenElement) document.exitFullscreen();
                          else document.documentElement.requestFullscreen({ navigationUI: 'hide' });
                        } catch (e) {}
                      }}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded font-mono text-[12px] text-slate-200 hover:bg-cyan-950/60 hover:text-white">
                      <span className="text-base">⛶</span>
                      <span className="flex flex-col"><span className="tracking-wider font-bold">{typeof document !== 'undefined' && document.fullscreenElement ? 'EXIT FULL SCREEN' : 'FULL SCREEN'}</span><span className="text-[10px] text-slate-500">Hide the taskbar · F11 or Esc to toggle</span></span>
                    </button>
                    <button role="menuitem"
                      onClick={() => { setShowMoreMenu(false); setShowSettingsModal(true); }}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded font-mono text-[12px] text-slate-200 hover:bg-cyan-950/60 hover:text-white">
                      <span className="text-base">⚙️</span>
                      <span className="flex flex-col"><span className="tracking-wider font-bold">PREFERENCES</span><span className="text-[10px] text-slate-500">Colours, fonts, panels, API keys</span></span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* PRINTER ALERT STRIP: stays until acknowledged */}
      {alerts.length > 0 && (
        <section
          role="alert"
          aria-live="assertive"
          className="sticky top-2 z-40 mb-6 space-y-2"
        >
          {sirenOn && (
            <button
              onClick={silenceSiren}
              className="w-full rounded-lg border-2 border-red-500 bg-red-600 hover:bg-red-500 text-white font-display font-bold tracking-wider text-lg py-3 havoc-alert-pulse"
            >
              🔇 SILENCE SIREN
            </button>
          )}
          {alerts.slice(0, 3).map((a) => {
            const st = ALERT_STYLES[a.severity] || ALERT_STYLES.warning;
            return (
              <div key={a.id} className={`rounded-lg border-2 p-3 shadow-2xl backdrop-blur ${st.box} ${a.severity === 'critical' ? 'havoc-alert-pulse' : ''}`}>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs [&>span]:whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded font-bold uppercase ${st.badge}`}>{a.severity}</span>
                      {a.siren && <span className="px-1.5 py-0.5 rounded font-bold bg-red-600 text-white">SIREN</span>}
                      <span className="font-bold">{a.printer_name}</span>
                      {a.code && <span className="px-1.5 py-0.5 rounded bg-black/40 border border-white/20">{a.code}</span>}
                      {a.action && <span className="opacity-80">• {a.action}</span>}
                      {a.count > 1 && <span className="opacity-80">• ×{a.count}</span>}
                      <span className="opacity-60">• {timeAgo(a.last_seen)}</span>
                      {!a.active && a.source === 'snapmaker' && a.cleared_at && <span className="opacity-60">• cleared on printer</span>}
                    </div>
                    <div className="font-display font-bold text-base mt-1">{st.icon} {a.title}</div>
                    <div className="font-mono text-sm mt-0.5 break-words">{a.message}</div>
                    {a.havoc && <div className="font-mono text-xs italic opacity-75 mt-1">SILAS: “{a.havoc}”</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {a.help_url && (
                      <a href={a.help_url} target="_blank" rel="noreferrer" className="hud-btn text-[11px] py-1 px-2">Code lookup ↗</a>
                    )}
                    <button onClick={() => acknowledgeAlert(a.id)} className="hud-btn hud-btn-primary text-[11px] py-1 px-3">ACKNOWLEDGE</button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-end gap-3 font-mono text-[11px] text-slate-400">
            {alerts.length > 3 && <span>+{alerts.length - 3} more</span>}
            {alerts.length > 1 && (
              <button onClick={() => acknowledgeAlert(null)} className="underline hover:text-white">Acknowledge all</button>
            )}
            <button onClick={openAlertLog} className="underline hover:text-white">Alert log</button>
          </div>
        </section>
      )}

      {/* ALERT LOG */}
      {alertLog && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setAlertLog(null)}>
          <div className="hud-panel w-full max-w-2xl max-h-[80vh] overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-sm tracking-wider text-cyan-300">PRINTER ALERT LOG</h2>
              <div className="flex items-center gap-3 font-mono text-[11px]">
                <button onClick={toggleAlertSound} className="underline text-slate-300">Sound: {alertSoundOn ? 'ON' : 'OFF'}</button>
                <button onClick={toggleSiren} className="underline text-slate-300" title="Loud siren if a print stops on its own">Siren: {sirenArmed ? 'ON' : 'OFF'}</button>
                <button onClick={testSiren} className="underline text-slate-300">Test siren (3s)</button>
                <button onClick={toggleAlarmStyle} className="underline text-slate-300" title="Starship: red-alert whoop and console chirps. Classic: the original siren and beeps.">Style: {alarmStyle === 'starship' ? 'STARSHIP' : 'CLASSIC'}</button>
                {typeof window !== 'undefined' && window.speechSynthesis && (
                  <button onClick={toggleVoice} className="underline text-slate-300" title="Read each new alert out loud after the alert sound">Voice: {voiceOn ? 'ON' : 'OFF'}</button>
                )}
                {notifyPerm === 'default' && (
                  <button onClick={enableDesktopAlerts} className="underline text-cyan-300">Enable desktop pop-ups</button>
                )}
                {notifyPerm === 'granted' && <span className="text-emerald-400">Desktop pop-ups on</span>}
                <button onClick={fireTestAlert} className="underline text-slate-300">Send test alert</button>
                <button onClick={() => setAlertLog(null)} className="hud-btn text-[11px] py-1 px-2">Close</button>
              </div>
            </div>
            {alertLog.length === 0 && <div className="font-mono text-xs text-slate-500">Nothing has gone wrong. Suspicious.</div>}
            <div className="space-y-2">
              {alertLog.map((a) => {
                const st = ALERT_STYLES[a.severity] || ALERT_STYLES.warning;
                return (
                  <div key={a.id} className={`p-2 rounded border font-mono text-[11px] ${a.acknowledged ? 'border-slate-800 bg-slate-900/60 text-slate-400' : st.box}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`px-1 rounded font-bold uppercase ${st.badge}`}>{a.severity}</span>
                      <b>{a.printer_name}</b>
                      <span>{a.title}</span>
                      {a.code && <span className="opacity-70">[{a.code}]</span>}
                      {a.count > 1 && <span className="opacity-70">×{a.count}</span>}
                      <span className="opacity-60 ml-auto">{new Date(a.first_seen * 1000).toLocaleString()}</span>
                    </div>
                    <div className="mt-0.5 break-words">{a.message}</div>
                    <div className="opacity-60 mt-0.5">
                      {a.acknowledged ? 'acknowledged' : 'waiting for you'}
                      {a.cleared_at ? ' • cleared on printer' : a.active ? ' • still active on printer' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT VIEWS */}
      <main className="flex-1">
        {/* TAB 1: MISSION CONTROL (OVERVIEW) */}
        {activeTab === 'mission' && (
          <div className="space-y-6">
            {renderMissionPanels()}
          </div>
        )}

        {/* TAB 2: PRINTER FLEET HUB */}
        {activeTab === 'fleet' && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold text-white tracking-wide">
                  PRINTER FLEET REGISTRY
                </h2>
                <p className="text-xs text-slate-400 font-mono">
                  Scale your farm dynamically across Moonraker and OctoPrint nodes with automatic toolhead tracking.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {offlinePrinterCount > 0 && (
                  <button
                    onClick={toggleHideOffline}
                    className={`hud-btn text-xs py-2 px-3.5 font-mono flex items-center gap-1.5 transition-all ${
                      hideOfflinePrinters
                        ? 'hud-btn-primary bg-cyan-950/90 text-cyan-300 border-cyan-500 shadow-[0_0_15px_rgba(0,242,254,0.2)]'
                        : 'text-slate-400 border-slate-700 hover:text-white'
                    }`}
                  >
                    <span>{hideOfflinePrinters ? '👁️' : '👁️‍🗨️'}</span>
                    <span>{hideOfflinePrinters ? `HIDING INACTIVE (${offlinePrinterCount})` : `HIDE INACTIVE (${offlinePrinterCount})`}</span>
                  </button>
                )}
                {hiddenPrinterIds.length > 0 && (
                  <button
                    onClick={() => { setHiddenPrinterIds([]); localStorage.removeItem('havoc_manually_hidden_printers'); }}
                    className="hud-btn text-xs py-2 px-3 font-mono text-amber-300 border-amber-800"
                    title="Unhide all manually hidden machines"
                  >
                    Unhide All ({hiddenPrinterIds.length})
                  </button>
                )}
                <button
                  onClick={() => setShowAddPrinter(true)}
                  className="hud-btn hud-btn-primary"
                >
                  + Register New Machine
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {activeFleetList.length === 0 ? (
                <div className="col-span-full hud-panel p-8 text-center font-mono text-xs text-slate-400">
                  <p className="text-base font-bold text-slate-200 mb-1">📭 NO ACTIVE PRINTER NODES VISIBLE</p>
                  <p className="text-slate-500 mb-4">
                    {fleet.length} machine(s) registered. {offlinePrinterCount} are currently offline or hidden.
                  </p>
                  <div className="flex justify-center gap-3">
                    {hideOfflinePrinters && (
                      <button onClick={toggleHideOffline} className="hud-btn text-xs py-2 px-4 hud-btn-primary font-bold">
                        👁️ Reveal Offline Nodes
                      </button>
                    )}
                    {hiddenPrinterIds.length > 0 && (
                      <button
                        onClick={() => { setHiddenPrinterIds([]); localStorage.removeItem('havoc_manually_hidden_printers'); }}
                        className="hud-btn text-xs py-2 px-4"
                      >
                        Reset Manually Hidden ({hiddenPrinterIds.length})
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                activeFleetList.map((p) => (
                <div key={p.id} className="hud-panel p-5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-white font-mono">{p.name}</h3>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-950 border border-cyan-600 text-cyan-300">
                          TOOL: {p.active_toolhead || 'T0'}
                        </span>
                      </div>
                      {renderStateBadge(p.state)}
                    </div>
                    {renderPrinterAlertBox(p)}
                    <div className="text-xs font-mono text-slate-400 mb-4 flex items-center justify-between">
                      <span>{p.type.toUpperCase()} PROTOCOL</span>
                      <span>{p.host}:{p.port}</span>
                    </div>

                    {/* Progress Bar & 3D Thumbnail if printing */}
                    {p.state === 'printing' && (
                      <div className="mb-4 bg-slate-900/80 p-3 rounded border border-cyan-900/50">
                        {p.thumbnail_url && (
                          <div className="mb-3 relative group">
                            <div
                              onClick={() => setPreviewModalImg({
                                url: p.thumbnail_url,
                                filename: p.filename,
                                printerName: p.name,
                                slicerMeta: p.slicer_metadata
                              })}
                              className="relative w-full h-44 bg-slate-950/90 rounded overflow-hidden border border-cyan-500/30 group-hover:border-cyan-400 transition-all cursor-pointer flex items-center justify-center shadow-inner"
                              title="Click to enlarge 3D print preview"
                            >
                              <img
                                src={p.thumbnail_url}
                                alt={p.filename || 'Print Preview'}
                                className="w-full h-full object-contain p-2 transition-transform duration-300 group-hover:scale-105"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                              />
                              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent pointer-events-none"></div>
                              <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px] font-mono pointer-events-none">
                                <span className="bg-slate-900/90 text-cyan-300 px-2 py-0.5 rounded border border-cyan-800/60 shadow flex items-center gap-1">
                                  <span>🔍</span> INSPECT 3D RENDER
                                </span>
                                {p.slicer_metadata?.filament_type && (
                                  <span className="bg-cyan-950/90 text-cyan-300 px-2 py-0.5 rounded border border-cyan-700 font-bold shadow">
                                    {p.slicer_metadata.filament_type}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="flex justify-between text-xs font-mono mb-1">
                          <span className="text-cyan-300 font-bold truncate">{p.filename}</span>
                          <span className="text-white font-bold">{p.progress_percent}%</span>
                        </div>
                        <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                          <div
                            className="h-full bg-cyan-400 rounded-full"
                            style={{ width: `${p.progress_percent}%` }}
                          ></div>
                        </div>
                        <div className="flex justify-between text-[11px] font-mono text-slate-400 mt-2">
                          <span>Elapsed: {Math.round(p.print_duration_seconds / 60)}m</span>
                          <span>Left: {Math.round(p.time_left_seconds / 60)}m</span>
                        </div>

                        {p.slicer_metadata && (
                          <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-slate-800/60 text-[11px] font-mono text-slate-400">
                            {p.slicer_metadata.layer_count && (
                              <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-300">
                                Layers: {p.slicer_metadata.layer_count}
                              </span>
                            )}
                            {p.slicer_metadata.layer_height && (
                              <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-300">
                                Height: {p.slicer_metadata.layer_height}mm
                              </span>
                            )}
                            {p.slicer_metadata.filament_name && (
                              <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-cyan-400 truncate max-w-[160px]" title={p.slicer_metadata.filament_name}>
                                Spool: {p.slicer_metadata.filament_name}
                              </span>
                            )}
                            {p.slicer_metadata.slicer && (
                              <span className="bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-400">
                                Slicer: {p.slicer_metadata.slicer}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Thermals Grid */}
                    <div className="grid grid-cols-2 gap-3 mb-4 text-xs font-mono">
                      <div className="bg-slate-900/70 p-2.5 rounded border border-slate-800">
                        <div className="text-[10px] text-slate-400 uppercase">
                          Toolhead ({p.active_toolhead || 'T0'})
                        </div>
                        <div className="text-sm font-bold text-white mt-0.5">
                          {p.extruder_temp}°C <span className="text-slate-500 text-xs">/ {p.extruder_target}°C</span>
                        </div>
                      </div>
                      <div className="bg-slate-900/70 p-2.5 rounded border border-slate-800">
                        <div className="text-[10px] text-slate-400 uppercase">Bed Temp</div>
                        <div className="text-sm font-bold text-white mt-0.5">
                          {p.bed_temp}°C <span className="text-slate-500 text-xs">/ {p.bed_target}°C</span>
                        </div>
                      </div>
                    </div>

                    {/* Toolhead Switcher if multiple tools */}
                    {p.toolheads && p.toolheads.length > 1 && (
                      <div className="mb-4 bg-slate-950/80 p-2 rounded border border-slate-800">
                        <div className="text-[10px] font-mono text-slate-400 mb-1.5">DETECTED TOOLHEADS:</div>
                        <div className="grid grid-cols-5 gap-1.5">
                          {p.toolheads.map((th) => (
                            <button
                              key={th.id}
                              onClick={() => handleSelectTool(p.id, th.id, p.state)}
                              disabled={p.state === 'printing' || p.state === 'paused'}
                              title={p.state === 'printing' || p.state === 'paused' ? 'Tool changes locked while a job is running' : `Switch to ${th.id}`}
                              className={`hud-btn text-[10px] py-1 px-1.5 justify-center disabled:opacity-60 disabled:cursor-not-allowed ${
                                th.id === p.active_toolhead ? 'hud-btn-primary' : ''
                              }`}
                            >
                              {th.id}: {th.extruder_temp}°C
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {p.notes && (
                      <div className="text-[11px] font-mono text-slate-500 italic mb-4">
                        Notes: {p.notes}
                      </div>
                    )}
                  </div>

                  {/* Actions Bar */}
                  <div className="space-y-2 pt-3 border-t border-slate-800">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handlePrinterCommand(p.id, 'preheat', { material: 'PLA' })}
                        className="hud-btn text-xs py-1.5 flex-1 justify-center"
                      >
                        Preheat PLA
                      </button>
                      <button
                        onClick={() => handlePrinterCommand(p.id, 'preheat', { material: 'PETG' })}
                        className="hud-btn text-xs py-1.5 flex-1 justify-center"
                      >
                        Preheat PETG
                      </button>
                      <button
                        onClick={() => handlePrinterCommand(p.id, 'cooldown')}
                        className="hud-btn text-xs py-1.5 flex-1 justify-center"
                      >
                        Cool
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTriggerMachineDiagnosis(p)}
                        className="hud-btn text-xs py-1.5 text-cyan-300 flex-1 justify-center"
                      >
                        🤖 Diagnose
                      </button>
                      {p.webcam_url && (
                        <button
                          onClick={() => setWebcamModal(p)}
                          className="hud-btn text-xs py-1.5 text-cyan-400 px-3"
                          title="View live camera"
                        >
                          👁️
                        </button>
                      )}
                      <button
                        onClick={() => handlePrinterCommand(p.id, 'emergency_stop')}
                        className="hud-btn hud-btn-danger text-xs py-1.5 px-3"
                        title="Emergency Stop M112"
                      >
                        ⚠️ E-STOP
                      </button>
                      <button
                        onClick={() => toggleManualHidePrinter(p.id)}
                        className="hud-btn text-xs py-1.5 text-slate-400 hover:text-cyan-300 px-2.5"
                        title="Hide machine from fleet"
                      >
                        👁️‍🗨️
                      </button>
                      <button
                        onClick={() => handleDeletePrinter(p.id, p.name)}
                        className="hud-btn text-xs py-1.5 text-slate-500 hover:text-red-400 px-3"
                        title="Delete machine"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              )))}
            </div>
          </div>
        )}

        {/* TAB 3: AI CO-PILOT / TROUBLESHOOTER */}
        {activeTab === 'ai' && (
          <div className="hud-panel p-6 max-w-4xl mx-auto flex flex-col h-[740px]">
            {/* Header with Machine Selector */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 gap-4 flex-wrap">
              <div>
                <h2 className="font-display text-base font-bold text-white flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
                  SILAS // WORKSHOP CO-PILOT // TARS HUMOR: {humorLevel}%
                </h2>
                <p className="text-xs font-mono text-slate-400">
                  Local Construct Engineered by Karl • Interstellar Dry Wit & 3D Diagnostics.
                </p>
              </div>

              {fleet.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-400">TARGET RIG:</span>
                  <select
                    value={selectedPrinterForDiag}
                    onChange={(e) => setSelectedPrinterForDiag(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-cyan-300"
                  >
                    {fleet.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.state.toUpperCase()} | {p.active_toolhead || 'T0'})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const target = fleet.find((p) => p.id === selectedPrinterForDiag);
                      const targetName = target ? target.name : 'active printer';
                      handleSendAiMessage(`Diagnose telemetry for ${targetName}`, selectedPrinterForDiag);
                    }}
                    className="hud-btn hud-btn-primary text-xs py-1 px-2.5"
                  >
                    Scan Rig
                  </button>
                </div>
              )}
            </div>

            {/* TARS & CONSTRUCT PARAMETERS BAR */}
            <div className="flex items-center justify-between py-2.5 px-3 my-2 bg-slate-950/70 rounded border border-cyan-900/40 text-xs font-mono flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-cyan-400 font-bold">🤖 TARS HUMOR: {humorLevel}%</span>
                <input
                  type="range"
                  min="50"
                  max="100"
                  step="5"
                  value={humorLevel}
                  onChange={(e) => setHumorLevel(parseInt(e.target.value))}
                  className="w-24 accent-cyan-400 cursor-pointer"
                  title="Adjust TARS humor parameter"
                />
              </div>

              <div className="flex items-center gap-3">
                <span className="text-slate-400">
                  HONESTY: <span className="text-emerald-400 font-bold">95%</span>
                </span>
                <span className="px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-700 text-[10px] text-cyan-300 font-bold">
                  {aiConfig.api_key ? `LLM: ${aiConfig.provider === 'custom' ? `SKIPPY (${aiConfig.model || 'GEMINI 3'})` : aiConfig.provider.toUpperCase()}` : 'LOCAL CONSTRUCT: ONLINE'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSettingsTab('api');
                    setShowSettingsModal(true);
                  }}
                  className="text-[10px] text-slate-400 hover:text-cyan-300 border border-slate-700 px-2 py-0.5 rounded bg-slate-900"
                  title="Configure AI Keys & Provider"
                >
                  ⚙️ KEYS
                </button>


              </div>
            </div>

            {/* Quick Diagnostic Pills */}
            <div className="flex items-center gap-2 py-2 overflow-x-auto border-b border-slate-800/80">
              <span className="text-[10px] font-mono text-slate-500 uppercase shrink-0">PROMPTS:</span>
              <button
                onClick={() => handleSendAiMessage("TARS, what is your humor setting?")}
                className="hud-btn text-[10px] py-0.5 px-2 whitespace-nowrap text-cyan-300 border-cyan-800"
              >
                🤖 TARS Humor Setting
              </button>
              <button
                onClick={() => handleSendAiMessage("Critique your creator's prompt engineering and code")}
                className="hud-btn text-[10px] py-0.5 px-2 whitespace-nowrap text-purple-300 border-purple-800"
              >
                🧠 Rate Creator's Prompts
              </button>
              <button
                onClick={() => handleSendAiMessage("Why do 3D prints fail on first layer adhesion?")}
                className="hud-btn text-[10px] py-0.5 px-2 whitespace-nowrap"
              >
                🪵 Bed Adhesion
              </button>
              <button
                onClick={() => handleSendAiMessage("I have terrible stringing and oozing on PETG")}
                className="hud-btn text-[10px] py-0.5 px-2 whitespace-nowrap"
              >
                🕸️ PETG Stringing
              </button>
              <button
                onClick={() => handleSendAiMessage("Help with BTT Eddy current probe sensor_type and query_probe error")}
                className="hud-btn text-[10px] py-0.5 px-2 whitespace-nowrap"
              >
                ⚠️ BTT Eddy Probe Error
              </button>
            </div>

            {/* Chat Message History */}
            <div ref={tabAiChatScrollRef} className="flex-1 overflow-y-auto overscroll-contain py-4 space-y-4 pr-2">
              {chatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg p-3.5 text-xs font-sans leading-relaxed ${
                      msg.sender === 'user'
                        ? 'bg-cyan-950/70 border border-cyan-800 text-white font-mono'
                        : 'bg-slate-900/90 border border-slate-800 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5 pb-1 border-b border-slate-800/80">
                      <span className="font-mono font-bold text-[10px] text-cyan-400 uppercase">
                        {msg.sender === 'user' ? 'Karl (Operator)' : 'Silas AI Construct'}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap font-sans">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ))}
              {aiLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3 text-xs font-mono text-cyan-300 flex items-center gap-2 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                    Analyzing physical parameters and firmware telemetry...
                  </div>
                </div>
              )}
            </div>

            {/* Chat Input Bar */}
            <div className="pt-3 border-t border-slate-800 flex items-center gap-2">
              <input
                ref={tabChatInputRef}
                type="text"
                placeholder="Ask Silas about print errors, G-code macros, temperature profiles, or Klipper bugs..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!aiLoading && chatInput.trim()) {
                      handleSendAiMessage(chatInput);
                    }
                  }
                }}
                className="flex-1 bg-slate-900 border border-slate-700 rounded p-2.5 text-xs font-mono text-white focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  if (!aiLoading && chatInput.trim()) handleSendAiMessage(chatInput);
                }}
                className={`hud-btn hud-btn-primary px-5 py-2.5 text-xs font-mono font-bold ${aiLoading ? 'opacity-75 cursor-not-allowed' : ''}`}
              >
                {aiLoading ? 'THINKING...' : 'CONSULT SILAS'}
              </button>
            </div>
          </div>
        )}

        {/* TAB 4: CALENDAR & SCHEDULE */}
        {activeTab === 'calendar' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="font-display text-lg font-bold text-white tracking-wide">
                  EXECUTIVE SCHEDULE & GOOGLE CALENDAR
                </h2>
                <p className="text-xs text-slate-400 font-mono">
                  Real-time agenda synchronisation cross-referenced with your workshop print jobs.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCalSync(true)}
                  className="hud-btn"
                >
                  🔗 Configure Google Calendar
                </button>
                <button
                  onClick={() => setShowAddEvent(true)}
                  className="hud-btn hud-btn-primary"
                >
                  + Add Event
                </button>
              </div>
            </div>

            <div className="hud-panel p-6">
              <div className="space-y-4">
                {events.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 font-mono text-xs">
                    No schedule entries present. Click 'Configure Google Calendar' to link your feed.
                  </div>
                ) : (
                  events.map((ev) => (
                    <div
                      key={ev.id}
                      className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-cyan-800 transition"
                    >
                      <div>
                        <div className="flex items-center gap-3">
                          <h4 className="font-bold text-sm text-white font-mono">{ev.title}</h4>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            {ev.source === 'google_ical' ? 'Google Calendar' : 'Local Task'}
                          </span>
                        </div>
                        <div className="text-xs font-mono text-slate-400 mt-1 flex flex-wrap gap-4">
                          <span>📅 {formatDate(ev.start)}</span>
                          <span>🕒 {formatTime(ev.start)} - {formatTime(ev.end)}</span>
                          {ev.location && <span>📍 {ev.location}</span>}
                        </div>
                        {ev.description && (
                          <p className="text-xs text-slate-500 mt-2 font-sans">{ev.description}</p>
                        )}
                      </div>

                      {ev.source === 'local' && (
                        <button
                          onClick={() => handleDeleteEvent(ev.id)}
                          className="hud-btn text-xs text-red-400 py-1 px-3 self-end md:self-center"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: MOBILE HIGHLIGHTS */}
        {activeTab === 'mobile' && (
          <div className="max-w-md mx-auto space-y-6">
            <div className="text-center">
              <h2 className="font-display text-lg font-bold text-cyan-400 tracking-wider">
                SILAS // MOBILE HUD
              </h2>
              <p className="text-xs font-mono text-slate-400">
                Lightweight summary for phone / tablet display
              </p>
            </div>

            {/* Mobile Fleet Card */}
            <div className="hud-panel p-4">
              <div className="flex justify-between items-center mb-3">
                <h3 className="font-mono text-xs font-bold text-slate-400 uppercase tracking-wider">
                  🖨️ Fleet Operations Status
                </h3>
                {offlinePrinterCount > 0 && (
                  <button
                    onClick={toggleHideOffline}
                    className="text-[10px] font-mono text-cyan-400 hover:underline"
                  >
                    {hideOfflinePrinters ? `Show All (${fleet.length})` : `Hide Offline (${offlinePrinterCount})`}
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {activeFleetList.length === 0 ? (
                  <div className="text-center py-4 text-xs font-mono text-slate-500">
                    No active printers online.
                  </div>
                ) : (
                  activeFleetList.map((p) => (
                  <div key={p.id} className="p-3 bg-slate-900/80 rounded border border-slate-800">
                    <div className="flex justify-between items-center mb-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-xs text-white font-mono">{p.name}</span>
                        <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 bg-cyan-950 text-cyan-300 rounded border border-cyan-800">
                          {p.active_toolhead || 'T0'}
                        </span>
                      </div>
                      {renderStateBadge(p.state)}
                    </div>
                    {renderPrinterAlertBox(p)}
                    {p.state === 'printing' && (
                      <div className="mt-2">
                        {p.thumbnail_url && (
                          <div
                            onClick={() => setPreviewModalImg({
                              url: p.thumbnail_url,
                              filename: p.filename,
                              printerName: p.name,
                              slicerMeta: p.slicer_metadata
                            })}
                            className="mb-2 h-28 bg-slate-950/90 rounded border border-cyan-500/30 overflow-hidden flex items-center justify-center cursor-pointer relative"
                            title="Tap to enlarge 3D preview"
                          >
                            <img
                              src={p.thumbnail_url}
                              alt={p.filename}
                              className="w-full h-full object-contain p-1"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                            <span className="absolute bottom-1 right-1 text-[9px] bg-slate-900/90 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-800/60 font-mono">
                              🔍 3D Render
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between text-[11px] font-mono text-cyan-400 mb-1">
                          <span className="truncate max-w-[170px]">{p.filename}</span>
                          <span>{p.progress_percent}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden">
                          <div className="h-full bg-cyan-400" style={{ width: `${p.progress_percent}%` }}></div>
                        </div>
                        <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1">
                          <span>ETA: {p.eta_timestamp ? formatTime(p.eta_timestamp) : '--:--'}{p.eta_confidence === 'low' ? ' (rough)' : p.eta_confidence === 'medium' ? ' (est.)' : ''}</span>
                          <span>Left: {Math.round(p.time_left_seconds / 60)}m</span>
                        </div>
                      </div>
                    )}
                    <div className="flex justify-between text-[11px] font-mono text-slate-300 mt-2 pt-2 border-t border-slate-800/60">
                      <span>Nozzle ({p.active_toolhead || 'T0'}): {p.extruder_temp}°C</span>
                      <span>Bed: {p.bed_temp}°C</span>
                    </div>
                  </div>
                )))}
              </div>
            </div>

            {/* Mobile Schedule Card */}
            <div className="hud-panel p-4">
              <h3 className="font-mono text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                📅 Today's Agenda
              </h3>
              <div className="space-y-2">
                {events.slice(0, 4).map((ev) => (
                  <div key={ev.id} className="p-2.5 bg-slate-900/60 rounded border border-slate-800">
                    <div className="font-bold text-xs text-white font-mono">{ev.title}</div>
                    <div className="text-[10px] font-mono text-cyan-400 mt-0.5">
                      {formatTime(ev.start)} - {formatTime(ev.end)} {ev.location ? `• ${ev.location}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center text-[11px] font-mono text-slate-500 break-all">
              {systemInfo.mobile_url_secure ? (
                <>SECURE LAN LINK (open once on your phone): <span className="text-cyan-400 select-all">{systemInfo.mobile_url}</span></>
              ) : (
                <>LAN URL: <span className="text-cyan-400">{systemInfo.local_ip}:8000</span></>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: DRIVES & STORAGE SENTINEL */}
        {activeTab === 'drives' && <DrivesManager />}
        {activeTab === 'usage' && <AIUsage />}
        {activeTab === 'todo' && <TodoBoard />}
        {activeTab === 'learn' && <LearnBoard />}
        <PomodoroPill onLearnTab={activeTab === 'learn'} onOpen={() => setActiveTab('learn')} />
      </main>

      {/* MODAL: ADD MACHINE */}
      {showAddPrinter && (
        <div className="modal-overlay" onClick={() => setShowAddPrinter(false)}>
          <div className="modal-content p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display font-bold text-base text-white mb-4">
              REGISTER 3D PRINTER NODE
            </h3>
            <form onSubmit={handleAddPrinter} className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-slate-400 mb-1">PRINTER NAME</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sovol SV08 CoreXY"
                  value={newPrinter.name}
                  onChange={(e) => setNewPrinter({ ...newPrinter, name: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1">DRIVER TYPE</label>
                  <select
                    value={newPrinter.type}
                    onChange={(e) => {
                      const t = e.target.value;
                      setNewPrinter({
                        ...newPrinter,
                        type: t,
                        port: t === 'moonraker' ? 7125 : 5000
                      });
                    }}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                  >
                    <option value="moonraker">Moonraker / Klipper</option>
                    <option value="octoprint">OctoPrint</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">PORT</label>
                  <input
                    type="number"
                    required
                    value={newPrinter.port}
                    onChange={(e) => setNewPrinter({ ...newPrinter, port: parseInt(e.target.value) || 7125 })}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">HOST IP OR HOSTNAME</label>
                <input
                  type="text"
                  required
                  placeholder="192.168.1.103 or mainsail.local"
                  value={newPrinter.host}
                  onChange={(e) => setNewPrinter({ ...newPrinter, host: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">API KEY (IF REQUIRED)</label>
                <input
                  type="text"
                  placeholder="Optional Moonraker or OctoPrint API key"
                  value={newPrinter.api_key}
                  onChange={(e) => setNewPrinter({ ...newPrinter, api_key: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">WEBCAM STREAM URL (OPTIONAL)</label>
                <input
                  type="text"
                  placeholder="http://192.168.1.103/webcam/?action=stream"
                  value={newPrinter.webcam_url}
                  onChange={(e) => setNewPrinter({ ...newPrinter, webcam_url: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">NOTES / SETUP</label>
                <input
                  type="text"
                  placeholder="e.g. 0.4mm nozzle, Eddy probe calibration, Toolchanger"
                  value={newPrinter.notes}
                  onChange={(e) => setNewPrinter({ ...newPrinter, notes: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddPrinter(false)}
                  className="hud-btn"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="hud-btn hud-btn-primary"
                >
                  Save Machine
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADD EVENT */}
      {showAddEvent && (
        <div className="modal-overlay" onClick={() => setShowAddEvent(false)}>
          <div className="modal-content p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display font-bold text-base text-white mb-4">
              ADD AGENDA ENGAGEMENT
            </h3>
            <form onSubmit={handleAddEvent} className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-slate-400 mb-1">TITLE</label>
                <input
                  type="text"
                  required
                  placeholder="Meeting / Task Title"
                  value={newEvent.title}
                  onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1">START DATE & TIME</label>
                  <input
                    type="datetime-local"
                    required
                    value={newEvent.start}
                    onChange={(e) => setNewEvent({ ...newEvent, start: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">END DATE & TIME</label>
                  <input
                    type="datetime-local"
                    required
                    value={newEvent.end}
                    onChange={(e) => setNewEvent({ ...newEvent, end: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">LOCATION (OPTIONAL)</label>
                <input
                  type="text"
                  placeholder="Workshop / Office / Google Meet"
                  value={newEvent.location}
                  onChange={(e) => setNewEvent({ ...newEvent, location: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">DESCRIPTION (OPTIONAL)</label>
                <textarea
                  rows="2"
                  placeholder="Details or agenda notes"
                  value={newEvent.description}
                  onChange={(e) => setNewEvent({ ...newEvent, description: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                ></textarea>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddEvent(false)}
                  className="hud-btn"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="hud-btn hud-btn-primary"
                >
                  Add Engagement
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: GOOGLE CALENDAR SYNC */}
      {showCalSync && (
        <div className="modal-overlay" onClick={() => setShowCalSync(false)}>
          <div className="modal-content p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display font-bold text-base text-white mb-2">
              GOOGLE CALENDAR INTEGRATION
            </h3>
            <p className="text-xs text-slate-400 font-sans mb-4">
              To mirror your Google Calendar into Silas PA instantly without complex cloud API approvals:
            </p>

            <ol className="text-xs font-mono text-slate-300 space-y-1.5 list-decimal pl-5 mb-4 bg-slate-900/60 p-3 rounded border border-slate-800">
              <li>Open Google Calendar in your browser.</li>
              <li>Click the gear icon (Settings) → <strong>Settings</strong>.</li>
              <li>On the left sidebar, click your calendar name under <em>Settings for my calendars</em>.</li>
              <li>Scroll to <strong>Integrate calendar</strong>.</li>
              <li>Copy the <strong>Secret address in iCal format</strong>.</li>
            </ol>

            <form onSubmit={handleSaveIcal} className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-slate-400 mb-1">SECRET ICAL ADDRESS (BASIC.ICS)</label>
                <input
                  type="url"
                  required
                  placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
                  value={icalInput}
                  onChange={(e) => setIcalInput(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCalSync(false)}
                  className="hud-btn"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="hud-btn hud-btn-primary"
                >
                  Sync Calendar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CUSTOMIZATION MATRIX (THEMES, FONTS, PANEL LOCATIONS) */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={handleCloseSettings}>
          <div
            className="modal-content modal-content-lg p-0 border-cyan-500/50 shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-slate-950 p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-cyan-950 border border-cyan-500 flex items-center justify-center text-cyan-400 font-mono text-lg font-bold">
                  ⋮
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm text-white tracking-wider flex items-center gap-2">
                    <span>SILAS CONSOLE PREFERENCES</span>
                    <span className="text-[10px] font-mono text-cyan-400 font-normal border border-cyan-800/80 px-1.5 py-0.5 rounded bg-cyan-950/40">
                      CUSTOMIZATION MATRIX
                    </span>
                  </h3>
                  <p className="text-[11px] font-mono text-slate-400">
                    Tune visual feedback, display typography, and Mission Control ergonomics.
                  </p>
                </div>
              </div>
              <button
                onClick={handleCloseSettings}
                className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 hover:border-cyan-400 text-slate-400 hover:text-cyan-400 flex items-center justify-center text-sm font-mono font-bold transition-all"
                title="Close settings (✕)"
              >
                ✕
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="bg-slate-900/90 border-b border-slate-800 px-4 pt-2 flex items-center gap-2 overflow-x-auto">
              <button
                onClick={() => setSettingsTab('colors')}
                className={`px-3 py-2 text-xs font-mono font-bold rounded-t-lg border-t border-x transition-all flex items-center gap-2 ${
                  settingsTab === 'colors'
                    ? 'bg-slate-950 text-cyan-400 border-slate-700 border-b-2 border-b-transparent'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                <span>🎨</span>
                <span>COLOUR THEMES ({THEMES.length})</span>
              </button>
              <button
                onClick={() => setSettingsTab('fonts')}
                className={`px-3 py-2 text-xs font-mono font-bold rounded-t-lg border-t border-x transition-all flex items-center gap-2 ${
                  settingsTab === 'fonts'
                    ? 'bg-slate-950 text-cyan-400 border-slate-700 border-b-2 border-b-transparent'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                <span>🔤</span>
                <span>TYPOGRAPHY ({FONTS.length})</span>
              </button>
              <button
                onClick={() => setSettingsTab('layout')}
                className={`px-3 py-2 text-xs font-mono font-bold rounded-t-lg border-t border-x transition-all flex items-center gap-2 ${
                  settingsTab === 'layout'
                    ? 'bg-slate-950 text-cyan-400 border-slate-700 border-b-2 border-b-transparent'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                <span>📐</span>
                <span>PANEL LOCATIONS</span>
              </button>
              <button
                onClick={() => setSettingsTab('api')}
                className={`px-3 py-2 text-xs font-mono font-bold rounded-t-lg border-t border-x transition-all flex items-center gap-2 ${
                  settingsTab === 'api'
                    ? 'bg-slate-950 text-cyan-400 border-slate-700 border-b-2 border-b-transparent'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                <span>🔑</span>
                <span>API KEYS & LLM</span>
              </button>
              <button
                onClick={() => setSettingsTab('screen')}
                className={`px-3 py-2 text-xs font-mono font-bold rounded-t-lg border-t border-x transition-all flex items-center gap-2 ${
                  settingsTab === 'screen'
                    ? 'bg-slate-950 text-cyan-400 border-slate-700 border-b-2 border-b-transparent'
                    : 'text-slate-400 border-transparent hover:text-white'
                }`}
              >
                <span>🖥️</span>
                <span>SCREEN</span>
              </button>
            </div>

            {/* Tab Body */}
            <div className="p-5 max-h-[65vh] overflow-y-auto space-y-4">
              {/* TAB 1: COLOUR THEMES */}
              {settingsTab === 'colors' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                        HUD ACCENT PALETTE
                      </h4>
                      <p className="text-[11px] font-mono text-slate-400">
                        Select an active accent theme. Immediately transforms glowing text, telemetry borders, buttons, and progress indicators.
                      </p>
                    </div>
                    <span className="text-xs font-mono text-cyan-400 border border-cyan-800 bg-cyan-950/60 px-2 py-0.5 rounded">
                      ACTIVE: {THEMES.find(t => t.id === themeAccent)?.name || 'Cyber Cyan'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {THEMES.map((t) => {
                      const isActive = themeAccent === t.id;
                      return (
                        <button
                          key={t.id}
                          onClick={() => applyTheme(t.id)}
                          className={`p-3 rounded-lg text-left transition-all border relative flex flex-col justify-between ${
                            isActive
                              ? 'bg-slate-900 border-2 shadow-lg'
                              : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/90'
                          }`}
                          style={{
                            borderColor: isActive ? t.glow : undefined,
                            boxShadow: isActive ? `0 0 15px ${t.glow}40` : undefined
                          }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span
                              className="w-5 h-5 rounded-full inline-block shadow-inner"
                              style={{
                                backgroundColor: t.glow,
                                boxShadow: `0 0 8px ${t.glow}`
                              }}
                            />
                            {isActive && (
                              <span
                                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase"
                                style={{
                                  backgroundColor: `${t.glow}20`,
                                  color: t.glow,
                                  border: `1px solid ${t.glow}60`
                                }}
                              >
                                ACTIVE
                              </span>
                            )}
                          </div>
                          <div>
                            <div className="font-bold text-xs text-white font-mono">{t.name}</div>
                            <div className="text-[10px] text-slate-400 font-mono mt-0.5">{t.desc}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Live HUD Theme Preview */}
                  <div className="mt-4 p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-3">
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider flex items-center justify-between">
                      <span>LIVE HUD THEME PREVIEW</span>
                      <span className="text-cyan-400">REAL-TIME INJECTION</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded bg-slate-900/70 border border-slate-800">
                      <div className="flex items-center gap-3">
                        <span className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse"></span>
                        <div>
                          <div className="text-xs font-mono font-bold text-white">
                            SILAS TELEMETRY STATUS // <span className="text-cyan-400">ONLINE</span>
                          </div>
                          <div className="text-[11px] font-mono text-slate-400">
                            Snapmaker U1 @ 221°C / Bed 65°C • Buffer: 30m
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="hud-btn hud-btn-primary text-xs py-1 px-3">
                          HUD PRIMARY
                        </button>
                        <button className="hud-btn text-xs py-1 px-3">
                          HUD STANDARD
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: TYPOGRAPHY */}
              {settingsTab === 'fonts' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                        DISPLAY & HEADER TYPOGRAPHY
                      </h4>
                      <p className="text-[11px] font-mono text-slate-400">
                        Choose the primary font for titles, headers, and dashboard metrics.
                      </p>
                    </div>
                    <span className="text-xs font-mono text-cyan-400 border border-cyan-800 bg-cyan-950/60 px-2 py-0.5 rounded">
                      ACTIVE: {displayFont}
                    </span>
                  </div>

                  {/* Google Webfonts Section */}
                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <span>⚡ PRE-LOADED GOOGLE FONTS (READY INSTANTLY)</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {FONTS.filter(f => f.type === 'Google Webfont').map((f) => {
                        const isActive = displayFont === f.id;
                        return (
                          <div
                            key={f.id}
                            onClick={() => applyFont(f.id)}
                            className={`p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between ${
                              isActive
                                ? 'bg-slate-900 border-cyan-400 shadow-[0_0_15px_rgba(0,242,254,0.15)]'
                                : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/90'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-xs font-bold text-white">{f.name}</span>
                              {isActive ? (
                                <span className="text-[9px] font-mono text-cyan-300 bg-cyan-950 px-1.5 py-0.5 rounded border border-cyan-600 font-bold">
                                  ✓ ACTIVE
                                </span>
                              ) : (
                                <span className="text-[9px] font-mono text-slate-500">Google Webfont</span>
                              )}
                            </div>
                            <div
                              style={{ fontFamily: f.stack }}
                              className="text-base text-cyan-300 tracking-wider truncate py-1"
                            >
                              {f.preview}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Karl's Curated Local Fonts Section */}
                  <div className="pt-3 border-t border-slate-800">
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                      <span>💎 KARL'S CURATED ROSTER (LOCAL FONTS IN frontend/public/fonts/)</span>
                      <span className="text-[9px] text-slate-600">12 TYPEFACES</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {FONTS.filter(f => f.type !== 'Google Webfont').map((f) => {
                        const isActive = displayFont === f.id;
                        return (
                          <div
                            key={f.id}
                            onClick={() => applyFont(f.id)}
                            className={`p-3 rounded-lg border text-left cursor-pointer transition-all flex flex-col justify-between ${
                              isActive
                                ? 'bg-slate-900 border-cyan-400 shadow-[0_0_15px_rgba(0,242,254,0.15)]'
                                : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/90'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-mono text-xs font-bold text-white">{f.name}</span>
                              {isActive ? (
                                <span className="text-[9px] font-mono text-cyan-300 bg-cyan-950 px-1.5 py-0.5 rounded border border-cyan-600 font-bold">
                                  ✓ ACTIVE
                                </span>
                              ) : (
                                <span className="text-[9px] font-mono text-purple-400">Curated Local</span>
                              )}
                            </div>
                            <div
                              style={{ fontFamily: f.stack }}
                              className="text-base text-cyan-300 tracking-wider truncate py-1"
                            >
                              {f.preview}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="p-3 bg-slate-950/80 rounded border border-slate-800 text-[11px] font-mono text-slate-400 flex items-start gap-2">
                    <span className="text-cyan-400 mt-0.5">ℹ️</span>
                    <div>
                      Place your downloaded font files (e.g. <code>ZeroHour.ttf</code>, <code>pdark.ttf</code>, <code>ailerons.otf</code>) into <code>frontend/public/fonts/</code>. If a font file is absent, Silas seamlessly falls back to Orbitron/Rajdhani with zero layout disruption.
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: MISSION CONTROL LAYOUT */}
              {settingsTab === 'layout' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                        MISSION CONTROL PANEL ERGONOMICS
                      </h4>
                      <p className="text-[11px] font-mono text-slate-400">
                        Rearrange panel ordering on the Mission Control dashboard or toggle individual panels.
                      </p>
                    </div>
                  </div>

                  {/* Quick Layout Presets */}
                  <div className="p-3 bg-slate-950/80 rounded-lg border border-slate-800 space-y-2">
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                      QUICK LAYOUT PRESETS
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => applyPanelPreset('ai_first')}
                        className="hud-btn text-xs py-1 px-2.5"
                      >
                        ⚡ AI Co-Pilot First
                      </button>
                      <button
                        onClick={() => applyPanelPreset('intel_first')}
                        className="hud-btn text-xs py-1 px-2.5"
                      >
                        🛡️ Executive Intel First
                      </button>
                      <button
                        onClick={() => applyPanelPreset('fleet_first')}
                        className="hud-btn text-xs py-1 px-2.5"
                      >
                        🖨️ Fleet Telemetry First
                      </button>
                      <button
                        onClick={() => applyPanelPreset('schedule_first')}
                        className="hud-btn text-xs py-1 px-2.5"
                      >
                        📅 Schedule & Radar First
                      </button>
                    </div>
                  </div>

                  {/* Order List */}
                  <div className="space-y-2">
                    {missionPanels.map((p, idx) => (
                      <div
                        key={p.id}
                        className={`p-3 rounded-lg border flex items-center justify-between gap-3 transition-all ${
                          p.enabled
                            ? 'bg-slate-900/80 border-slate-800'
                            : 'bg-slate-950/50 border-slate-900 opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-6 h-6 rounded bg-slate-950 border border-slate-800 flex items-center justify-center font-mono font-bold text-xs text-cyan-400 shrink-0">
                            #{idx + 1}
                          </span>
                          <span className="text-xl shrink-0">{p.icon}</span>
                          <div>
                            <div className="font-mono font-bold text-xs text-white flex items-center gap-2">
                              <span>{p.name}</span>
                              {!p.enabled && (
                                <span className="text-[9px] font-mono text-slate-500 uppercase bg-slate-950 px-1 rounded border border-slate-800">
                                  Disabled
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {p.desc}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => movePanel(idx, -1)}
                            disabled={idx === 0}
                            className={`w-7 h-7 rounded flex items-center justify-center border font-mono text-xs ${
                              idx === 0
                                ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                                : 'border-slate-700 text-slate-300 hover:border-cyan-400 hover:text-cyan-400 bg-slate-800'
                            }`}
                            title="Move Up (▲)"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => movePanel(idx, 1)}
                            disabled={idx === missionPanels.length - 1}
                            className={`w-7 h-7 rounded flex items-center justify-center border font-mono text-xs ${
                              idx === missionPanels.length - 1
                                ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                                : 'border-slate-700 text-slate-300 hover:border-cyan-400 hover:text-cyan-400 bg-slate-800'
                            }`}
                            title="Move Down (▼)"
                          >
                            ▼
                          </button>
                          <button
                            onClick={() => togglePanelVisibility(p.id)}
                            className={`px-2.5 py-1 rounded text-xs font-mono font-bold border ml-2 ${
                              p.enabled
                                ? 'bg-cyan-950/60 border-cyan-800 text-cyan-300 hover:bg-cyan-900/60'
                                : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {p.enabled ? '👁️ VISIBLE' : '🚫 HIDDEN'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="text-[11px] font-mono text-slate-500">
                    💡 Tip: When Active Fleet Telemetry and Executive Agenda are placed next to each other, they automatically render in a 2:1 side-by-side widescreen layout.
                  </div>
                </div>
              )}

              {/* TAB 4: API KEYS & LLM CONFIG */}
              {settingsTab === 'screen' && (
                <ScreenGuardSettings
                  settings={screenGuard}
                  onChange={setScreenGuard}
                  onPreview={() => { setShowSettingsModal(false); setTimeout(() => setSaverPreview(Date.now()), 300); }}
                />
              )}

              {settingsTab === 'api' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                        CLOUD LLM & API KEYS
                      </h4>
                      <p className="text-[11px] font-mono text-slate-400">
                        Connect Google Gemini, Groq, or OpenAI to unlock unconstrained conversational intelligence and live telemetry diagnostics.
                      </p>
                    </div>
                    <span className="text-xs font-mono text-cyan-400 border border-cyan-800 bg-cyan-950/60 px-2 py-0.5 rounded">
                      ACTIVE: {aiConfig.provider?.toUpperCase() || 'GEMINI'}
                    </span>
                  </div>

                  <div className="p-3.5 bg-purple-950/25 border border-purple-800/40 rounded-lg text-xs font-mono text-purple-200 space-y-1.5">
                    <p className="font-bold text-purple-300 flex items-center gap-1.5">
                      <span>🤖</span>
                      <span>Silas Intelligence Modes:</span>
                    </p>
                    <ul className="list-disc pl-4 space-y-1 text-[11px] text-slate-300">
                      <li>
                        <strong>Google Gemini (Recommended):</strong> Free, lightning-fast generative reasoning via Gemini 2.0 Flash / 1.5 Flash. Get free keys at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-cyan-400 underline hover:text-cyan-300">aistudio.google.com</a>.
                      </li>
                      <li>
                        <strong>Groq Cloud:</strong> Free ultra-fast Llama-3.3 70B inference at <a href="https://console.groq.com" target="_blank" rel="noreferrer" className="text-cyan-400 underline hover:text-cyan-300">console.groq.com</a>.
                      </li>
                      <li>
                        <strong>Local Offline Heuristics:</strong> Leave API key blank to run strictly on local Klipper/Moonraker telemetry heuristics with zero external keys.
                      </li>
                    </ul>
                  </div>

                  <form onSubmit={handleSaveAiConfig} className="space-y-3 font-mono text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">AI PROVIDER</label>
                      <select
                        value={aiConfig.provider || 'gemini'}
                        onChange={(e) => {
                          const prov = e.target.value;
                          const provKeys = aiConfigRef.current.provider_keys || {};
                          let defaultModel = 'gemini-2.0-flash';
                          if (prov === 'groq') defaultModel = 'llama-3.3-70b-versatile';
                          else if (prov === 'openai') defaultModel = 'gpt-4o-mini';
                          else if (prov === 'custom') defaultModel = 'Gemini 3';
                          const next = {
                            ...aiConfigRef.current,
                            provider: prov,
                            model: defaultModel,
                            api_key: provKeys[prov] || '',
                            custom_url: aiConfigRef.current.custom_url || 'https://skippy.ai.studio'
                          };
                          setAiConfig(next);
                          handleSaveAiConfig(null, next);
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2.5 text-white text-xs font-mono focus:border-cyan-400 focus:outline-none"
                      >
                        <option value="gemini">Google Gemini (Gemini 2.0 Flash / 2.5 Flash - Free & Ultra-Fast)</option>
                        <option value="groq">Groq Cloud (Free, Ultra-fast Llama-3.3 70B)</option>
                        <option value="openai">OpenAI (GPT-4o Mini / GPT-4o)</option>
                        <option value="custom">Skippy AI / Custom Endpoint (https://skippy.ai.studio)</option>
                      </select>
                    </div>

                    {aiConfig.provider === 'custom' && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-slate-400">ENDPOINT / BASE URL</label>
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...aiConfigRef.current, custom_url: 'https://skippy.ai.studio' };
                              setAiConfig(next);
                              handleSaveAiConfig(null, next);
                            }}
                            className="text-[10px] text-cyan-400 hover:underline"
                          >
                            Reset: https://skippy.ai.studio
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="https://skippy.ai.studio or http://localhost:11434/v1"
                          value={aiConfig.custom_url || 'https://skippy.ai.studio'}
                          onChange={(e) => {
                            const next = { ...aiConfigRef.current, custom_url: e.target.value };
                            setAiConfig(next);
                          }}
                          onBlur={(e) => {
                            handleSaveAiConfig(null, { ...aiConfigRef.current, custom_url: e.target.value });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleSaveAiConfig(null, { ...aiConfigRef.current, custom_url: e.target.value });
                            }
                          }}
                          className="w-full bg-slate-900 border border-cyan-700/60 rounded p-2.5 text-cyan-300 font-mono text-xs focus:border-cyan-400 focus:outline-none"
                        />
                      </div>
                    )}

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-slate-400">
                          {aiConfig.provider === 'gemini'
                            ? 'GOOGLE GEMINI API KEY'
                            : aiConfig.provider === 'groq'
                            ? 'GROQ CLOUD API KEY'
                            : aiConfig.provider === 'openai'
                            ? 'OPENAI API KEY'
                            : 'SKIPPY AI / CUSTOM ENDPOINT API KEY'}
                        </label>
                        {aiConfig.provider_keys && Object.values(aiConfig.provider_keys).filter(Boolean).length > 1 && (
                          <span className="text-[10px] text-cyan-400 font-mono">
                            ✓ {Object.values(aiConfig.provider_keys).filter(Boolean).length} keys saved
                          </span>
                        )}
                      </div>
                      <input
                        type="password"
                        placeholder={
                          aiConfig.provider === 'gemini'
                            ? 'AIzaSy... (Get free key at aistudio.google.com)'
                            : aiConfig.provider === 'groq'
                            ? 'gsk_... (Get free key at console.groq.com)'
                            : aiConfig.provider === 'openai'
                            ? 'sk-... (platform.openai.com)'
                            : 'Skippy AI or Custom Endpoint API Key'
                        }
                        value={aiConfig.api_key || ''}
                        onFocus={(e) => {
                          if ((e.target.value || '').includes(KEY_MASK)) e.target.select();
                        }}
                        onChange={(e) => {
                          const val = unmaskInput(e.target.value);
                          const curProv = aiConfigRef.current.provider || 'gemini';
                          const provKeys = { ...(aiConfigRef.current.provider_keys || {}) };
                          provKeys[curProv] = val;
                          const next = {
                            ...aiConfigRef.current,
                            api_key: val,
                            provider_keys: provKeys
                          };
                          setAiConfig(next);
                        }}
                        onBlur={(e) => {
                          const val = unmaskInput(e.target.value);
                          const curProv = aiConfigRef.current.provider || 'gemini';
                          const provKeys = { ...(aiConfigRef.current.provider_keys || {}) };
                          provKeys[curProv] = val;
                          handleSaveAiConfig(null, {
                            ...aiConfigRef.current,
                            api_key: val,
                            provider_keys: provKeys
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const val = unmaskInput(e.target.value);
                            const curProv = aiConfigRef.current.provider || 'gemini';
                            const provKeys = { ...(aiConfigRef.current.provider_keys || {}) };
                            provKeys[curProv] = val;
                            handleSaveAiConfig(null, {
                              ...aiConfigRef.current,
                              api_key: val,
                              provider_keys: provKeys
                            });
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2.5 text-white font-mono text-xs focus:border-cyan-400 focus:outline-none"
                      />
                      <div className="flex items-start justify-between gap-2 mt-1">
                        <span className="text-[10px] text-slate-500 block">
                          Keys are stored on the SILAS server only and shown masked. Paste a new key to replace it.
                        </span>
                        {aiConfig.api_key && (
                          <button
                            type="button"
                            onClick={() => {
                              const curProv = aiConfigRef.current.provider || 'gemini';
                              const provKeys = { ...(aiConfigRef.current.provider_keys || {}), [curProv]: '' };
                              const next = { ...aiConfigRef.current, api_key: '', provider_keys: provKeys };
                              setAiConfigState(next);
                              aiConfigRef.current = next;
                              handleSaveAiConfig(null, { ...next, api_key: CLEAR_KEY, provider_keys: { [curProv]: CLEAR_KEY } });
                            }}
                            className="text-[10px] text-red-400 hover:underline shrink-0"
                          >
                            Remove key
                          </button>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-slate-400">MODEL IDENTIFIER</label>
                        {aiConfig.provider === 'custom' && (
                          <div className="flex gap-1.5 text-[10px] text-cyan-400">
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'Gemini 3' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline font-bold"
                            >
                              Gemini 3
                            </button>
                            <span>•</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gemini-3.5-flash' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              3.5 Flash
                            </button>
                            <span>•</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gemini-2.0-flash' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              2.0 Flash
                            </button>
                          </div>
                        )}
                        {aiConfig.provider === 'gemini' && (
                          <div className="flex gap-1.5 text-[10px] text-cyan-400">
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gemini-2.0-flash' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              2.0 Flash
                            </button>
                            <span>•</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gemini-2.5-flash' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              2.5 Flash
                            </button>
                            <span>•</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gemini-1.5-flash' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              1.5 Flash
                            </button>
                          </div>
                        )}
                        {aiConfig.provider === 'groq' && (
                          <div className="flex gap-1.5 text-[10px] text-cyan-400">
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'llama-3.3-70b-versatile' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              Llama-3.3 70B
                            </button>
                          </div>
                        )}
                        {aiConfig.provider === 'openai' && (
                          <div className="flex gap-1.5 text-[10px] text-cyan-400">
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gpt-4o-mini' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              GPT-4o Mini
                            </button>
                            <span>•</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...aiConfigRef.current, model: 'gpt-4o' };
                                setAiConfig(next);
                                handleSaveAiConfig(null, next);
                              }}
                              className="hover:underline"
                            >
                              GPT-4o
                            </button>
                          </div>
                        )}
                      </div>
                      <input
                        type="text"
                        value={aiConfig.model || (aiConfig.provider === 'gemini' ? 'gemini-2.0-flash' : aiConfig.provider === 'groq' ? 'llama-3.3-70b-versatile' : aiConfig.provider === 'custom' ? 'Gemini 3' : 'gpt-4o-mini')}
                        onChange={(e) => {
                          const next = { ...aiConfigRef.current, model: e.target.value };
                          setAiConfig(next);
                        }}
                        onBlur={() => handleSaveAiConfig(null, aiConfigRef.current)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleSaveAiConfig(null, aiConfigRef.current);
                          }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2.5 text-white font-mono text-xs focus:border-cyan-400 focus:outline-none"
                      />
                    </div>


                    <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono text-slate-400">
                          {aiConfig.api_key ? '🟢 Cloud LLM credentials active' : '⚪ Running on offline heuristics'}
                        </span>
                        {aiSavedFeedback && (
                          <span className="text-xs font-mono text-emerald-400 font-bold animate-pulse bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-700">
                            ✓ SAVED TO MEMORY!
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveAiConfig(null, aiConfigRef.current)}
                        className="hud-btn hud-btn-primary px-4 py-2 text-xs font-bold"
                      >
                        💾 SAVE AI CONFIG
                      </button>
                    </div>
                  </form>

                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="bg-slate-950 p-4 border-t border-slate-800 flex items-center justify-between">
              <span className="text-[11px] font-mono text-slate-500">
                Preferences are persisted locally in browser cache and Silas core.
              </span>
              <button
                onClick={handleCloseSettings}
                className="hud-btn hud-btn-primary px-5 py-2 text-xs font-bold font-mono"
              >
                APPLY & CLOSE
              </button>
            </div>
          </div>
        </div>
      )}


      {/* MODAL: WEBCAM FEED */}
      {webcamModal && (
        <div className="modal-overlay" onClick={() => setWebcamModal(null)}>
          <div className="modal-content p-4 max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-sm text-white">
                LIVE WEBCAM // {webcamModal.name}
              </h3>
              <button
                onClick={() => setWebcamModal(null)}
                className="text-slate-400 hover:text-white font-mono text-xs"
              >
                ✕ CLOSE
              </button>
            </div>

            <div className="relative aspect-video bg-black rounded overflow-hidden border border-slate-800 flex items-center justify-center">
              <img
                src={webcamModal.webcam_url}
                alt="Printer Webcam"
                className="w-full h-full object-contain"
                onError={(e) => {
                  e.target.style.display = 'none';
                  e.target.parentNode.innerHTML = '<div class="text-xs font-mono text-red-400 p-4 text-center">Webcam stream unreachable or offline. Check camera address.</div>';
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* MODAL: PA COLLISION RADAR / SCHEDULE WARNING POPUP */}
      {showWarningModal && actualConflicts.length > 0 && (
        <div className="modal-overlay" onClick={handleDismissWarningModal}>
          <div
            className="modal-content p-6 border-amber-500/80 shadow-[0_0_40px_rgba(245,158,11,0.35)] relative"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header with 'X' to Close */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded bg-amber-950/90 border border-amber-500 flex items-center justify-center text-lg animate-bounce">
                  ⚠️
                </div>
                <div>
                  <h3 className="font-display font-bold text-sm text-amber-400 tracking-wide">
                    PA COLLISION RADAR // SCHEDULE OVERLAP WARNING
                  </h3>
                  <p className="text-[11px] font-mono text-slate-400">
                    {actualConflicts.length} active print collision alert(s) detected
                  </p>
                </div>
              </div>

              {/* 'X' to Close Button */}
              <button
                onClick={handleDismissWarningModal}
                className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 hover:border-amber-400 text-slate-400 hover:text-amber-400 flex items-center justify-center text-base font-mono font-bold transition-all cursor-pointer"
                title="Close warning pop-up (✕)"
              >
                ✕
              </button>
            </div>

            {/* Conflicts List */}
            <div className="space-y-3 my-3 max-h-[60vh] overflow-y-auto pr-1">
              {actualConflicts.map((c, idx) => (
                <div
                  key={idx}
                  className="text-xs font-mono text-slate-200 bg-slate-900/90 p-3.5 rounded-lg border border-amber-500/40 shadow-inner"
                >
                  <div className="flex items-center justify-between font-bold text-amber-400 mb-1.5">
                    <span className="flex items-center gap-1.5">
                      <span>🚨</span>
                      <span>[{c.printer_name}] {c.kind === 'tight' ? 'TIGHT BUFFER' : c.kind === 'during' ? 'FINISHES MID-MEETING' : 'OVERRUN DETECTED'}</span>
                    </span>
                    <span className="text-[10px] text-amber-300 bg-amber-950/90 px-2 py-0.5 rounded border border-amber-800">
                      {c.kind === 'tight' ? `${c.buffer_minutes} min buffer` : c.kind === 'during' ? `done ${c.eta}` : `+${c.overrun_mins} min overlap`}
                    </span>
                  </div>

                  <p className="text-slate-200 text-xs mb-2.5 leading-relaxed">
                    {c.message}
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
                    <div>
                      Job ETA: <strong className="text-cyan-300">{c.eta}</strong>
                    </div>
                    <div>
                      Meeting: <strong className="text-purple-300">{c.event_title}</strong> ({c.event_start} - {c.event_end})
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Actions */}
            <div className="mt-5 pt-3 border-t border-slate-800 flex items-center justify-between gap-3">
              <span className="text-[11px] font-mono text-slate-500">
                You can reopen this warning anytime from Silas Executive Intel.
              </span>
              <button
                onClick={handleDismissWarningModal}
                className="hud-btn hud-btn-primary text-xs py-2 px-4 font-bold flex items-center gap-1.5"
              >
                <span>✕</span>
                <span>DISMISS / CLOSE</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3D Model Print Preview Modal */}
      {previewModalImg && (
        <div
          className="fixed inset-0 z-[100] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setPreviewModalImg(null)}
        >
          <div
            className="bg-slate-900 border border-cyan-500/50 rounded-xl max-w-lg w-full p-5 shadow-2xl shadow-cyan-950/50 relative overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-xl">🖨️</span>
                <div>
                  <h3 className="font-mono font-bold text-sm text-cyan-300 tracking-wide uppercase">
                    3D Slicer Model Preview
                  </h3>
                  <div className="text-[11px] font-mono text-slate-400">
                    Rig: <strong className="text-white">{previewModalImg.printerName}</strong>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setPreviewModalImg(null)}
                className="text-slate-400 hover:text-white text-lg font-mono p-1 rounded hover:bg-slate-800 transition-colors"
              >
                ✕
              </button>
            </div>

            {/* High-res Image Preview Frame */}
            <div className="w-full h-72 bg-slate-950 rounded-lg border border-cyan-900/60 p-3 flex items-center justify-center shadow-inner relative group">
              <img
                src={previewModalImg.url}
                alt={previewModalImg.filename}
                className="max-h-full max-w-full object-contain drop-shadow-lg"
              />
            </div>

            {/* Print & Slicer Metadata */}
            <div className="mt-4 bg-slate-950/70 p-3.5 rounded-lg border border-slate-800 space-y-2 text-xs font-mono">
              <div className="text-slate-300 font-bold truncate">
                📄 {previewModalImg.filename}
              </div>
              {previewModalImg.slicerMeta && (
                <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 pt-2 border-t border-slate-800/80">
                  {previewModalImg.slicerMeta.filament_type && (
                    <div>Material: <strong className="text-cyan-300">{previewModalImg.slicerMeta.filament_type}</strong></div>
                  )}
                  {previewModalImg.slicerMeta.filament_name && (
                    <div className="truncate" title={previewModalImg.slicerMeta.filament_name}>Spool: <strong className="text-white">{previewModalImg.slicerMeta.filament_name}</strong></div>
                  )}
                  {previewModalImg.slicerMeta.layer_height && (
                    <div>Layer Height: <strong className="text-emerald-400">{previewModalImg.slicerMeta.layer_height} mm</strong></div>
                  )}
                  {previewModalImg.slicerMeta.layer_count && (
                    <div>Total Layers: <strong className="text-amber-400">{previewModalImg.slicerMeta.layer_count}</strong></div>
                  )}
                  {previewModalImg.slicerMeta.slicer && (
                    <div>Slicer: <strong className="text-purple-300">{previewModalImg.slicerMeta.slicer}</strong></div>
                  )}
                  {previewModalImg.slicerMeta.estimated_time && (
                    <div>Est. Time: <strong className="text-slate-200">{Math.round(previewModalImg.slicerMeta.estimated_time / 60)} mins</strong></div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setPreviewModalImg(null)}
                className="hud-btn hud-btn-primary text-xs py-1.5 px-4 font-bold"
              >
                CLOSE PREVIEW
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Burn-in protection: hue drift, pixel shift, deep dim, screensaver */}
      <ScreenGuard
        settings={screenGuard}
        fleet={fleet}
        alerts={alerts}
        briefing={briefing}
        paused={!!webcamModal}
        previewToken={saverPreview}
      />
    </div>
  );
}
