// Spectrum + waterfall, AF oscilloscope and the passband graphic.
// All three read from the same AnalyserNode. `model()` supplies the radio
// context (dial frequency, mode, filter settings) on every frame.

import { widthTable } from '../cat/ftx1.js';

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- sideband geometry ----------
// How an audio frequency in the receiver output maps to RF, per mode.
export function sidebandOf(mode) {
  if (/^(LSB|CW-L|RTTY-L|DATA-L)$/.test(mode)) return -1;
  if (/^(USB|CW-U|RTTY-U|DATA-U|PSK)$/.test(mode)) return 1;
  return 0; // AM / FM: audio is not a frequency offset
}
export function audioOffset(mode, pitch) {
  if (/^CW/.test(mode)) return pitch;
  if (/^RTTY/.test(mode)) return 2125; // mark tone default; verify on the radio
  return 0;
}
export function rfAtAudio(m, f) {
  const sb = sidebandOf(m.mode);
  return sb ? m.dial + sb * (f - audioOffset(m.mode, m.pitch)) : null;
}
// Where a click should put the dial so the clicked signal lands in the passband.
export function clickTuneTarget(m, f) {
  const sb = sidebandOf(m.mode);
  if (!sb) return null;
  // CW/RTTY: the dial shows the RF of a signal heard at the pitch/mark tone,
  //   so the clicked signal becomes the new dial frequency.
  // DATA/PSK: move the clicked signal to 1500 Hz audio.
  // SSB: put the suppressed carrier where you clicked (click a signal's low edge).
  let want = 0;
  if (/^(CW|RTTY)/.test(m.mode)) want = audioOffset(m.mode, m.pitch);
  else if (/^(DATA|PSK)/.test(m.mode)) want = 1500;
  return m.dial + sb * (f - want);
}
// Approximate audio passband edges (Hz) for drawing.
export function passbandEdges(m) {
  const table = widthTable(m.mode);
  let bw = table ? (table[m.width] || (/^(LSB|USB)$/.test(m.mode) ? 2400 : 500)) : (/^AM/.test(m.mode) ? 6000 : 3000);
  let center;
  if (/^CW/.test(m.mode)) center = m.pitch;
  else if (/^(LSB|USB)$/.test(m.mode)) center = 300 + bw / 2;
  else if (/^(DATA|PSK)/.test(m.mode)) center = 1500;
  else if (/^RTTY/.test(m.mode)) center = 2210;
  else { return { lo: 100, hi: Math.min(bw / 2, 6000), bw }; }
  center += m.shift || 0;
  return { lo: Math.max(0, center - bw / 2), hi: center + bw / 2, bw };
}

// ---------- palette ----------
function buildPalette() {
  const stops = [[0, [4, 6, 12]], [0.2, [10, 22, 70]], [0.4, [18, 90, 170]], [0.58, [40, 200, 220]],
    [0.72, [245, 220, 70]], [0.86, [245, 120, 40]], [1, [255, 245, 235]]];
  const pal = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 1; while (j < stops.length - 1 && t > stops[j][0]) j++;
    const [t0, c0] = stops[j - 1], [t1, c1] = stops[j];
    const u = (t - t0) / (t1 - t0);
    for (let k = 0; k < 3; k++) pal[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * u;
  }
  return pal;
}
const PALETTE = buildPalette();

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}

// ---------- spectrum + waterfall ----------
export class SpectrumWaterfall {
  constructor(specCanvas, wfCanvas, model, { onTune } = {}) {
    this.spec = specCanvas; this.wf = wfCanvas; this.model = model; this.onTune = onTune;
    this.span = 4000; this.floor = -112; this.range = 62; this.speed = 2;
    this.hoverX = null;
    this.bins = null;
    this.avg = null;
    this.wfBuf = null;
    this._frame = 0;
    for (const cv of [this.spec, this.wf]) {
      cv.addEventListener('mousemove', e => { this.hoverX = e.offsetX / cv.clientWidth; });
      cv.addEventListener('mouseleave', () => { this.hoverX = null; });
      cv.addEventListener('click', e => this._click(e.offsetX / cv.clientWidth));
    }
  }

