// RadioService: owns the CAT link, polls the FTX-1, and exposes setters.
// UI code listens for 'change' events and reads `radio.state`.

import { cmd, parse, RADIO_ID, calibrate, preampBandType, bandForFreq, bandDefault, BANDS } from './cat/ftx1.js';
import { CatLink } from './cat/cat-link.js';

const HOLD_MS = 700;       // ignore polled values this long after a local change
const TX_POLL_METERS = ['PO', 'SWR', 'ALC'];

export function initialState() {
  return {
    connected: false, connecting: false, demo: false, linkLabel: '', radioId: null, warning: null,
    head: 'optima', maxWatts: 100, minWatts: 5,
    freqA: 14250000, freqB: 7074000, modeA: 'USB', modeB: 'DATA-U',
    active: 0, split: false,
    tx: false, tuning: false,
    sRaw: 0, sRawB: 0, poRaw: 0, swrRaw: 0, alcRaw: 0,
    af: 128, rf: 255, sql: 0, agc: 4, preamp: 1, att: false,
    width: 17, shift: 0, nb: 0, nr: 0, dnf: false, notch: false, notchHz: 1000,
    contour: false, contourHz: 1000, narrow: false,
    power: 50, mic: 50, proc: false, procLevel: 50, amc: 50, vox: false, voxGain: 50, mon: 50,
    keySpeed: 20, keyPitch: 600,
    txTimeoutS: 180, txStartedAt: 0, license: 'general',
    stats: null,
  };
}

export class RadioService extends EventTarget {
  constructor() {
    super();
    this.state = initialState();
    this.link = null;
    this.transport = null;
    this._held = new Map();
    this._loop = null;
    this._slowIdx = 0;
    this._txWatchdog = null;
    this.traffic = [];     // last CAT lines, for the diagnostics panel
  }

  _emit() { this.dispatchEvent(new Event('change')); }
  _patch(p) { Object.assign(this.state, p); this._emit(); }

  _hold(key) { this._held.set(key, performance.now() + HOLD_MS); }
  _isHeld(key) { const t = this._held.get(key); return t && performance.now() < t; }
  _poll(key, value) {
    if (value == null || this._isHeld(key)) return;
    if (this.state[key] !== value) { this.state[key] = value; this._changed = true; }
  }

  get rx() { return this.state.active; }           // DSP controls follow the selected receiver
  get activeFreq() { return this.state.active ? this.state.freqB : this.state.freqA; }
  get activeMode() { return this.state.active ? this.state.modeB : this.state.modeA; }

  // ---------------- connection ----------------
  async connect(transport, { demo = false } = {}) {
    if (this.state.connected || this.state.connecting) await this.disconnect();
    this._patch({ connecting: true, warning: null, demo });
    this.transport = transport;
    try {
      await transport.open();
    } catch (e) {
      this._patch({ connecting: false });
      throw e;
    }
    this.link = new CatLink(transport, {
      onTraffic: (dir, text) => {
        this.traffic.push(`${dir === 'tx' ? '>' : '<'} ${text}`);
        if (this.traffic.length > 200) this.traffic.splice(0, this.traffic.length - 200);
      },
    });
    transport.onClose = reason => this._lost(reason);

    const idReply = await this.link.read(cmd.id());
    const id = parse.id(idReply);
    if (!id) {
      await this.disconnect();
      throw new Error('No answer to ID; — check the COM port (use the Enhanced COM port), the baud rate (radio menu CAT RATE, default 38400) and that the radio is on.');
    }
    const warning = id === RADIO_ID ? null : `Radio answered ID ${id}, not 0840 (FTX-1). Controls may not work.`;
    await this.link.set(cmd.ai(false));

    this._patch({ connected: true, connecting: false, radioId: id, warning, linkLabel: transport.label });
    await this.readAll();
    this._startLoop();
  }

  async disconnect() {
    if (this.state.tx) await this.setPtt(false);
    this._stopLoop();
    this.link?.close();
    const t = this.transport;
    this.link = null; this.transport = null;
    if (t) { t.onClose = () => {}; await t.close().catch(() => {}); }
    this._patch({ connected: false, connecting: false, demo: false, tx: false, tuning: false, sRaw: 0, poRaw: 0, swrRaw: 0, alcRaw: 0 });
  }

  _lost(reason) {
    if (!this.state.connected) return;
    this._stopLoop();
    this.link?.close();
    this.link = null;
    clearTimeout(this._txWatchdog);
    this._patch({ connected: false, tx: false, tuning: false, warning: `Connection lost (${reason}).` });
  }

