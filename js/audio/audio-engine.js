// AudioEngine: USB audio to/from the FTX-1, plus the analyser that feeds
// the waterfall, AF spectrum and oscilloscope.
//
//   RX:  radio USB codec (input) ─┬─> analyser (waterfall/scope)
//                                 └─> volume ─> PC speakers (AudioContext sink)
//   TX:  PC microphone ─> mic level ─> gate (open only while PTT) ─> radio USB codec (output),
//        in a second AudioContext of its own whose output device is the radio
//        The microphone track itself is muted except while PTT is down.
//
// Chrome/Edge are required for output-device selection (setSinkId).

// How the radio's sound device can be named. Windows may call the FTX-1's codec
// "USB Audio CODEC" or "USB Audio Device"; Chrome adds its USB ID (0d8c:0016).
const RADIO_LABEL = /usb audio codec|0d8c:0016|ftx|yaesu|burr-brown|pcm29/i;
const MIC_OFF_DELAY_MS = 80; // lets the TX gate finish closing before the mic is muted
const COMMS_DEVICE = 'Windows has the radio set as its "default communication device", and then the browser can’t send audio to it (it plays on your PC speakers instead). '
  + 'Fix: Settings > System > Sound > More sound settings > Playback, right-click your PC speakers and choose "Set as Default Communication Device", then turn PC MIC on again';