  // x (0..1 across the display) -> audio Hz. LSB-type modes are drawn
  // reversed so RF frequency always increases left to right.
  _audioAtX(x, m) { return (sidebandOf(m.mode) < 0 ? 1 - x : x) * this.span; }
  _xAtAudio(f, m) { const x = f / this.span; return sidebandOf(m.mode) < 0 ? 1 - x : x; }

  _click(x) {
    const m = this.model();
    const f = this._audioAtX(x, m);
    const target = clickTuneTarget(m, f);
    if (target != null && this.onTune) this.onTune(Math.round(target / 10) * 10);
  }

  draw() {
    const m = this.model();
    const an = m.analyser;
    const resized = fitCanvas(this.spec) | fitCanvas(this.wf);
    if (resized || !this.wfBuf || this.wfBuf.width !== this.wf.width || this.wfBuf.height !== this.wf.height) {
      const old = this.wfBuf;
      this.wfBuf = document.createElement('canvas');
      this.wfBuf.width = this.wf.width; this.wfBuf.height = this.wf.height;
      // keep the history when the window is resized (stretch horizontally, keep row height)
      if (old) this.wfBuf.getContext('2d').drawImage(old, 0, 0, old.width, old.height, 0, 0, this.wfBuf.width, old.height);
    }
    const W = this.spec.width, H = this.spec.height, d = devicePixelRatio || 1;
    const c = this.spec.getContext('2d');
    c.fillStyle = '#05080b'; c.fillRect(0, 0, W, H);

    let levels = null;
    if (an) {
      if (!this.bins || this.bins.length !== an.frequencyBinCount) this.bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.bins);
      const binHz = m.sampleRate / an.fftSize;
      levels = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const f0 = this._audioAtX(x / W, m), f1 = this._audioAtX((x + 1) / W, m);
        let b0 = Math.floor(Math.min(f0, f1) / binHz), b1 = Math.ceil(Math.max(f0, f1) / binHz);
        b1 = Math.max(b0 + 1, b1);
        let mx = -200;
        for (let b = b0; b < b1 && b < this.bins.length; b++) mx = Math.max(mx, this.bins[b]);
        levels[x] = mx;
      }
      if (!this.avg || this.avg.length !== W) this.avg = Float32Array.from(levels);
      for (let x = 0; x < W; x++) this.avg[x] += (levels[x] - this.avg[x]) * 0.35;
    }

    // passband shading
    const pb = passbandEdges(m);
    const xa = this._xAtAudio(pb.lo, m) * W, xb = this._xAtAudio(pb.hi, m) * W;
    c.fillStyle = 'rgba(245,184,61,0.08)';
    c.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), H);

    // grid + RF labels
    c.font = `${10 * d}px ${css('--mono')}`; c.textBaseline = 'top';
    const step = this.span <= 4000 ? 500 : this.span <= 6000 ? 1000 : 2000;
    for (let f = 0; f <= this.span; f += step) {
      const x = this._xAtAudio(f, m) * W;
      c.strokeStyle = '#1b2530'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke();
      const rf = rfAtAudio(m, f);
      const label = rf != null ? (rf / 1e6).toFixed(rf >= 1e8 ? 4 : 4).replace(/0+$/, '').replace(/\.$/, '') : `${f}`;
      c.fillStyle = '#56657a';
      c.textAlign = x < 30 * d ? 'left' : x > W - 30 * d ? 'right' : 'center';
      c.fillText(label, x + (c.textAlign === 'left' ? 3 * d : c.textAlign === 'right' ? -3 * d : 0), 3 * d);
    }
    for (let db = Math.ceil(this.floor / 10) * 10; db < this.floor + this.range; db += 10) {
      const y = H - (db - this.floor) / this.range * H;
      c.strokeStyle = '#121a22'; c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke();
    }

    // trace
    if (this.avg) {
      const yOf = v => H - Math.max(0, Math.min(1, (v - this.floor) / this.range)) * (H - 14 * d);
      c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x < W; x++) c.lineTo(x, yOf(this.avg[x]));
      c.lineTo(W, H); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(76,201,240,0.35)'); g.addColorStop(1, 'rgba(76,201,240,0.02)');
      c.fillStyle = g; c.fill();
      c.beginPath();
      for (let x = 0; x < W; x++) (x ? c.lineTo : c.moveTo).call(c, x, yOf(this.avg[x]));
      c.strokeStyle = '#8be3ff'; c.lineWidth = 1.2 * d; c.stroke();
    }

    // markers: notch, contour, tuned spot
    const marker = (f, color, dash) => {
      const x = this._xAtAudio(f, m) * W;
      c.strokeStyle = color; c.lineWidth = 1.5 * d; c.setLineDash(dash || []);
      c.beginPath(); c.moveTo(x, 14 * d); c.lineTo(x, H); c.stroke(); c.setLineDash([]);
    };
    if (m.notch) marker(m.notchHz, '#ef4444', [4 * d, 3 * d]);
    if (m.contour) marker(m.contourHz, '#a78bfa', [2 * d, 3 * d]);
    if (/^CW/.test(m.mode)) marker(m.pitch, 'rgba(245,184,61,.9)');

    // hover readout
    if (this.hoverX != null) {
      const x = this.hoverX * W;
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke();
      const f = this._audioAtX(this.hoverX, m);
      const target = clickTuneTarget(m, f);
      const txt = target != null ? `${(target / 1e3).toFixed(2)} kHz` : `${Math.round(f)} Hz`;
      c.font = `600 ${11 * d}px ${css('--mono')}`;
      const tw = c.measureText(txt).width + 10 * d;
      const bx = Math.min(W - tw - 2, Math.max(2, x + 6 * d));
      c.fillStyle = 'rgba(10,14,19,.85)'; c.fillRect(bx, H - 20 * d, tw, 17 * d);
      c.fillStyle = '#f5b83d'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(txt, bx + 5 * d, H - 11.5 * d);
    }

    // waterfall rows
    if (levels) {
      this._frame++;
      const rows = this.speed >= 4 ? 2 : (this.speed === 2 || this._frame % 2 === 0) ? 1 : 0;
      if (rows) {
        const bc = this.wfBuf.getContext('2d');
        const WW = this.wfBuf.width, WH = this.wfBuf.height;
        bc.drawImage(this.wfBuf, 0, 0, WW, WH - rows, 0, rows, WW, WH - rows);
        const img = bc.createImageData(WW, rows);
        for (let x = 0; x < WW; x++) {
          const v = Math.max(0, Math.min(1, (levels[Math.min(levels.length - 1, x)] - this.floor) / this.range));
          const p = Math.round(v * 255) * 3;
          for (let r = 0; r < rows; r++) {
            const o = (r * WW + x) * 4;
            img.data[o] = PALETTE[p]; img.data[o + 1] = PALETTE[p + 1]; img.data[o + 2] = PALETTE[p + 2]; img.data[o + 3] = 255;
          }
        }
        bc.putImageData(img, 0, 0);
      }
    }
    const wc = this.wf.getContext('2d');
    wc.drawImage(this.wfBuf, 0, 0);
    if (this.hoverX != null) {
      const x = this.hoverX * this.wf.width;
      wc.strokeStyle = 'rgba(255,255,255,.35)'; wc.beginPath(); wc.moveTo(x + 0.5, 0); wc.lineTo(x + 0.5, this.wf.height); wc.stroke();
    }
  }

  clear() {
    if (this.wfBuf) this.wfBuf.getContext('2d').clearRect(0, 0, this.wfBuf.width, this.wfBuf.height);
    this.avg = null;
  }
}

