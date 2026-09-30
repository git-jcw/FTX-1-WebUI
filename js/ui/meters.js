// Arc meters drawn on canvas. Each meter maps its value to 0..1 along the arc,
// eases toward it (fast attack, slower release) and keeps a short peak hold.

import { calibrate } from '../cat/ftx1.js';

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const KINDS = {
  s: {
    title: 'S',
    pos: raw => { const db = calibrate.sDb(raw); return db <= 0 ? (db + 54) / 54 * 0.6 : 0.6 + Math.min(db, 60) / 60 * 0.4; },
    ticks: [[0, '0'], [0.6 * 3 / 9, '3'], [0.6 * 5 / 9, '5'], [0.6 * 7 / 9, '7'], [0.6, '9'], [0.6 + 0.4 / 3, '+20'], [0.6 + 0.8 / 3, '+40'], [1, '+60']],
    redFrom: 0.6,
    text: raw => calibrate.sLabel(raw),
  },
  po: {
    title: 'PO',
    pos: (w, max) => Math.min(1, w / max),
    ticks: max => [0, 0.25, 0.5, 0.75, 1].map(f => [f, String(+(f * max).toFixed(max < 20 ? 1 : 0))]),
    redFrom: null,
    text: w => `${w < 10 ? w.toFixed(1) : Math.round(w)} W`,
  },
  swr: {
    title: 'SWR',
    // reflection-coefficient scale: 1:1 at left, 5:1 near right
    pos: swr => Math.max(0, Math.min(1, ((swr - 1) / (swr + 1)) / (4 / 6))),
    ticks: [1, 1.5, 2, 3, 5].map(s => [((s - 1) / (s + 1)) / (4 / 6), s === 5 ? '5' : String(s)]),
    redFrom: ((3 - 1) / 4) / (4 / 6),
    text: swr => `${swr.toFixed(swr < 10 ? 2 : 1)}`,
  },
  alc: {
    title: 'ALC',
    pos: f => Math.min(1, f),
    ticks: [[0, '0'], [0.25, ''], [0.5, ''], [1, 'max']],
    redFrom: 0.25,
    text: f => `${Math.round(f * 100)}%`,
  },
};

export class ArcMeter {
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = KINDS[canvas.dataset.kind];
    this.value = 0; this.shown = 0; this.peak = 0; this.peakAt = 0;
    this.max = 100;
    this.active = true;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
  }

  set(value, { max, active = true } = {}) {
    this.value = value;
    if (max) this.max = max;
    this.active = active;
  }

  draw(now) {
    const k = this.kind;
    const target = k.pos(this.value, this.max);
    const up = target > this.shown;
    this.shown += (target - this.shown) * (up ? 0.55 : 0.14);
    if (this.shown >= this.peak || now - this.peakAt > 1400) { this.peak = this.shown; this.peakAt = now; }

    const c = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height, d = this.dpr;
    c.clearRect(0, 0, W, H);
    // Leave room for the tick labels above and beside the arc.
    const cx = W / 2, cy = H - 4 * d, R = Math.max(10 * d, Math.min(W / 2 - 30 * d, cy - 30 * d));
    const a0 = Math.PI * 1.18, a1 = Math.PI * 1.82;
    const ang = f => a0 + (a1 - a0) * f;
    const dim = css('--text-faint'), text = css('--text'), amber = css('--amber'), red = css('--red'), line = css('--line-2');

    // track
    c.lineCap = 'round';
    c.lineWidth = 7 * d;
    c.strokeStyle = line;
    c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
    if (k.redFrom != null) {
      c.strokeStyle = red + '55';
      c.beginPath(); c.arc(cx, cy, R, ang(k.redFrom), a1); c.stroke();
    }
    // value
    const f = Math.max(0, Math.min(1, this.shown));
    if (this.active && f > 0.002) {
      const grad = c.createLinearGradient(cx - R, 0, cx + R, 0);
      grad.addColorStop(0, amber);
      grad.addColorStop(k.redFrom ?? 1, amber);
      grad.addColorStop(Math.min(1, (k.redFrom ?? 1) + 0.001), red);
      c.strokeStyle = grad;
      c.beginPath(); c.arc(cx, cy, R, a0, ang(f)); c.stroke();
      // peak tick
      const pa = ang(Math.min(1, this.peak));
      c.strokeStyle = text; c.lineWidth = 2 * d;
      c.beginPath(); c.moveTo(cx + Math.cos(pa) * (R - 7 * d), cy + Math.sin(pa) * (R - 7 * d));
      c.lineTo(cx + Math.cos(pa) * (R + 7 * d), cy + Math.sin(pa) * (R + 7 * d)); c.stroke();
    }
    // ticks
    const ticks = typeof k.ticks === 'function' ? k.ticks(this.max) : k.ticks;
    c.font = `${10 * d}px ${css('--mono')}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [tf, label] of ticks) {
      const ta = ang(tf);
      c.strokeStyle = dim; c.lineWidth = 1 * d;
      c.beginPath(); c.moveTo(cx + Math.cos(ta) * (R + 6 * d), cy + Math.sin(ta) * (R + 6 * d));
      c.lineTo(cx + Math.cos(ta) * (R + 10 * d), cy + Math.sin(ta) * (R + 10 * d)); c.stroke();
      if (label) { c.fillStyle = dim; c.fillText(label, cx + Math.cos(ta) * (R + 19 * d), cy + Math.sin(ta) * (R + 19 * d)); }
    }
    // title + readout
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillStyle = css('--text-dim'); c.font = `600 ${11 * d}px ${css('--sans')}`;
    c.fillText(k.title, 8 * d, 6 * d);
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.fillStyle = this.active ? text : dim;
    c.font = `600 ${Math.max(12, Math.min(18, R / d * 0.3)) * d}px ${css('--mono')}`;
    c.fillText(this.active ? k.text(this.value, this.max) : '—', cx, H - 8 * d);
  }
}
