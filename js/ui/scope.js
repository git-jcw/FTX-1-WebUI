// Spectrum + waterfall, AF oscilloscope and the passband graphic.
// All three read from the same AnalyserNode. `model()` supplies the radio
// context (dial frequency, mode, filter settings) on every frame.

import { widthTable } from '../cat/ftx1.js';
import { colors, alpha } from './theme.js';

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
// SSB receive passband measured on an FTX-1 (audio Hz above the dial, i.e.
// where the band noise starts and stops) for a few filter widths, shift 0.
const SSB_PASSBAND = [[1800, 500, 2500], [2400, 300, 2700], [2700, 100, 3000], [3000, 50, 3100]];
export function ssbPassband(bw) {
  const pts = SSB_PASSBAND, first = pts[0], last = pts[pts.length - 1];
  if (bw <= first[0]) { const half = (first[2] - first[1]) / 2 * bw / first[0]; return { lo: 1500 - half, hi: 1500 + half }; }
  if (bw >= last[0]) return { lo: last[1], hi: last[2] + (bw - last[0]) };
  const i = pts.findIndex(p => p[0] >= bw), [w0, lo0, hi0] = pts[i - 1], [w1, lo1, hi1] = pts[i];
  const u = (bw - w0) / (w1 - w0);
  return { lo: lo0 + (lo1 - lo0) * u, hi: hi0 + (hi1 - hi0) * u };
}