  // ---------------- polling ----------------
  async readAll() {
    const L = this.link; if (!L) return;
    const pc = parse.power(await L.read('PC;'));
    if (pc) {
      const optima = pc.head === 'optima';
      this._patch({ head: pc.head, power: pc.watts, maxWatts: optima ? 100 : 10, minWatts: optima ? 5 : 0.5 });
    }
    this._poll('active', parse.plain(await L.read('VS;'), 'VS'));
    for (const r of this._slowReads()) await r();
    await this._fastCycle();
    this._emit();
  }

  _slowReads() {
    const L = this.link;
    const v = () => this.rx;
    const q = async c => L ? L.read(c) : null;
    return [
      async () => this._poll('freqB', parse.freq(await q('FB;'))),
      async () => this._poll('modeB', parse.mode(await q('MD1;'))),
      async () => this._poll('modeA', parse.mode(await q('MD0;'))),
      async () => this._poll('split', (n => n == null ? null : n === 1)(parse.txVfo(await q('FT;')))),
      async () => this._poll('active', parse.plain(await q('VS;'), 'VS')),
      async () => this._poll('af', parse.vfoLevel(await q(`AG${v()};`), 'AG')),
      async () => this._poll('rf', parse.vfoLevel(await q(`RG${v()};`), 'RG')),
      async () => this._poll('sql', parse.vfoLevel(await q(`SQ${v()};`), 'SQ')),
      async () => this._poll('agc', parse.agc(await q(`GT${v()};`))),
      async () => this._poll('preamp', parse.preamp(await q(`PA${preampBandType(this.activeFreq)};`))),
      async () => this._poll('att', parse.flag(await q('RA0;'), 'RA')),
      async () => this._poll('width', parse.width(await q(`SH${v()};`))),
      async () => this._poll('shift', parse.ifShift(await q(`IS${v()};`))),
      async () => this._poll('nb', parse.vfoLevel(await q(`NL${v()};`), 'NL')),
      async () => this._poll('nr', parse.vfoLevel(await q(`RL${v()};`), 'RL')),
      async () => this._poll('dnf', parse.flag(await q(`BC${v()};`), 'BC')),
      async () => { const r = parse.sub(await q(`BP${v()}0;`), 'BP'); this._poll('notch', r ? r.value === 1 : null); },
      async () => { const r = parse.sub(await q(`BP${v()}1;`), 'BP'); this._poll('notchHz', r ? r.value * 10 : null); },
      async () => { const r = parse.sub(await q(`CO${v()}0;`), 'CO'); this._poll('contour', r ? r.value === 1 : null); },
      async () => { const r = parse.sub(await q(`CO${v()}1;`), 'CO'); this._poll('contourHz', r ? r.value : null); },
      async () => this._poll('narrow', parse.flag(await q(`NA${v()};`), 'NA')),
      async () => { const p = parse.power(await q('PC;')); this._poll('power', p?.watts ?? null); },
      async () => this._poll('mic', parse.plain(await q('MG;'), 'MG')),
      async () => this._poll('proc', parse.flag(await q('PR0;'), 'PR')),
      async () => this._poll('procLevel', parse.plain(await q('PL;'), 'PL')),
      async () => this._poll('amc', parse.plain(await q('AO;'), 'AO')),
      async () => this._poll('vox', parse.flag(await q('VX;'), 'VX')),
      async () => this._poll('voxGain', parse.plain(await q('VG;'), 'VG')),
      async () => this._poll('mon', parse.vfoLevel(await q('ML0;'), 'ML')),
      async () => this._poll('keySpeed', parse.plain(await q('KS;'), 'KS')),
      async () => this._poll('keyPitch', parse.keyPitch(await q('KP;'))),
    ];
  }

  async _fastCycle() {
    const L = this.link; if (!L) return;
    this._poll('freqA', parse.freq(await L.read('FA;')));
    this._poll('tx', parse.ptt(await L.read('TX;')));
    if (this.state.tx || this.state.tuning) {
      for (const m of TX_POLL_METERS) {
        const n = { PO: 5, SWR: 6, ALC: 4 }[m];
        const r = parse.meter(await L.read(cmd.readMeter(n)));
        if (r) this.state[{ PO: 'poRaw', SWR: 'swrRaw', ALC: 'alcRaw' }[m]] = r.raw;
      }
      this._changed = true;
    } else {
      const s = parse.smeter(await L.read(`SM${this.rx};`));
      if (s != null) { this.state.sRaw = s; this._changed = true; }
      if (this.state.poRaw || this.state.swrRaw || this.state.alcRaw) {
        Object.assign(this.state, { poRaw: 0, swrRaw: 0, alcRaw: 0 });
      }
    }
    if (this.state.tuning) {
      const t = parse.tuning(await L.read('AC;'));
      if (t === false) this._poll('tuning', false);
    }
  }