// ---------- AF oscilloscope ----------
export class Oscilloscope {
  constructor(canvas, model) { this.cv = canvas; this.model = model; this.buf = null; }
  draw() {
    fitCanvas(this.cv);
    const c = this.cv.getContext('2d'), W = this.cv.width, H = this.cv.height;
    c.fillStyle = '#05080b'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#1b2530'; c.beginPath(); c.moveTo(0, H / 2 + 0.5); c.lineTo(W, H / 2 + 0.5); c.stroke();
    const an = this.model().analyser; if (!an) return;
    if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.buf);
    // trigger on a rising zero crossing for a steadier trace
    let start = 0;
    for (let i = 1; i < this.buf.length / 2; i++) if (this.buf[i - 1] < 0 && this.buf[i] >= 0) { start = i; break; }
    const n = Math.min(1200, this.buf.length - start);
    let peak = 0.02; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(this.buf[start + i]));
    c.strokeStyle = '#4ade80'; c.lineWidth = 1.2 * (devicePixelRatio || 1);
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i / n * W, y = H / 2 - this.buf[start + i] / peak * H * 0.42;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
}

// ---------- passband graphic ----------
export class PassbandView {
  constructor(canvas, model, { onShift, onWidthStep } = {}) {
    this.cv = canvas; this.model = model; this.onShift = onShift; this.onWidthStep = onWidthStep;
    this.span = 4000; this.bins = null; this.avg = null;
    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, shift: this.model().shift || 0 };
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / canvas.clientWidth * this.span;
      const sb = sidebandOf(this.model().mode) || 1;
      this.onShift?.(Math.max(-1200, Math.min(1200, Math.round((drag.shift + sb * dx) / 20) * 20)));
    });
    const end = () => { drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.onWidthStep?.(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  }

  draw() {
    fitCanvas(this.cv);
    const m = this.model();
    const c = this.cv.getContext('2d'), W = this.cv.width, H = this.cv.height, d = devicePixelRatio || 1;
    c.fillStyle = '#05080b'; c.fillRect(0, 0, W, H);
    const xOf = f => f / this.span * W;
    const base = H - 16 * d, top = 14 * d;

    // live audio spectrum, faint
    const an = m.analyser;
    if (an) {
      if (!this.bins || this.bins.length !== an.frequencyBinCount) this.bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.bins);
      const binHz = m.sampleRate / an.fftSize;
      if (!this.avg || this.avg.length !== W) this.avg = new Float32Array(W).fill(-140);
      c.beginPath(); c.moveTo(0, base);
      for (let x = 0; x < W; x++) {
        const b = Math.min(this.bins.length - 1, Math.round(x / W * this.span / binHz));
        this.avg[x] += (this.bins[b] - this.avg[x]) * 0.3;
        const v = Math.max(0, Math.min(1, (this.avg[x] + 115) / 65));
        c.lineTo(x, base - v * (base - top));
      }
      c.lineTo(W, base); c.closePath();
      c.fillStyle = 'rgba(76,201,240,0.16)'; c.fill();
    }

    // passband trapezoid
    const pb = passbandEdges(m);
    const lo = xOf(pb.lo), hi = xOf(pb.hi), skirt = 10 * d;
    c.beginPath();
    c.moveTo(lo - skirt, base); c.lineTo(lo + skirt * 0.4, top); c.lineTo(hi - skirt * 0.4, top); c.lineTo(hi + skirt, base);
    c.closePath();
    c.fillStyle = 'rgba(245,184,61,0.14)'; c.fill();
    c.strokeStyle = '#f5b83d'; c.lineWidth = 1.6 * d; c.stroke();

    // contour: a dip drawn on the passband top
    if (m.contour) {
      const x = xOf(m.contourHz);
      c.strokeStyle = '#a78bfa'; c.lineWidth = 2 * d; c.beginPath();
      c.moveTo(x - 22 * d, top); c.quadraticCurveTo(x, top + 26 * d, x + 22 * d, top); c.stroke();
    }
    // notch: a V cut
    if (m.notch) {
      const x = xOf(m.notchHz);
      c.strokeStyle = '#ef4444'; c.lineWidth = 2 * d; c.beginPath();
      c.moveTo(x - 7 * d, top); c.lineTo(x, base); c.lineTo(x + 7 * d, top); c.stroke();
    }
    // shift arrow
    if (m.shift) {
      const cx = (lo + hi) / 2;
      c.fillStyle = '#f5b83d'; c.font = `600 ${10.5 * d}px ${css('--mono')}`; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(`${m.shift > 0 ? '+' : ''}${m.shift} Hz`, cx, 1 * d);
    }
    // axis
    c.fillStyle = '#56657a'; c.font = `${10 * d}px ${css('--mono')}`; c.textBaseline = 'bottom';
    for (let f = 0; f <= this.span; f += 1000) {
      c.textAlign = f === 0 ? 'left' : f === this.span ? 'right' : 'center';
      c.fillText(f ? `${f / 1000}k` : '0', xOf(f) + (f === 0 ? 3 * d : f === this.span ? -3 * d : 0), H - 2 * d);
    }
    if (m.dnf) { c.fillStyle = '#4ade80'; c.textAlign = 'right'; c.textBaseline = 'top'; c.fillText('DNF', W - 4 * d, 2 * d); }
    if (m.nr) { c.fillStyle = '#4cc9f0'; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(`DNR ${m.nr}`, 4 * d, 2 * d); }
  }
}