const TX_DEVICE_CHECK_MS = 300; // how long to wait for the radio's output to report a problem
const DEVICE_BUSY = "the radio's audio output couldn't be opened. It may be in use by another program or another FTX Deck tab, or set to exclusive mode in Windows sound settings";
// Chrome's entries that stand for "the operating system's current default".
export const isVirtualDevice = id => id === 'default' || id === 'communications';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.analyser = null;
    this.rxSource = null;
    this.rxStream = null;
    this.rxVolume = null;
    this.micStream = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.txGate = null;
    this.txCtx = null;    // the TX path's own AudioContext, output = the radio
    this._micOffTimer = null;
    this.demoNodes = [];
    this.state = {
      running: false, demo: false, error: null,
      inputs: [], outputs: [],
      radioIn: '', radioOut: '', speakers: '', mic: '',
      volume: 0.7, txLevel: 0.8, txActive: false, muted: false,
    };
    this._load();
  }

  _emit() { this.dispatchEvent(new Event('change')); }
  _patch(p) { Object.assign(this.state, p); this._save(); this._emit(); }

  _load() {
    try {
      const s = JSON.parse(localStorage.getItem('ftxdeck.audio.v1'));
      if (s) for (const k of ['radioIn', 'radioOut', 'speakers', 'mic', 'volume', 'txLevel']) if (k in s) this.state[k] = s[k];
    } catch { /* ignore */ }
  }
  _save() {
    try {
      const { radioIn, radioOut, speakers, mic, volume, txLevel } = this.state;
      localStorage.setItem('ftxdeck.audio.v1', JSON.stringify({ radioIn, radioOut, speakers, mic, volume, txLevel }));
    } catch { /* ignore */ }
  }

  static supported() {
    return !!(globalThis.AudioContext && navigator.mediaDevices?.getUserMedia);
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.15;
    this.analyser.minDecibels = -130;
    this.analyser.maxDecibels = -20;
    this.rxVolume = this.ctx.createGain();
    this.rxVolume.gain.value = this.state.muted ? 0 : this.state.volume;
    this.rxVolume.connect(this.ctx.destination);
    return this.ctx;
  }

  // Ask for mic permission once so device labels become visible, then list devices.
  async refreshDevices({ askPermission = false } = {}) {
    if (askPermission) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (e) {
        this._patch({ error: `Microphone permission is needed to list audio devices (${e.message}).` });
        return;
      }
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Input' }));
    const outputs = all.filter(d => d.kind === 'audiooutput').map(d => ({ id: d.deviceId, label: d.label || 'Output' }));
    const pick = (list, cur, radio) => {
      // The radio must be the device itself, never Chrome's "Default" or
      // "Communications" entry: those follow whatever Windows' default is at the
      // moment, even when their label still names the radio.
      if (cur && list.some(d => d.id === cur) && !(radio && isVirtualDevice(cur))) return cur;
      const r = list.find(d => !isVirtualDevice(d.id) && RADIO_LABEL.test(d.label));
      if (radio) return r?.id || '';
      const nonRadio = list.find(d => !RADIO_LABEL.test(d.label) && d.id !== 'communications');
      return nonRadio?.id || list[0]?.id || '';
    };
    this._patch({
      inputs, outputs,
      radioIn: pick(inputs, this.state.radioIn, true),
      radioOut: pick(outputs, this.state.radioOut, true),
      speakers: pick(outputs, this.state.speakers, false),
      mic: pick(inputs, this.state.mic, false),
    });
  }

  // ---------------- receive ----------------
  async startRx() {
    await this.stopRx();
    this._ensureContext();
    await this.ctx.resume();
    try {
      this.rxStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.state.radioIn ? { exact: this.state.radioIn } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 1, sampleRate: 48000,
        },
      });
    } catch (e) {
      this._patch({ error: `Couldn't open the radio's audio input: ${e.message}` });
      throw e;
    }
    this.rxSource = this.ctx.createMediaStreamSource(this.rxStream);
    this.rxSource.connect(this.analyser);
    this.rxSource.connect(this.rxVolume);
    await this._applySpeakers();
    this._patch({ running: true, demo: false, error: null });
  }

  async _applySpeakers() {
    if (this.ctx?.setSinkId && this.state.speakers) {
      try { await this.ctx.setSinkId(this.state.speakers); } catch (e) { this._patch({ error: `Speaker output: ${e.message}` }); }
    }
  }

  async stopRx() {
    this.rxSource?.disconnect();
    this.rxStream?.getTracks().forEach(t => t.stop());
    this.rxSource = null; this.rxStream = null;
    this._stopDemo();
    this._patch({ running: false, demo: false });
  }

  setVolume(v) { this._patch({ volume: v }); this._applyVolume(); }
  setMuted(m) { this._patch({ muted: m }); this._applyVolume(); }
  _applyVolume() {
    const s = this.state;
    if (this.rxVolume) this.rxVolume.gain.setTargetAtTime(s.muted ? 0 : s.volume, this.ctx.currentTime, 0.02);
  }

  async setDevice(key, id) {
    this._patch({ [key]: id });
    if (key === 'speakers') await this._applySpeakers();
    if (key === 'radioIn' && this.state.running && !this.state.demo) await this.startRx();
    if ((key === 'mic' || key === 'radioOut') && this.micStream) await this.startTxPath();
  }

  // ---------------- transmit ----------------
  // The TX path has its own AudioContext whose output is the radio's USB audio
  // device, so the mic never shares an engine with the receive audio that plays
  // on the PC speakers. It's built ahead of time with its gate closed, so keying
  // is instant.
  async startTxPath() {
    this.stopTxPath();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.state.mic ? { exact: this.state.mic } : undefined,
          echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1,
        },
      });
    } catch (e) {
      this._patch({ error: `Couldn't open the PC microphone: ${e.message}` });
      throw e;
    }
    this._setMicLive(false);
    // The mic must reach the radio's USB output or nowhere.
    try {
      // Device IDs belong to each site and can change, so look the radio up
      // again now, while the microphone is open and the device list is complete.
      await this.refreshDevices();
      if (!this.state.radioOut) throw new Error('no radio audio output (USB Audio CODEC / USB Audio Device) was found');
      // When Windows has the radio as its "default communication device",
      // Chromium opens it through that role, the open fails, and it silently
      // plays on the default device instead: the PC speakers.
      const comms = this.state.outputs.find(o => o.id === 'communications');
      if (comms && RADIO_LABEL.test(comms.label)) throw new Error(COMMS_DEVICE);
      const ctx = this.txCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      if (!ctx.setSinkId) throw new Error("this browser can't send audio to a chosen output device");
      // If the device can't be opened (in use by another program, exclusive mode,
      // an unsupported format), Chrome reports an error and plays on the default
      // output instead: the PC speakers. So listen for that, before and after start.
      let deviceError = false;
      ctx.addEventListener('error', () => {
        deviceError = true;
        if (this.txCtx === ctx) this._txDeviceFailed();
      });
      await ctx.setSinkId(this.state.radioOut);
      if (ctx.sinkId !== this.state.radioOut) throw new Error("the browser didn't switch to it");
      await ctx.resume();
      await new Promise(r => setTimeout(r, TX_DEVICE_CHECK_MS));
      if (deviceError) throw new Error(DEVICE_BUSY);
      this.micSource = ctx.createMediaStreamSource(this.micStream);
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 1024;
      this.txGate = ctx.createGain();
      this.txGate.gain.value = 0;
      this.micSource.connect(this.micAnalyser);
      this.micSource.connect(this.txGate).connect(ctx.destination);
    } catch (e) {
      this.stopTxPath();
      const msg = `Couldn't send the PC mic to the radio's USB audio output: ${e.message}. PC MIC has been left off. Check "Radio audio out" in Settings.`;
      this._patch({ error: msg });
      throw new Error(msg);
    }
    this._emit();
  }

  // The radio's output failed after PC MIC was already on: shut it off rather
  // than let Chrome carry on playing the mic on the PC speakers.
  _txDeviceFailed() {
    this.stopTxPath();
    this._patch({ error: `Couldn't send the PC mic to the radio's USB audio output: ${DEVICE_BUSY}. PC MIC has been turned off.` });
  }

  stopTxPath() {
    this.setTxActive(false);
    this.micStream?.getTracks().forEach(t => t.stop());
    this.micSource?.disconnect();
    this.txCtx?.close().catch(() => {});
    this.micStream = null; this.micSource = null; this.micAnalyser = null; this.txGate = null; this.txCtx = null;
  }

  get txReady() { return !!this.txGate; }

  setTxActive(on) {
    if (this.txGate) this.txGate.gain.setTargetAtTime(on ? this.state.txLevel : 0, this.txGate.context.currentTime, 0.01);
    // Unkeyed, the mic is muted at the source once the gate has closed.
    clearTimeout(this._micOffTimer);
    if (on) this._setMicLive(true); else this._micOffTimer = setTimeout(() => this._setMicLive(false), MIC_OFF_DELAY_MS);
    if (this.state.txActive !== on) this._patch({ txActive: on });
  }

  // A disabled track delivers silence: nothing from the microphone reaches
  // the page. The device itself stays open so keying up is instant.
  _setMicLive(live) {
    for (const t of this.micStream?.getAudioTracks() ?? []) t.enabled = live;
  }
  setTxLevel(v) {
    this._patch({ txLevel: v });
    if (this.txGate && this.state.txActive) this.txGate.gain.setTargetAtTime(v, this.txGate.context.currentTime, 0.02);
  }

  micLevel() {
    if (!this.micAnalyser) return 0;
    const buf = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(buf);
    let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x));
    return peak;
  }

  // ---------------- demo band ----------------
  // A synthetic band: hiss, a few CW signals, an SSB-like voice blob and
  // FT8-like tones, so the waterfall has something to show without a radio.
  async startDemo() {
    await this.stopRx();
    this._ensureContext();
    await this.ctx.resume();
    const ctx = this.ctx;
    const out = ctx.createGain(); out.gain.value = 1;
    out.connect(this.analyser);
    out.connect(this.rxVolume);
    const nodes = [out];

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = (gain, lo, hi) => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = hi;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(hp).connect(lp).connect(g); src.start();
      nodes.push(src, hp, lp, g);
      return g;
    };
    noise(0.015, 150, 3200).connect(out);

    // CW signals keyed with a slow pseudo-random pattern
    const cw = (freq, level, rate) => {
      const o = ctx.createOscillator(); o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(g).connect(out); o.start();
      nodes.push(o, g);
      let t = ctx.currentTime + 0.1;
      const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0];
      const schedule = () => {
        if (!this.state.demo) return;
        while (t < ctx.currentTime + 2) {
          for (const on of pattern) {
            g.gain.setTargetAtTime(on ? level : 0, t, 0.004);
            t += rate;
          }
        }
        setTimeout(schedule, 800);
      };
      schedule();
    };

    // SSB-like voice: band-limited noise with a syllable-rate envelope
    const voice = noise(0, 350, 2600);
    voice.connect(out);
    const envOsc = ctx.createOscillator(); envOsc.frequency.value = 3.1;
    const envGain = ctx.createGain(); envGain.gain.value = 0.05;
    const envOsc2 = ctx.createOscillator(); envOsc2.frequency.value = 0.37;
    const env2 = ctx.createGain(); env2.gain.value = 0.04;
    envOsc.connect(envGain).connect(voice.gain);
    envOsc2.connect(env2).connect(voice.gain);
    envOsc.start(); envOsc2.start();
    nodes.push(envOsc, envGain, envOsc2, env2);

    // FT8-like 8-tone signals
    const ft = (base, level) => {
      const o = ctx.createOscillator(); o.frequency.value = base;
      const g = ctx.createGain(); g.gain.value = level;
      o.connect(g).connect(out); o.start();
      nodes.push(o, g);
      const step = () => {
        if (!this.state.demo) return;
        o.frequency.setValueAtTime(base + 6.25 * Math.floor(Math.random() * 8), ctx.currentTime);
        setTimeout(step, 160);
      };
      step();
    };

    this.demoNodes = nodes;
    this._patch({ running: true, demo: true, error: null });
    cw(700, 0.05, 0.07);
    cw(1180, 0.02, 0.055);
    cw(2350, 0.012, 0.09);
    ft(1500, 0.01);
    ft(1920, 0.006);
  }

  _stopDemo() {
    for (const n of this.demoNodes) { try { n.stop?.(); } catch { /* ignore */ } try { n.disconnect(); } catch { /* ignore */ } }
    this.demoNodes = [];
  }

  // For demo mode: simulate the radio's receiver muting while transmitting.
  setDemoMuted(m) {
    if (this.state.demo && this.demoNodes[0]) this.demoNodes[0].gain.setTargetAtTime(m ? 0.02 : 1, this.ctx.currentTime, 0.02);
  }

  get sampleRate() { return this.ctx?.sampleRate || 48000; }
}