  _startLoop() {
    this._stopLoop();
    const token = {};
    this._loop = token;
    const run = async () => {
      while (this._loop === token && this.link) {
        const t0 = performance.now();
        this._changed = false;
        await this._fastCycle();
        const slow = this._slowReads();
        // two slow reads per cycle keeps the whole panel fresh every ~1–2 s
        for (let i = 0; i < 2 && this.link; i++) {
          await slow[this._slowIdx % slow.length]();
          this._slowIdx++;
        }
        this.state.stats = this.link ? { ...this.link.stats } : null;
        if (this._changed) this._emit();
        const dt = performance.now() - t0;
        await new Promise(r => setTimeout(r, Math.max(15, 70 - dt)));
      }
    };
    run().catch(e => { console.error(e); this._lost(e.message); });
  }

  _stopLoop() { this._loop = null; }

  // ---------------- setters ----------------
  _set(command, key, patch, coalesce) {
    if (patch) { for (const k of Object.keys(patch)) this._hold(k); this._patch(patch); }
    if (!this.link) return Promise.resolve(false);
    return this.link.set(command, { coalesce: coalesce ?? key });
  }

  setFreq(v, hz) {
    hz = Math.max(30000, Math.min(470000000, Math.round(hz)));
    const key = v ? 'freqB' : 'freqA';
    return this._set(cmd.freq(v, hz), key, { [key]: hz });
  }
  tuneBy(v, deltaHz) { return this.setFreq(v, (v ? this.state.freqB : this.state.freqA) + deltaHz); }
  setMode(v, mode) {
    const key = v ? 'modeB' : 'modeA';
    const p = this._set(cmd.mode(v, mode), key, { [key]: mode });
    this._held.delete('width'); // width table changes with mode; let the next poll refresh it
    return p;
  }
  selectVfo(v) { return this._set(cmd.vfoSelect(v), 'active', { active: v }); }
  setSplit(on) { return this._set(cmd.txVfo(on ? 1 : 0), 'split', { split: on }); }
  aToB() { this._patch({ freqB: this.state.freqA, modeB: this.state.modeA }); this._hold('freqB'); this._hold('modeB'); return this.link?.set(cmd.aToB()); }
  bToA() { this._patch({ freqA: this.state.freqB, modeA: this.state.modeB }); this._hold('freqA'); this._hold('modeA'); return this.link?.set(cmd.bToA()); }
  swap() {
    const s = this.state;
    this._patch({ freqA: s.freqB, freqB: s.freqA, modeA: s.modeB, modeB: s.modeA });
    ['freqA', 'freqB', 'modeA', 'modeB'].forEach(k => this._hold(k));
    return this.link?.set(cmd.swap());
  }

  // Band stacking: remember the last frequency/mode used on each band. A band's
  // first visit, or picking the band you're already on, goes to its default
  // for the license class.
  gotoBand(bandId) {
    const band = BANDS.find(b => b.id === bandId); if (!band) return;
    const v = this.state.active;
    const cur = bandForFreq(this.activeFreq);
    const stack = loadStack();
    if (cur) stack[cur.id] = { freq: this.activeFreq, mode: this.activeMode };
    saveStack(stack);
    const def = bandDefault(band, this.state.license);
    const target = cur?.id === band.id ? def : stack[band.id] || def;
    this.setFreq(v, target.freq);
    this.setMode(v, target.mode);
  }

  setAf(n) { return this._set(cmd.afGain(this.rx, n), 'af', { af: n }); }
  setRf(n) { return this._set(cmd.rfGain(this.rx, n), 'rf', { rf: n }); }
  setSql(n) { return this._set(cmd.squelch(this.rx, n), 'sql', { sql: n }); }
  setAgc(n) { return this._set(cmd.agc(this.rx, n), 'agc', { agc: n }); }
  setPreamp(n) { return this._set(cmd.preamp(preampBandType(this.activeFreq), n), 'preamp', { preamp: n }); }
  setAtt(on) { return this._set(cmd.att(on), 'att', { att: on }); }
  setWidth(code) { return this._set(cmd.width(this.rx, code), 'width', { width: code }); }
  setShift(hz) { return this._set(cmd.ifShift(this.rx, hz), 'shift', { shift: Math.max(-1200, Math.min(1200, Math.round(hz / 20) * 20)) }); }
  setNb(n) { return this._set(cmd.nbLevel(this.rx, n), 'nb', { nb: n }); }
  setNr(n) { return this._set(cmd.nrLevel(this.rx, n), 'nr', { nr: n }); }
  setDnf(on) { return this._set(cmd.dnf(this.rx, on), 'dnf', { dnf: on }); }
  setNotch(on) { return this._set(cmd.notch(this.rx, on), 'notch', { notch: on }); }
  setNotchHz(hz) { return this._set(cmd.notchFreq(this.rx, hz), 'notchHz', { notchHz: Math.round(hz / 10) * 10 }); }
  setContour(on) { return this._set(cmd.contour(this.rx, on), 'contour', { contour: on }); }
  setContourHz(hz) { return this._set(cmd.contourFreq(this.rx, hz), 'contourHz', { contourHz: Math.round(hz) }); }
  setNarrow(on) { return this._set(cmd.narrow(this.rx, on), 'narrow', { narrow: on }); }