// Audio passband edges (Hz) for drawing.
export function passbandEdges(m) {
  const table = widthTable(m.mode);
  const bw = table ? (table[m.width] || (/^(LSB|USB)$/.test(m.mode) ? 2400 : 500)) : (/^AM/.test(m.mode) ? 6000 : 3000);
  const shift = m.shift || 0;
  if (/^(LSB|USB)$/.test(m.mode)) {
    const { lo, hi } = ssbPassband(bw);
    return { lo: Math.max(0, lo + shift), hi: hi + shift, bw };
  }
  let center;
  if (/^CW/.test(m.mode)) center = m.pitch;
  else if (/^(DATA|PSK)/.test(m.mode)) center = 1500;
  else if (/^RTTY/.test(m.mode)) center = 2210;
  else { return { lo: 100, hi: Math.min(bw / 2, 6000), bw }; }
  center += shift;
  return { lo: Math.max(0, center - bw / 2), hi: center + bw / 2, bw };
}

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
    this.span = 8000; this.floor = -112; this.range = 62; this.speed = 2;
    this.hoverX = null;
    this.bins = null;
    this.avg = null;
    this.wfBuf = null;
    this._frame = 0;
    this._dial = null;
    this._shiftRem = 0;
    for (const cv of [this.spec, this.wf]) {
      cv.addEventListener('mousemove', e => { this.hoverX = e.offsetX / cv.clientWidth; });
      cv.addEventListener('mouseleave', () => { this.hoverX = null; });
      cv.addEventListener('click', e => this._click(e.offsetX / cv.clientWidth));
    }
  }

  // The display is centred on the dial frequency and `span` Hz of RF wide,
  // with RF increasing left to right. x is 0..1 across the display.
  _offsetAtX(x) { return (x - 0.5) * this.span; }
  // The audio frequency a signal at x is heard at. Negative means the far
  // side of the carrier, which this sideband doesn't receive. AM/FM audio is
  // both sidebands folded together, so it's drawn mirrored about the dial.
  _audioAtX(x, m) {
    const sb = sidebandOf(m.mode), off = this._offsetAtX(x);
    return sb ? audioOffset(m.mode, m.pitch) + sb * off : Math.abs(off);
  }
  _xAtAudio(f, m) {
    const sb = sidebandOf(m.mode);
    return 0.5 + (sb ? sb * (f - audioOffset(m.mode, m.pitch)) : f) / this.span;
  }
  // Where a click at x puts the dial; AM/FM just tune to the clicked frequency.
  _tuneTargetAtX(x, m) {
    return clickTuneTarget(m, this._audioAtX(x, m)) ?? m.dial + this._offsetAtX(x);
  }

  _click(x) {
    if (this.onTune) this.onTune(Math.round(this._tuneTargetAtX(x, this.model()) / 10) * 10);
  }

  // Slide the waterfall history sideways by dx pixels so signals stay at
  // their RF position when the dial moves.
  _shift(dx) {
    dx += this._shiftRem;
    const px = Math.round(dx);
    this._shiftRem = dx - px;
    if (!px) return;
    const WW = this.wfBuf.width, WH = this.wfBuf.height;
    if (Math.abs(px) >= WW) { this.clear(); return; }
    const bc = this.wfBuf.getContext('2d');
    bc.drawImage(this.wfBuf, px, 0);
    bc.fillStyle = colors().bg;
    bc.fillRect(px > 0 ? 0 : WW + px, 0, Math.abs(px), WH);
    this.avg = null;
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
    const c = this.spec.getContext('2d'), k = colors();
    c.fillStyle = k.bg; c.fillRect(0, 0, W, H);

    if (this._dial != null && m.dial !== this._dial) this._shift((this._dial - m.dial) / this.span * this.wfBuf.width);
    this._dial = m.dial;

    let levels = null;
    if (an) {
      if (!this.bins || this.bins.length !== an.frequencyBinCount) this.bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.bins);
      const binHz = m.sampleRate / an.fftSize;
      levels = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const f0 = this._audioAtX(x / W, m), f1 = this._audioAtX((x + 1) / W, m);
        const lo = Math.min(f0, f1), hi = Math.max(f0, f1);
        let mx = -200;
        if (hi > 0) {
          const b0 = Math.floor(Math.max(0, lo) / binHz), b1 = Math.max(b0 + 1, Math.ceil(hi / binHz));
          for (let b = b0; b < b1 && b < this.bins.length; b++) mx = Math.max(mx, this.bins[b]);
        }
        levels[x] = mx;
      }
      if (!this.avg || this.avg.length !== W) this.avg = Float32Array.from(levels);
      for (let x = 0; x < W; x++) this.avg[x] += (levels[x] - this.avg[x]) * 0.35;
    }

    // passband shading (both sides of the dial for AM/FM)
    const pb = passbandEdges(m);
    const xa = this._xAtAudio(sidebandOf(m.mode) ? pb.lo : -pb.hi, m) * W, xb = this._xAtAudio(pb.hi, m) * W;
    c.fillStyle = alpha(k.accent, 0.08);
    c.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), H);

    // grid + RF labels (kHz), stepped out from the dial frequency
    c.font = `${10 * d}px ${k.mono}`; c.textBaseline = 'top';
    const step = this.span <= 8000 ? 1000 : this.span <= 12000 ? 2000 : 4000;
    for (let off = -Math.floor(this.span / 2 / step) * step; off <= this.span / 2; off += step) {
      const x = (0.5 + off / this.span) * W;
      c.strokeStyle = k.grid; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke();
      const label = ((m.dial + off) / 1e3).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      c.fillStyle = off ? k.label : k.accent;
      c.textAlign = x < 30 * d ? 'left' : x > W - 30 * d ? 'right' : 'center';
      c.fillText(label, x + (c.textAlign === 'left' ? 3 * d : c.textAlign === 'right' ? -3 * d : 0), 3 * d);
    }
    for (let db = Math.ceil(this.floor / 10) * 10; db < this.floor + this.range; db += 10) {
      const y = H - (db - this.floor) / this.range * H;
      c.strokeStyle = k.gridMinor; c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke();
    }

    // trace
    if (this.avg) {
      const yOf = v => H - Math.max(0, Math.min(1, (v - this.floor) / this.range)) * (H - 14 * d);
      c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x < W; x++) c.lineTo(x, yOf(this.avg[x]));
      c.lineTo(W, H); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, alpha(k.traceFill, 0.35)); g.addColorStop(1, alpha(k.traceFill, 0.02));
      c.fillStyle = g; c.fill();
      c.beginPath();
      for (let x = 0; x < W; x++) (x ? c.lineTo : c.moveTo).call(c, x, yOf(this.avg[x]));
      c.strokeStyle = k.trace; c.lineWidth = 1.2 * d; c.stroke();
    }

    // markers: notch, contour, and the dial frequency at the centre
    const marker = (x, color, dash) => {
      c.strokeStyle = color; c.lineWidth = 1.5 * d; c.setLineDash(dash || []);
      c.beginPath(); c.moveTo(x, 14 * d); c.lineTo(x, H); c.stroke(); c.setLineDash([]);
    };
    if (m.notch) marker(this._xAtAudio(m.notchHz, m) * W, k.notch, [4 * d, 3 * d]);
    if (m.contour) marker(this._xAtAudio(m.contourHz, m) * W, k.contour, [2 * d, 3 * d]);
    marker(W / 2, alpha(k.accent, 0.9));

    // hover readout
    if (this.hoverX != null) {
      const x = this.hoverX * W;
      c.strokeStyle = alpha(k.text, 0.35); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke();
      const txt = `${(this._tuneTargetAtX(this.hoverX, m) / 1e3).toFixed(2)} kHz`;
      c.font = `600 ${11 * d}px ${k.mono}`;
      const tw = c.measureText(txt).width + 10 * d;
      const bx = Math.min(W - tw - 2, Math.max(2, x + 6 * d));
      c.fillStyle = alpha(k.bg, 0.85); c.fillRect(bx, H - 20 * d, tw, 17 * d);
      c.fillStyle = k.accent; c.textAlign = 'left'; c.textBaseline = 'middle';
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
        const PALETTE = k.palette;
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
      wc.strokeStyle = alpha(k.text, 0.35); wc.beginPath(); wc.moveTo(x + 0.5, 0); wc.lineTo(x + 0.5, this.wf.height); wc.stroke();
    }
  }

  clear() {
    if (this.wfBuf) {
      const bc = this.wfBuf.getContext('2d');
      bc.fillStyle = colors().bg; bc.fillRect(0, 0, this.wfBuf.width, this.wfBuf.height);
    }
    this.avg = null;
  }
}

