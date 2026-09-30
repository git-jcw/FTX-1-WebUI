// RadioService: owns the CAT link, polls the FTX-1, and exposes setters.
// UI code listens for 'change' events and reads `radio.state`.

import { cmd, parse, RADIO_ID, calibrate, preampBandType, bandForFreq, bandDefault, BANDS,
  METER, MENU, TUNER, TUNER_NAMES, tuneCommands, powerLimits, FIELD_BATTERY_MAX_W, MOD_SOURCES, modSourceMenu } from './cat/ftx1.js';
import { CatLink } from './cat/cat-link.js';

const HOLD_MS = 700;       // ignore polled values this long after a local change
const TUNE_GAP_MS = 150;   // how long to wait for "?;" after a tuner command
const TUNE_MAX_MS = 90000; // stop showing TUNING after this, whatever the radio reports
const TUNE_QUIET_POLLS = 4;      // PO reads of zero in a row that mean the tuning carrier has gone
const TUNE_NO_CARRIER_MS = 3000; // give up waiting for a carrier that never appears
const AUTO_TUNE_MOVE_HZ = 10000; // auto tune again once this far from the last tuned frequency
const TX_POLL_METERS = ['PO', 'SWR', 'ALC'];

export function initialState() {
  return {
    connected: false, connecting: false, demo: false, linkLabel: '', radioId: null, warning: null,
    head: 'optima', battery: false, maxWatts: 100, minWatts: 5,
    freqA: 14250000, freqB: 7074000, modeA: 'USB', modeB: 'DATA-U',
    active: 0, split: false, dual: true,
    tx: false, tuning: false, tunerType: null, autoTune: false, autoTuneDelayS: 3,
    sRaw: 0, sRawB: 0, poRaw: 0, swrRaw: 0, alcRaw: 0,
    af: 128, rf: 255, sql: 0, agc: 4, preamp: 1, att: false,
    width: 17, shift: 0, nb: 0, nr: 0, dnf: false, notch: false, notchHz: 1000,
    contour: false, contourHz: 1000, narrow: false,
    sqlType: 0, toneIdx: 12, dcsIdx: 0, // tone squelch: CT type, CN indexes into CTCSS_TONES / DCS_CODES
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
    this._tuneStartedAt = 0;
    this._tuneCarrier = false;
    this._tuneQuiet = 0;
    this._autoRef = null;  // transmit frequency the tuner was last run on (or assumed good)
    this._autoFreq = null; // transmit frequency at the last check, and when it got there
    this._autoSince = 0;
    this.traffic = [];     // last CAT lines, for the diagnostics panel
  }

  _emit() { this._refreshLimits(); this.dispatchEvent(new Event('change')); }
  _patch(p) { Object.assign(this.state, p); this._emit(); }

  // minWatts / maxWatts follow the head, the transmit band and mode, and
  // (Field head) whether it has turned out to be running on its battery.
  _refreshLimits() {
    const s = this.state;
    const txB = s.split ? true : s.active === 1;
    const { min, max } = powerLimits({ head: s.head, hz: txB ? s.freqB : s.freqA, mode: txB ? s.modeB : s.modeA, battery: s.battery });
    // if the radio reports more than the table allows, the radio is right
    s.minWatts = Math.min(min, s.power); s.maxWatts = Math.max(max, s.power);
  }

  // Take the head type and power setting from a PC reply. The head is
  // re-checked on every poll, so fitting or removing the SPA-1 is noticed.
  _applyPower(pc) {
    if (!pc) return;
    if (pc.head !== this.state.head) { Object.assign(this.state, { head: pc.head, battery: false }); this._changed = true; }
    this._poll('power', pc.watts);
  }

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

    this._autoRef = null; // wherever the radio is when we connect counts as already tuned
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
    this.state.battery = false;
    this._applyPower(parse.power(await L.read('PC;')));
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
      async () => this._poll('dual', (n => n == null ? null : n === 0)(parse.plain(await q('FR;'), 'FR'))), // FR00 dual, FR01 single
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
      async () => this._poll('sqlType', parse.sqlType(await q(`CT${v()};`))),
      async () => this._poll('toneIdx', parse.toneCode(await q(`CN${v()}0;`))?.index ?? null),
      async () => this._poll('dcsIdx', parse.toneCode(await q(`CN${v()}1;`))?.index ?? null),
      async () => this._applyPower(parse.power(await q('PC;'))),
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
      if (this.state.tuning) {
        if (this.state.poRaw > 0) { this._tuneCarrier = true; this._tuneQuiet = 0; } else this._tuneQuiet++;
      }
    } else {
      // RM1/RM2, not SM: a real FTX-1 doesn't answer SM1, so SUB never got a reading.
      const s = parse.meter(await L.read(cmd.readMeter(this.rx ? METER.SUB_S : METER.MAIN_S)));
      if (s) { this.state.sRaw = s.raw; this._changed = true; }
      if (this.state.poRaw || this.state.swrRaw || this.state.alcRaw) {
        Object.assign(this.state, { poRaw: 0, swrRaw: 0, alcRaw: 0 });
      }
    }
    if (this.state.tuning) {
      const t = parse.tuning(await L.read('AC;'));
      if (t === false || this._tuneOver()) this._poll('tuning', false);
    }
  }

  // AC; can't be relied on to say a tune has finished: it keeps reporting the
  // tuner as on afterwards. So also watch the tuning carrier on the PO meter:
  // the cycle is over once the carrier has come and gone, or never appeared.
  _tuneOver() {
    const elapsed = performance.now() - this._tuneStartedAt;
    if (elapsed > TUNE_MAX_MS) return true;
    return this._tuneCarrier ? this._tuneQuiet >= TUNE_QUIET_POLLS : elapsed > TUNE_NO_CARRIER_MS;
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
        this._autoTuneCheck();
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
  setSqlType(n) { return this._set(cmd.sqlType(this.rx, n), 'sqlType', { sqlType: n }); }
  setToneIdx(i) { return this._set(cmd.ctcssTone(this.rx, i), 'toneIdx', { toneIdx: i }); }
  setDcsIdx(i) { return this._set(cmd.dcsCode(this.rx, i), 'dcsIdx', { dcsIdx: i }); }
  setNarrow(on) { return this._set(cmd.narrow(this.rx, on), 'narrow', { narrow: on }); }

  setPower(w) {
    const s = this.state;
    w = s.head === 'optima' ? Math.round(w) : Math.round(w * 2) / 2;
    w = Math.max(s.minWatts, Math.min(s.maxWatts, w));
    const sent = this._set(cmd.power(s.head, w), 'power', { power: w });
    if (this.link) sent.then(ok => { if (!ok) this._powerRejected(w); });
    return sent;
  }

  // The radio refused a power setting. A Field head that won't take more than
  // 6 W is on its battery; either way, show what the radio is really set to.
  async _powerRejected(w) {
    const s = this.state;
    if (s.head === 'field' && w > FIELD_BATTERY_MAX_W) s.battery = true;
    this._held.delete('power');
    this._applyPower(parse.power(await this.link?.read('PC;')));
    this._emit();
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

  // The tuner type the radio has selected for the HF antenna in use, or null
  // if the menu can't be read.
  async _readTunerType() {
    const menu = async item => parse.menu(await this.link?.read(cmd.readMenu(item)));
    const ant = await menu(MENU.HF_ANT);
    const type = await menu(ant === 1 ? MENU.TUNER_ANT2 : MENU.TUNER_ANT1);
    return type != null && type in TUNER_NAMES ? type : null;
  }

  // Send each AC form in turn until the radio takes one.
  async _firstAccepted(commands) {
    for (const c of commands) if (await this.link?.set(c, { gapMs: TUNE_GAP_MS })) return c;
    return null;
  }

  // TUNE starts a tune cycle on whichever tuner the radio menu has selected
  // (internal, external or ATAS); a second press stops it.
  async tune() {
    if (!this.link) return;
    if (this.state.tuning) {
      this._hold('tuning');
      this._patch({ tuning: false });
      return !!(await this._firstAccepted(tuneCommands(this.state.tunerType).stop));
    }
    this._hold('tuning');
    this._autoRef = this.txFreq;
    this._tuneStartedAt = performance.now();
    this._tuneCarrier = false; this._tuneQuiet = 0;
    this._patch({ tuning: true });
    const type = await this._readTunerType();
    const { start } = tuneCommands(type);
    const ok = !!(await this._firstAccepted(start));
    this._hold('tuning'); // the tries above may have used up the first hold
    if (ok) this._patch({ tunerType: type });
    else this._patch({ tuning: false, tunerType: type, warning: tuneRejected(type, start) });
    return ok;
  }

  // Where the radio takes transmit audio from in the transmit VFO's mode:
  // { group: 'SSB', source: 'MIC' }, or null if the mode has none or the radio won't say.
  async readModSource() {
    const s = this.state, m = modSourceMenu(s.split || s.active === 1 ? s.modeB : s.modeA);
    if (!m || !this.link) return null;
    const v = parse.menu(await this.link.read(cmd.readMenu(m.item)));
    return v != null && MOD_SOURCES[v] ? { group: m.group, source: MOD_SOURCES[v] } : null;
  }

  // ---------------- auto tune ----------------
  // With auto tune on, moving the transmit frequency well away from where the
  // tuner was last run, and then staying put for autoTuneDelayS, starts a tune
  // cycle. Each frequency gets one attempt. Transmitting there first cancels
  // it, so a tuning carrier never lands in the middle of a contact.
  get txFreq() { return this.state.split ? this.state.freqB : this.activeFreq; }

  setAutoTune(on) {
    this._autoRef = this.txFreq; // treat where we are now as already tuned
    this._patch({ autoTune: on });
  }

  // Milliseconds until an auto tune starts, or null if none is pending.
  autoTuneWait() {
    const s = this.state, f = this.txFreq;
    if (!s.connected || !s.autoTune || s.tx || s.tuning || this._autoRef == null) return null;
    if (!retuneNeeded(this._autoRef, f) || !tunerCovers(f)) return null;
    return Math.max(0, s.autoTuneDelayS * 1000 - (performance.now() - this._autoSince));
  }

  _autoTuneCheck() {
    const s = this.state, f = this.txFreq;
    // the settle timer restarts whenever the frequency moves, and doesn't run in a hidden tab
    if (f !== this._autoFreq || globalThis.document?.hidden) { this._autoFreq = f; this._autoSince = performance.now(); }
    if (this._autoRef == null || (s.tx && !s.tuning)) this._autoRef = f;
    if (this.autoTuneWait() === 0) this.tune();
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

// Auto tune: far enough from the last tuned frequency that the match is likely off.
function retuneNeeded(ref, hz) {
  return bandForFreq(ref)?.id !== bandForFreq(hz)?.id || Math.abs(hz - ref) >= AUTO_TUNE_MOVE_HZ;
}
// The tuners work on the HF and 50 MHz amateur bands only.
function tunerCovers(hz) { return hz <= 54000000 && !!bandForFreq(hz); }

function tuneRejected(type, tried) {
  const sel = type == null ? 'The radio\'s tuner setting couldn\'t be read.' : `The radio's tuner is set to ${TUNER_NAMES[type]}.`;
  const hint = type === TUNER.INT || type === TUNER.INT_FAST
    ? 'The internal tuner needs the Optima/SPA-1; for an external tuner set TUNER TYPE SEL to EXT in the radio menu.'
    : type === TUNER.EXT
      ? 'Check the tuner\'s control cable is in the TUNER/LINEAR jack and TUN/LIN PORT SELECT is EXT-TUNER.'
      : type === TUNER.ATAS
        ? 'Check the ATAS antenna is connected.'
        : 'Set TUNER TYPE SEL in the radio menu to the tuner you have.';
  return `Radio rejected TUNE (tried ${tried.map(c => c.slice(0, -1)).join(', ')}). ${sel} ${hint}`;
}

const STACK_KEY = 'ftxdeck.bandstack.v1';
function loadStack() { try { return JSON.parse(localStorage.getItem(STACK_KEY)) || {}; } catch { return {}; } }
function saveStack(s) { try { localStorage.setItem(STACK_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
