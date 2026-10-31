// Test-chamber voice effect. Takes plain speech and re-synthesises it as a pitch-corrected,
// slightly metallic lab AI (GLaDOS-style). Pure functions on Float32Array samples so it
// runs the same in the browser and in Node (for tests).
//
// How it works:
//   1. LPC analysis: each 30 ms frame of speech is split into "what the mouth is doing"
//      (an all-pole filter) and "what the voice box is doing" (pitch + loudness).
//   2. The pitch is tracked, snapped hard to the nearest semitone, held in steps and lifted
//      a little, which gives the robotic, auto-tuned sing-song.
//   3. The mouth filter is driven by a clean pulse train at that new pitch (noise for
//      "s", "f", "t" sounds), so the words survive but the voice becomes synthetic.
//   4. A touch of the original for clarity, a slow flanger for the metallic edge,
//      a gentle high-pass, then normalise.

const PRE = 0.95; // pre-emphasis

function levinson(r, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  if (err <= 1e-12) return { a, err: 0 };
  const tmp = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 1e-12) break;
  }
  return { a, err };
}

function detectPitch(frame, sr) {
  // Normalised autocorrelation, 90-420 Hz.
  const minLag = Math.floor(sr / 420), maxLag = Math.floor(sr / 90);
  let e0 = 0;
  for (let i = 0; i < frame.length; i++) e0 += frame[i] * frame[i];
  if (e0 < 1e-6) return { f0: 0, clarity: 0 };
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag && lag < frame.length - 1; lag++) {
    let acc = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      acc += frame[i] * frame[i + lag];
      e1 += frame[i] * frame[i];
      e2 += frame[i + lag] * frame[i + lag];
    }
    const c = acc / Math.sqrt(e1 * e2 + 1e-12);
    if (c > best) { best = c; bestLag = lag; }
  }
  return { f0: bestLag ? sr / bestLag : 0, clarity: best };
}