  setPower(w) {
    const s = this.state;
    w = s.head === 'optima' ? Math.round(w) : Math.round(w * 2) / 2;
    w = Math.max(s.minWatts, Math.min(s.maxWatts, w));
    return this._set(cmd.power(s.head, w), 'power', { power: w });
  }
  setMic(n) { return this._set(cmd.micGain(n), 'mic', { mic: n }); }
  setProc(on) { return this._set(cmd.proc(on), 'proc', { proc: on }); }
  setProcLevel(n) { return this._set(cmd.procLevel(n), 'procLevel', { procLevel: n }); }
  setAmc(n) { return this._set(cmd.amc(n), 'amc', { amc: n }); }
  setVox(on) { return this._set(cmd.vox(on), 'vox', { vox: on }); }
  setVoxGain(n) { return this._set(cmd.voxGain(n), 'voxGain', { voxGain: n }); }
  setMon(n) { return this._set(cmd.monitorLevel(n), 'mon', { mon: n }); }
  setKeySpeed(n) { return this._set(cmd.keySpeed(n), 'keySpeed', { keySpeed: n }); }
  setKeyPitch(hz) { return this._set(cmd.keyPitch(hz), 'keyPitch', { keyPitch: Math.round(hz / 10) * 10 }); }

  // ---------------- transmit ----------------
  // PTT always goes out ahead of anything queued. A watchdog unkeys after
  // txTimeoutS no matter what, and every "unkey" path sends TX0 twice.
  async setPtt(on) {
    clearTimeout(this._txWatchdog);
    if (on) {
      if (!this.link) return false;
      this._hold('tx');
      this._patch({ tx: true, txStartedAt: Date.now() });
      this._txWatchdog = setTimeout(() => {
        this._patch({ warning: `Transmit timeout (${this.state.txTimeoutS} s) — unkeyed.` });
        this.setPtt(false);
      }, this.state.txTimeoutS * 1000);
      return this.link.set(cmd.ptt(true));
    }
    this._hold('tx');
    this._patch({ tx: false, txStartedAt: 0 });
    if (!this.link) return false;
    const ok = await this.link.set(cmd.ptt(false));
    this.link?.set(cmd.ptt(false), { coalesce: 'ptt-off-repeat' });
    return ok;
  }

  // Emergency unkey that doesn't wait for the queue (page closing etc.).
  panicUnkey() {
    clearTimeout(this._txWatchdog);
    try { this.transport?.write(cmd.ptt(false)); } catch { /* best effort */ }
    this.state.tx = false;
  }

  async tune() {
    if (!this.link) return;
    if (this.state.tuning) { this._patch({ tuning: false }); return this.link.set(cmd.tuneStop()); }
    this._hold('tuning');
    this._patch({ tuning: true });
    const ok = await this.link.set(cmd.tuneStart());
    if (!ok) this._patch({ tuning: false, warning: 'Radio rejected TUNE (the internal tuner needs the Optima/SPA-1; check the tuner selection in the radio menu).' });
    return ok;
  }

  // ---------------- derived values for the UI ----------------
  meters() {
    const s = this.state;
    return {
      sRaw: s.sRaw, sLabel: calibrate.sLabel(s.sRaw), sDb: calibrate.sDb(s.sRaw),
      poWatts: calibrate.poWatts(s.poRaw, s.head === 'optima' ? 100 : 10),
      swr: s.tx || s.tuning ? calibrate.swr(s.swrRaw) : 1,
      alc: calibrate.alcFraction(s.alcRaw),
    };
  }
}

const STACK_KEY = 'ftxdeck.bandstack.v1';
function loadStack() { try { return JSON.parse(localStorage.getItem(STACK_KEY)) || {}; } catch { return {}; } }
function saveStack(s) { try { localStorage.setItem(STACK_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