// ---------- AF oscilloscope ----------
export class Oscilloscope {
  constructor(canvas, model) { this.cv = canvas; this.model = model; this.buf = null; }
  draw() {
    fitCanvas(this.cv);
    const c = this.cv.getContext('2d'), W = this.cv.width, H = this.cv.height, k = colors();
    c.fillStyle = k.bg; c.fillRect(0, 0, W, H);
    c.strokeStyle = k.grid; c.beginPath(); c.moveTo(0, H / 2 + 0.5); c.lineTo(W, H / 2 + 0.5); c.stroke();
    const an = this.model().analyser; if (!an) return;
    if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.buf);
    // trigger on a rising zero crossing for a steadier trace
    let start = 0;
    for (let i = 1; i < this.buf.length / 2; i++) if (this.buf[i - 1] < 0 && this.buf[i] >= 0) { start = i; break; }
    const n = Math.min(1200, this.buf.length - start);
    let peak = 0.02; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(this.buf[start + i]));
    c.strokeStyle = k.osc; c.lineWidth = 1.2 * (devicePixelRatio || 1);
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i / n * W, y = H / 2 - this.buf[start + i] / peak * H * 0.42;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
  }
}

// The analyser reports -Infinity for a bin with no energy at all, as happens
// whenever the radio's USB audio goes fully silent (transmitting, changing
// band). Averaging that in turns the average into NaN for good, so clamp it.
const SILENT_DB = -200;
export const audibleDb = v => (v > SILENT_DB ? v : SILENT_DB); // also maps NaN to SILENT_DB