const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
const freqOf = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function testChamberFx(input, sr, opts = {}) {
  const {
    lift = 3,          // semitones up
    swing = 1.7,       // how much wider the melody is than the original
    order = Math.round(sr / 1000) + 4,
    dry = 0.18,        // amount of original voice mixed back in
    flanger = 0.35,
    seed = 7,
  } = opts;
  const n = input.length;
  const win = Math.round(sr * 0.03), hop = Math.round(sr * 0.01);
  const frames = Math.max(1, Math.ceil(n / hop));

  // Pre-emphasised copy for LPC
  const pe = new Float32Array(n);
  for (let i = 0; i < n; i++) pe[i] = input[i] - (i ? PRE * input[i - 1] : 0);

  const ham = new Float32Array(win);
  for (let i = 0; i < win; i++) ham[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (win - 1));

  // --- analysis pass
  const coefs = [], voiced = [], f0s = [], rms = [], gains = [];
  let peakRms = 0;
  const buf = new Float32Array(win), raw = new Float32Array(win);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - Math.floor((win - hop) / 2);
    let e = 0;
    for (let i = 0; i < win; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < n ? pe[idx] : 0;
      raw[i] = idx >= 0 && idx < n ? input[idx] : 0;
      buf[i] = v * ham[i];
      e += raw[i] * raw[i];
    }
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) {
      let acc = 0;
      for (let i = 0; i + k < win; i++) acc += buf[i] * buf[i + k];
      r[k] = acc;
    }
    r[0] *= 1.0001; // tiny white-noise floor keeps the filter stable
    const { a, err } = levinson(r, order);
    gains.push(Math.sqrt(Math.max(err, 0) / win) * 1.6); // excitation level that reproduces this frame
    for (let k = 1; k <= order; k++) a[k] *= Math.pow(0.985, k); // bandwidth expansion: keeps the filter stable
    coefs.push(a);
    const fr = Math.sqrt(e / win);
    rms.push(fr);
    peakRms = Math.max(peakRms, fr);
    const { f0, clarity } = detectPitch(raw, sr);
    f0s.push(f0);
    voiced.push(clarity);
  }
  const silence = peakRms * 0.04;

  // --- pitch: exaggerate the melody, snap to semitones, hold steps, lift
  const voicedMidi = [];
  for (let f = 0; f < frames; f++) {
    if (voiced[f] > 0.45 && rms[f] > silence && f0s[f] > 0) voicedMidi.push(midiOf(f0s[f]));
  }
  voicedMidi.sort((x, y) => x - y);
  const centre = voicedMidi.length ? voicedMidi[Math.floor(voicedMidi.length / 2)] : 60;
  const target = new Float32Array(frames);
  let held = 0, pending = 0, pendingCount = 0;
  for (let f = 0; f < frames; f++) {
    const isVoiced = voiced[f] > 0.45 && rms[f] > silence && f0s[f] > 0;
    if (!isVoiced) { target[f] = 0; continue; }
    let raw = midiOf(f0s[f]);
    if (Math.abs(raw - centre) > 9) raw += raw < centre ? 12 : -12; // octave glitch from the tracker
    const m = Math.round(centre + swing * (raw - centre)) + lift;
    if (!held) held = m;
    else if (m !== held) {
      if (m === pending) pendingCount++; else { pending = m; pendingCount = 1; }
      if (pendingCount >= 4) { held = m; pendingCount = 0; } // must persist 40 ms to step
    }
    target[f] = freqOf(held);
  }

  // --- synthesis pass: excitation through each frame's mouth filter
  let rnd = seed >>> 0;
  const noise = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 2147483648 - 1; };
  const out = new Float32Array(n);
  const mem = new Float64Array(order + 1);
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const a = coefs[f];
    const f0 = target[f];
    const s0 = f * hop, s1 = Math.min(n, s0 + hop);
    for (let s = s0; s < s1; s++) {
      let ex;
      if (f0 > 0) {
        phase += f0 / sr;
        if (phase >= 1) { phase -= 1; ex = Math.sqrt(sr / f0); } else ex = 0;
        ex += 0.08 * noise();
      } else {
        ex = rms[f] > silence ? noise() * 0.6 : 0;
      }
      let y = ex * gains[f];
      for (let k = 1; k <= order; k++) y -= a[k] * mem[k];
      for (let k = order; k > 1; k--) mem[k] = mem[k - 1];
      mem[1] = y;
      out[s] = Number.isFinite(y) ? y : 0;
    }
    if (!Number.isFinite(mem[1])) mem.fill(0);
  }

  // de-emphasis
  for (let i = 1; i < n; i++) out[i] += PRE * out[i - 1];

  // match loudness to the original, frame by frame (smoothed)
  let g = 0;
  for (let f = 0; f < frames; f++) {
    const s0 = f * hop, s1 = Math.min(n, s0 + hop);
    let e = 0;
    for (let s = s0; s < s1; s++) e += out[s] * out[s];
    const synRms = Math.sqrt(e / Math.max(1, s1 - s0));
    const want = synRms > 1e-7 ? Math.min(rms[f] / synRms, 8) : 0;
    g = g ? 0.7 * g + 0.3 * want : want;
    for (let s = s0; s < s1; s++) out[s] *= g;
  }

  // mix, flanger, high-pass, normalise
  const res = new Float32Array(n);
  const base = sr * 0.003, depth = sr * 0.0015;
  let hpPrevX = 0, hpPrevY = 0;
  const hpA = Math.exp((-2 * Math.PI * 140) / sr);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const wet = out[i] * (1 - dry) + input[i] * dry;
    const d = base + depth * Math.sin((2 * Math.PI * 0.35 * i) / sr);
    const j = i - d, j0 = Math.floor(j), fr = j - j0;
    const delayed = j0 >= 0 && j0 + 1 < n
      ? (out[j0] * (1 - fr) + out[j0 + 1] * fr) * (1 - dry) + (input[j0] * (1 - fr) + input[j0 + 1] * fr) * dry
      : 0;
    const x = wet + flanger * delayed;
    const y = hpA * (hpPrevY + x - hpPrevX);
    hpPrevX = x; hpPrevY = y;
    res[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) res[i] *= norm;
  return res;
}