// ---------- passband graphic ----------
export class PassbandView {
  constructor(canvas, model, { onShift, onWidthStep } = {}) {
    this.cv = canvas; this.model = model; this.onShift = onShift; this.onWidthStep = onWidthStep;
    this.span = 4000; this.floor = -112; this.range = 62; this.bins = null; this.avg = null;
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
    const c = this.cv.getContext('2d'), W = this.cv.width, H = this.cv.height, d = devicePixelRatio || 1, k = colors();
    c.fillStyle = k.bg; c.fillRect(0, 0, W, H);
    const xOf = f => f / this.span * W;
    const base = H - 16 * d, top = 14 * d;

    // live audio spectrum, faint, on the same Floor / Range scale as the main spectrum
    const an = m.analyser;
    if (an) {
      if (!this.bins || this.bins.length !== an.frequencyBinCount) this.bins = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.bins);
      const binHz = m.sampleRate / an.fftSize;
      if (!this.avg || this.avg.length !== W) this.avg = new Float32Array(W).fill(SILENT_DB);
      const ys = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const b = Math.min(this.bins.length - 1, Math.round(x / W * this.span / binHz));
        this.avg[x] += (audibleDb(this.bins[b]) - this.avg[x]) * 0.3;
        ys[x] = base - Math.max(0, Math.min(1, (this.avg[x] - this.floor) / this.range)) * (base - top);
      }
      c.beginPath(); c.moveTo(0, base);
      for (let x = 0; x < W; x++) c.lineTo(x, ys[x]);
      c.lineTo(W, base); c.closePath();
      c.fillStyle = alpha(k.traceFill, 0.16); c.fill();
      c.beginPath();
      for (let x = 0; x < W; x++) (x ? c.lineTo : c.moveTo).call(c, x, ys[x]);
      c.strokeStyle = alpha(k.trace, 0.45); c.lineWidth = 1 * d; c.stroke();
    }

    // passband trapezoid
    const pb = passbandEdges(m);
    // the bottom corners sit on the passband edges; the sides slope in from there
    const lo = xOf(pb.lo), hi = xOf(pb.hi), skirt = Math.min(8 * d, (hi - lo) / 4);
    c.beginPath();
    c.moveTo(lo, base); c.lineTo(lo + skirt, top); c.lineTo(hi - skirt, top); c.lineTo(hi, base);
    c.closePath();
    c.fillStyle = alpha(k.accent, 0.14); c.fill();
    c.strokeStyle = k.accent; c.lineWidth = 1.6 * d; c.stroke();

    // contour: a dip drawn on the passband top
    if (m.contour) {
      const x = xOf(m.contourHz);
      c.strokeStyle = k.contour; c.lineWidth = 2 * d; c.beginPath();
      c.moveTo(x - 22 * d, top); c.quadraticCurveTo(x, top + 26 * d, x + 22 * d, top); c.stroke();
    }
    // notch: a V cut
    if (m.notch) {
      const x = xOf(m.notchHz);
      c.strokeStyle = k.notch; c.lineWidth = 2 * d; c.beginPath();
      c.moveTo(x - 7 * d, top); c.lineTo(x, base); c.lineTo(x + 7 * d, top); c.stroke();
    }
    // shift arrow
    if (m.shift) {
      const cx = (lo + hi) / 2;
      c.fillStyle = k.accent; c.font = `600 ${10.5 * d}px ${k.mono}`; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(`${m.shift > 0 ? '+' : ''}${m.shift} Hz`, cx, 1 * d);
    }
    // axis
    c.fillStyle = k.label; c.font = `${10 * d}px ${k.mono}`; c.textBaseline = 'bottom';
    for (let f = 0; f <= this.span; f += 1000) {
      c.textAlign = f === 0 ? 'left' : f === this.span ? 'right' : 'center';
      c.fillText(f ? `${f / 1000}k` : '0', xOf(f) + (f === 0 ? 3 * d : f === this.span ? -3 * d : 0), H - 2 * d);
    }
    if (m.dnf) { c.fillStyle = k.dnf; c.textAlign = 'right'; c.textBaseline = 'top'; c.fillText('DNF', W - 4 * d, 2 * d); }
    if (m.nr) { c.fillStyle = k.dnr; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(`DNR ${m.nr}`, 4 * d, 2 * d); }
  }
}
