// FTX Deck — app wiring.

import { RadioService } from './radio.js';
import { WebSerialTransport } from './cat/transport.js';
import { MockRadioTransport } from './cat/mock-radio.js';
import { BANDS, bandForFreq, bandDefault, widthTable, AGC_NAMES, PREAMP_NAMES_HF, preampBandType,
  SQL_TYPE, CTCSS_TONES, DCS_CODES, modSourceMenu } from './cat/ftx1.js';
import { AudioEngine, isVirtualDevice } from './audio/audio-engine.js';
import { ArcMeter } from './ui/meters.js';
import { SpectrumWaterfall, Oscilloscope, PassbandView } from './ui/scope.js';
import { renderFreq, parseFreqInput, formatFreqShort } from './ui/vfo.js';
import { TuningDial } from './ui/dial.js';
import { THEMES, applyTheme } from './ui/theme.js';

const $ = id => document.getElementById(id);
const radio = new RadioService();
const audio = new AudioEngine();
window.ftx = { radio, audio }; // handy from the developer console (Ctrl+Shift+I)

// ---------------- settings (saved on this PC) ----------------
const SETTINGS_KEY = 'ftxdeck.settings.v1';
const settings = Object.assign({ baud: 38400, tot: 180, license: 'general', spacePtt: false, latchPtt: false, theme: 'shack', autoTune: false, autoTuneDelay: 3, step: 100, vfoView: 'auto', span: 8000, floor: -112, range: 62, speed: 2 },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })());
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
settings.theme = applyTheme(settings.theme);
radio.state.txTimeoutS = settings.tot;
radio.state.license = settings.license;
radio.state.autoTune = settings.autoTune;
radio.state.autoTuneDelayS = settings.autoTuneDelay;

// ---------------- banner ----------------
function banner(text, { error = false } = {}) {
  const b = $('banner');
  if (!text) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `banner${error ? ' err' : ''}`;
  b.innerHTML = '';
  const span = document.createElement('span'); span.textContent = text;
  const x = document.createElement('button'); x.className = 'btn btn-mini'; x.textContent = 'Dismiss';
  x.onclick = () => { b.hidden = true; if (radio.state.warning === text) radio.state.warning = null; };
  b.append(span, x);
}

// ---------------- connect / demo ----------------
$('btnConnect').onclick = async () => {
  if (radio.state.connected && !radio.state.demo) { await radio.disconnect(); await stopAllAudio(); return; }
  if (!WebSerialTransport.supported()) {
    banner('USB serial ports aren\'t available here. Run FTX Deck as the desktop app.', { error: true });
    return;
  }
  try {
    if (radio.state.demo) await leaveDemoAudio();
    const t = new WebSerialTransport({ baud: +settings.baud });
    await radio.connect(t);
    banner(radio.state.warning);
    if (!audio.state.running) startAudio().catch(() => {});
  } catch (e) {
    if (e?.name === 'NotFoundError') return; // user closed the port picker
    banner(`Couldn't connect: ${e.message}`, { error: true });
  }
};

// Connecting starts the audio, so disconnecting stops it: receive audio and the PC mic.
async function stopAllAudio() {
  if (pcMic) { audio.stopTxPath(); pcMic = false; }
  if (audio.state.running) { await audio.stopRx(); scope.clear(); }
  update();
}

// Demo starts with the speakers muted; put the mute back how it was on the way out.
let mutedBeforeDemo = false;
async function leaveDemoAudio() {
  if (audio.state.demo) { await audio.stopRx(); scope.clear(); }
  audio.setMuted(mutedBeforeDemo);
}

$('btnDemo').onclick = async () => {
  if (radio.state.demo) {
    await radio.disconnect();
    await leaveDemoAudio();
    return;
  }
  await radio.connect(new MockRadioTransport(), { demo: true });
  banner('Demo mode: a simulated FTX-1 Optima and a synthetic band. Nothing is sent to a real radio.');
  mutedBeforeDemo = audio.state.muted;
  await audio.startDemo();
  audio.setMuted(true);
};

async function startAudio() {
  if (!AudioEngine.supported()) { banner('Audio isn\'t available here. Run FTX Deck as the desktop app.', { error: true }); return; }
  await audio.refreshDevices({ askPermission: true });
  if (!audio.state.radioIn) {
    banner('No input named "USB Audio CODEC" found — pick the radio\'s audio input in Settings.', { error: true });
  }
  await audio.startRx();
}
$('btnAudio').onclick = async () => {
  try {
    if (audio.state.running) { await audio.stopRx(); scope.clear(); return; }
    if (radio.state.demo) await audio.startDemo(); else await startAudio();
  } catch (e) { banner(`Audio: ${e.message}`, { error: true }); }
};

// ---------------- VFOs ----------------
for (const el of [$('vfoA'), $('vfoB')]) {
  const v = +el.dataset.vfo;
  const freqEl = el.querySelector('.freq');
  el.addEventListener('click', () => { if (radio.state.active !== v) radio.selectVfo(v); });
  freqEl.addEventListener('wheel', e => {
    e.preventDefault();
    const place = +e.target.dataset?.place || settings.step;
    const dir = e.deltaY < 0 ? 1 : -1;
    radio.tuneBy(v, dir * place);
  }, { passive: false });
  freqEl.addEventListener('dblclick', () => openFreqEntry(v));
  freqEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { radio.tuneBy(v, settings.step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { radio.tuneBy(v, -settings.step); e.preventDefault(); }
    if (e.key === 'PageUp') { radio.tuneBy(v, settings.step * 10); e.preventDefault(); }
    if (e.key === 'PageDown') { radio.tuneBy(v, -settings.step * 10); e.preventDefault(); }
    if (e.key === 'Enter') openFreqEntry(v);
  });
}
$('selStep').value = String(settings.step);
$('selStep').onchange = e => { settings.step = +e.target.value; saveSettings(); };
$('selVfoView').value = settings.vfoView;
$('selVfoView').onchange = e => { settings.vfoView = e.target.value; saveSettings(); update(); };
new TuningDial($('dial'), { onStep: n => radio.tuneBy(radio.state.active, n * settings.step) });
$('btnAB').onclick = () => radio.aToB();
$('btnBA').onclick = () => radio.bToA();
$('btnSwap').onclick = () => radio.swap();
$('btnSplit').onclick = () => radio.setSplit(!radio.state.split);

function openFreqEntry(v) {
  const dlg = $('dlgFreq');
  $('freqTitle').textContent = `Tune VFO ${v ? 'B' : 'A'}`;
  const cur = v ? radio.state.freqB : radio.state.freqA;
  $('freqInput').value = (cur / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  dlg.returnValue = '';
  dlg.showModal();
  $('freqInput').select();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const hz = parseFreqInput($('freqInput').value);
    if (hz) radio.setFreq(v, hz); else banner('That frequency wasn\'t understood. Try 14.074 or 14074.', { error: true });
  };
}

// ---------------- bands & modes ----------------
const bandBox = $('bands');
for (const b of BANDS) {
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.textContent = b.label; btn.dataset.band = b.id;
  btn.onclick = () => radio.gotoBand(b.id);
  bandBox.append(btn);
}
const LICENSE_LABEL = { technician: 'Technician', general: 'General', extra: 'Amateur Extra' };
for (const [value, label] of Object.entries(LICENSE_LABEL)) {
  const o = document.createElement('option'); o.value = value; o.textContent = label;
  $('setLicense').append(o);
}
const UI_MODES = ['LSB', 'USB', 'CW-U', 'CW-L', 'AM', 'FM', 'DATA-U', 'DATA-L', 'RTTY-L', 'PSK', 'FM-N', 'DATA-FM'];
const MODE_LABEL = { 'CW-U': 'CW', 'DATA-U': 'DATA', 'DATA-FM': 'D-FM' };
const modeBox = $('modes');
for (const m of UI_MODES) {
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.textContent = MODE_LABEL[m] || m; btn.dataset.mode = m;
  btn.onclick = () => radio.setMode(radio.state.active, m);
  modeBox.append(btn);
}

// ---------------- FM tone squelch ----------------
const SQL_TYPE_LABEL = ['Off', 'Tone (ENC)', 'Tone squelch (TSQ)', 'DCS', 'PR freq', 'Reverse tone'];
const fillOptions = (id, labels) => { for (const [i, l] of labels.entries()) $(id).append(new Option(l, String(i))); };
fillOptions('selSqlType', SQL_TYPE_LABEL);
fillOptions('selTone', CTCSS_TONES.map(f => `${f.toFixed(1)} Hz`));
fillOptions('selDcs', DCS_CODES.map(c => `D${c}`));
$('selSqlType').onchange = e => radio.setSqlType(+e.target.value);
$('selTone').onchange = e => radio.setToneIdx(+e.target.value);
$('selDcs').onchange = e => radio.setDcsIdx(+e.target.value);
const isFm = mode => /^(FM|FM-N|DATA-FM|DATA-FM-N)$/.test(mode);
function refreshTone() {
  const s = radio.state;
  $('toneRow').hidden = !isFm(radio.activeMode);
  $('selTone').hidden = ![SQL_TYPE.ENC, SQL_TYPE.TSQ, SQL_TYPE.REV_TONE].includes(s.sqlType);
  $('selDcs').hidden = s.sqlType !== SQL_TYPE.DCS;
  for (const [id, v] of [['selSqlType', s.sqlType], ['selTone', s.toneIdx], ['selDcs', s.dcsIdx]]) {
    if (document.activeElement !== $(id) && v != null) $(id).value = String(v);
  }
}

// ---------------- sliders & toggles ----------------
// bind(rangeId, outId, getter, setter, fmt): keeps a slider in sync with state
// without fighting the user while they drag.
const bindings = [];
function bind(rangeId, outId, get, set, fmt = v => v) {
  const r = $(rangeId), o = outId ? $(outId) : null;
  let dragging = false, last = 0;
  r.addEventListener('pointerdown', () => { dragging = true; });
  window.addEventListener('pointerup', () => { dragging = false; });
  r.addEventListener('input', () => {
    const v = +r.value; if (o) o.textContent = fmt(v);
    const now = performance.now();
    if (now - last > 40) { last = now; set(v); }
  });
  r.addEventListener('change', () => set(+r.value));
  r.addEventListener('wheel', e => {
    e.preventDefault();
    const step = +r.step || 1;
    r.value = String(+r.value + (e.deltaY < 0 ? step : -step));
    r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
  }, { passive: false });
  bindings.push(() => {
    const v = get();
    if (v == null) return;
    if (!dragging && +r.value !== v) r.value = String(v);
    if (o && !dragging) o.textContent = fmt(v);
  });
}
function toggle(id, get, set) {
  const b = $(id);
  b.onclick = () => set(!get());
  bindings.push(() => b.setAttribute('aria-pressed', String(!!get())));
}
function segmented(id, options, get, set) {
  const box = $(id);
  box.innerHTML = '';
  options.forEach(([value, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.value = value;
    b.onclick = () => set(value);
    box.append(b);
  });
  bindings.push(() => { for (const b of box.children) b.setAttribute('aria-pressed', String(+b.dataset.value === get())); });
}

const S = () => radio.state;
const pct255 = v => `${Math.round(v / 2.55)}%`;
bind('rAf', 'oAf', () => S().af, v => radio.setAf(v), pct255);
bind('rRf', 'oRf', () => S().rf, v => radio.setRf(v), pct255);
bind('rSql', 'oSql', () => S().sql, v => radio.setSql(v));
bind('rVol', 'oVol', () => Math.round(audio.state.volume * 100), v => audio.setVolume(v / 100), v => `${v}%`);
toggle('tMute', () => audio.state.muted, m => audio.setMuted(m));

bind('rWidth', 'oWidth', () => S().width || defaultWidthCode(), v => radio.setWidth(v), v => widthLabel(v));
bind('rShift', 'oShift', () => S().shift, v => radio.setShift(v), v => `${v > 0 ? '+' : ''}${v}`);
$('btnShift0').onclick = () => radio.setShift(0);
bind('rNotch', 'oNotch', () => S().notchHz, v => radio.setNotchHz(v), v => `${v} Hz`);
toggle('tNotch', () => S().notch, v => radio.setNotch(v));
bind('rContour', 'oContour', () => S().contourHz, v => radio.setContourHz(v), v => `${v} Hz`);
toggle('tContour', () => S().contour, v => radio.setContour(v));
bind('rNr', 'oNr', () => S().nr, v => radio.setNr(v), v => v ? String(v) : 'off');
bind('rNb', 'oNb', () => S().nb, v => radio.setNb(v), v => v ? String(v) : 'off');
toggle('tDnf', () => S().dnf, v => radio.setDnf(v));
toggle('tNarrow', () => S().narrow, v => radio.setNarrow(v));
toggle('tAtt', () => S().att, v => radio.setAtt(v));
segmented('segAgc', [[1, 'FAST'], [2, 'MID'], [3, 'SLOW'], [4, 'AUTO'], [0, 'OFF']],
  () => Math.min(S().agc, 4), v => radio.setAgc(v));
let preBandType = -1;
function refreshPreampSeg() {
  const bt = preampBandType(radio.activeFreq);
  if (bt === preBandType) return;
  preBandType = bt;
  // HF/50 MHz: IPO / AMP1 / AMP2. 144/430 MHz have a single preamp, on or off.
  segmented('segPre', bt === 0 ? PREAMP_NAMES_HF.map((n, i) => [i, n]) : [[1, 'ON'], [0, 'OFF']],
    () => S().preamp, v => radio.setPreamp(v));
}

bind('rPower', 'oPower', () => S().power, v => radio.setPower(v), v => `${v} W`);
bind('rMic', 'oMic', () => S().mic, v => radio.setMic(v));
bind('rAmc', 'oAmc', () => S().amc, v => radio.setAmc(v));
bind('rProc', 'oProc', () => S().procLevel, v => radio.setProcLevel(v));
toggle('tProc', () => S().proc, v => radio.setProc(v));
toggle('tVox', () => S().vox, v => radio.setVox(v));
bind('rTxLvl', 'oTxLvl', () => Math.round(audio.state.txLevel * 100), v => audio.setTxLevel(v / 100), v => `${v}%`);

function currentWidthTable() { return widthTable(radio.activeMode); }
function defaultWidthCode() { return /^(LSB|USB)$/.test(radio.activeMode) ? 17 : 10; }
function widthLabel(code) {
  const t = currentWidthTable();
  const hz = t?.[code];
  return hz ? (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 2 : 1)}k` : `${hz}`) : 'fixed';
}

// ---------------- PC mic ----------------
let pcMic = false;
$('tPcMic').onclick = async () => {
  if (pcMic) { audio.stopTxPath(); pcMic = false; update(); return; }
  try {
    if (!audio.state.inputs.length) await audio.refreshDevices({ askPermission: true });
    if (!audio.state.radioOut) { banner('Choose the radio\'s audio output (USB Audio CODEC) in Settings first.', { error: true }); return; }
    await audio.startTxPath();
    pcMic = true;
    modSourceGroup = null; checkModSource();
  } catch (e) { banner(`PC mic: ${e.message}`, { error: true }); }
  update();
};

// The PC mic only goes out on the air if the radio takes its transmit audio
// from USB for the mode in use (MOD SOURCE USB, or AUTO when keyed over CAT).
// Checked when PC MIC goes on and whenever the mode group changes.
let modSourceGroup = null;
async function checkModSource() {
  if (!pcMic || !radio.state.connected) return;
  const s = radio.state, group = modSourceMenu(s.split || s.active === 1 ? s.modeB : s.modeA)?.group ?? null;
  if (group === modSourceGroup) return; // only ask the radio when the mode group changes
  modSourceGroup = group;
  const r = group && await radio.readModSource();
  if (!r) return;
  if (r.source === 'MIC' || r.source === 'Bluetooth') {
    banner(`The radio's MOD SOURCE for ${r.group} is ${r.source}, so it transmits its ${r.source === 'MIC' ? 'own microphone' : 'Bluetooth audio'}, not the PC mic. On the radio, set RADIO SETTING → MODE ${r.group} → MOD SOURCE to USB (or AUTO).`, { error: true });
  }
}

// ---------------- PTT (all the ways it can end) ----------------
const ptt = $('btnPtt');
async function keyUp(on) {
  if (on === radio.state.tx) return;
  if (on && !radio.state.connected) return;
  if (on && pcMic) audio.setTxActive(true);
  if (!on) audio.setTxActive(false);
  if (audio.state.demo) audio.setDemoMuted(on);
  await radio.setPtt(on);
}
ptt.addEventListener('pointerdown', e => {
  e.preventDefault();
  ptt.setPointerCapture(e.pointerId);
  if (settings.latchPtt) keyUp(!radio.state.tx); else keyUp(true);
});
const release = () => { if (!settings.latchPtt) keyUp(false); };
ptt.addEventListener('pointerup', release);
ptt.addEventListener('pointercancel', () => keyUp(false));
ptt.addEventListener('lostpointercapture', release);
window.addEventListener('blur', () => { if (!settings.latchPtt) keyUp(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) keyUp(false); });
window.addEventListener('pagehide', () => radio.panicUnkey());
window.addEventListener('beforeunload', () => radio.panicUnkey());

let spaceDown = false;
const typing = () => /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range';
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && radio.state.tx) { keyUp(false); return; }
  if (!settings.spacePtt || e.code !== 'Space' || typing() || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (e.repeat || spaceDown) return;
  spaceDown = true; keyUp(true);
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && spaceDown) { spaceDown = false; keyUp(false); e.preventDefault(); }
});
radio.addEventListener('change', () => { if (pcMic) checkModSource(); });
radio.addEventListener('change', () => {
  // If the radio stops transmitting on its own (timeout, disconnect), close the mic gate too.
  if (!radio.state.tx && audio.state.txActive) audio.setTxActive(false);});

$('btnTune').onclick = () => radio.tune();
toggle('tAutoTune', () => S().autoTune, on => { settings.autoTune = on; saveSettings(); radio.setAutoTune(on); });
$('selAutoTune').value = String(settings.autoTuneDelay);
$('selAutoTune').onchange = e => { settings.autoTuneDelay = radio.state.autoTuneDelayS = +e.target.value; saveSettings(); };

// ---------------- settings dialog ----------------
function fillSelect(sel, list, value) {
  sel.innerHTML = '';
  for (const d of list) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; sel.append(o); }
  if (!list.length) { const o = document.createElement('option'); o.textContent = 'Click "Refresh device list"'; o.value = ''; sel.append(o); }
  sel.value = value;
}
function fillAudioSelects() {
  const a = audio.state;
  // The radio lists leave out Chrome's "Default" / "Communications" entries: they
  // follow Windows' current default, which may not be the radio tomorrow.
  const real = list => list.filter(d => !isVirtualDevice(d.id));
  fillSelect($('setRadioIn'), real(a.inputs), a.radioIn);
  fillSelect($('setRadioOut'), real(a.outputs), a.radioOut);
  fillSelect($('setSpeakers'), a.outputs, a.speakers);
  fillSelect($('setMic'), a.inputs, a.mic);
}
$('btnSettings').onclick = () => {
  $('setTheme').value = settings.theme;
  $('setBaud').value = String(settings.baud);
  $('setTot').value = String(settings.tot);
  $('setLicense').value = settings.license;
  $('setSpacePtt').checked = settings.spacePtt;
  $('setLatchPtt').checked = settings.latchPtt;
  fillAudioSelects();
  $('dlgSettings').showModal();
};
$('btnListDevices').onclick = async () => { await audio.refreshDevices({ askPermission: true }); fillAudioSelects(); };
for (const t of THEMES) $('setTheme').append(new Option(t.name, t.id));
$('setTheme').onchange = e => {
  settings.theme = applyTheme(e.target.value);
  scope.clear(); // the waterfall history was drawn in the old colours
  saveSettings(); update();
};
$('setBaud').onchange = e => { settings.baud = +e.target.value; saveSettings(); };
$('setTot').onchange = e => { settings.tot = +e.target.value; radio.state.txTimeoutS = settings.tot; saveSettings(); };
$('setLicense').onchange = e => { settings.license = radio.state.license = e.target.value; saveSettings(); update(); };
$('setSpacePtt').onchange = e => { settings.spacePtt = e.target.checked; saveSettings(); update(); };
$('setLatchPtt').onchange = e => { settings.latchPtt = e.target.checked; saveSettings(); update(); };
for (const [id, key] of [['setRadioIn', 'radioIn'], ['setRadioOut', 'radioOut'], ['setSpeakers', 'speakers'], ['setMic', 'mic']]) {
  $(id).onchange = e => audio.setDevice(key, e.target.value).catch(err => banner(err.message, { error: true }));
}

// ---------------- diagnostics ----------------
$('btnDiag').onclick = () => { renderDiag(); $('dlgDiag').showModal(); };
function renderDiag() {
  const s = radio.state;
  const st = s.stats || {};
  $('diagStats').textContent = s.connected
    ? `${s.linkLabel} · ID ${s.radioId} · ${s.head === 'optima' ? 'Optima/SPA-1' : 'Field head'} · sent ${st.sent ?? 0}, received ${st.received ?? 0}, timeouts ${st.timeouts ?? 0}, rejected (?;) ${st.rejected ?? 0}`
    : 'Not connected.';
  $('diagLog').textContent = radio.traffic.join('\n');
  $('diagLog').scrollTop = 1e9;
}
$('btnCopyLog').onclick = () => navigator.clipboard?.writeText(`${$('diagStats').textContent}\n\n${radio.traffic.join('\n')}`);

// ---------------- scope ----------------
const model = () => ({
  analyser: audio.state.running ? audio.analyser : null,
  sampleRate: audio.sampleRate,
  dial: radio.activeFreq, mode: radio.activeMode, pitch: S().keyPitch,
  width: S().width, shift: S().shift, notch: S().notch, notchHz: S().notchHz,
  contour: S().contour, contourHz: S().contourHz, dnf: S().dnf, nr: S().nr,
});
const scope = new SpectrumWaterfall($('spectrum'), $('waterfall'), model, {
  onTune: hz => radio.state.connected && radio.setFreq(radio.state.active, hz),
});
const osc = new Oscilloscope($('afScope'), model);
const passband = new PassbandView($('passband'), model, {
  onShift: hz => radio.setShift(hz),
  onWidthStep: dir => {
    const t = currentWidthTable(); if (!t) return;
    radio.setWidth(Math.max(1, Math.min(t.length - 1, (S().width || defaultWidthCode()) + dir)));
  },
});
if (![...$('selSpan').options].some(o => +o.value === settings.span)) settings.span = 8000; // span from an older layout
Object.assign(scope, { span: settings.span, floor: settings.floor, range: settings.range, speed: settings.speed });
Object.assign(passband, { floor: settings.floor, range: settings.range }); // the RX DSP graphic shares Floor / Range
$('selSpan').value = String(settings.span);
$('rngFloor').value = String(settings.floor);
$('rngRange').value = String(settings.range);
$('selSpeed').value = String(settings.speed);
$('selSpan').onchange = e => { scope.span = settings.span = +e.target.value; scope.clear(); saveSettings(); };
$('rngFloor').oninput = e => { scope.floor = passband.floor = settings.floor = +e.target.value; saveSettings(); };
$('rngRange').oninput = e => { scope.range = passband.range = settings.range = +e.target.value; saveSettings(); };
$('selSpeed').onchange = e => { scope.speed = settings.speed = +e.target.value; saveSettings(); };

const meters = [...document.querySelectorAll('canvas.meter')].map(c => new ArcMeter(c));

// ---------------- state -> DOM ----------------
function update() {
  const s = radio.state;
  const live = s.connected;

  // top bar
  const cat = $('pillCat');
  cat.className = `pill ${live ? (s.warning ? 'warn' : 'ok') : s.connecting ? 'warn' : ''}`;
  cat.querySelector('span').textContent = live ? (s.demo ? 'demo' : 'connected') : s.connecting ? 'connecting…' : 'offline';
  const au = $('pillAudio');
  au.className = `pill ${audio.state.running ? 'ok' : audio.state.error ? 'err' : ''}`;
  au.querySelector('span').textContent = audio.state.running ? (audio.state.demo ? 'demo' : 'on') : 'off';
  $('pillHead').hidden = !live;
  $('pillHead').textContent = `${s.head === 'optima' ? 'Optima' : s.battery ? 'Field head, battery' : 'Field head'} · ${s.maxWatts} W max`;
  $('btnConnect').textContent = live && !s.demo ? 'Disconnect' : 'Connect radio';
  $('btnConnect').classList.toggle('btn-primary', !(live && !s.demo));
  $('btnDemo').textContent = s.demo ? 'Exit demo' : 'Demo';
  $('btnDemo').disabled = live && !s.demo;
  $('btnAudio').textContent = audio.state.running ? 'Stop audio' : 'Start audio';
  $('scopeHint').hidden = audio.state.running;

  // VFOs: like the radio's screen, single receive shows only the selected VFO
  // (split still needs both, since B is the transmit frequency).
  const both = s.split || (settings.vfoView === 'auto' ? s.dual : settings.vfoView === '2');
  $('vfoA').parentElement.classList.toggle('single', !both);
  for (const [el, v] of [[$('vfoA'), 0], [$('vfoB'), 1]]) {
    el.hidden = !both && v !== s.active;
    const f = v ? s.freqB : s.freqA, m = v ? s.modeB : s.modeA;
    renderFreq(el.querySelector('.freq'), f);
    el.classList.toggle('active', s.active === v);
    el.querySelector('.mode-tag').textContent = m;
    const band = bandForFreq(f);
    el.querySelector('.vfo-info').textContent = band ? `${band.label}${/^\d+$/.test(band.label) ? ' m' : ''}` : 'GEN';
    const txOnThis = s.split ? v === 1 : v === s.active;
    el.querySelector('.tag-rx').classList.toggle('on', v === s.active || (s.split && v === 0));
    const tx = el.querySelector('.tag-tx');
    tx.classList.toggle('on', txOnThis);
    tx.classList.toggle('live', txOnThis && s.tx);
  }
  $('btnSplit').setAttribute('aria-pressed', String(s.split));
  $('dial').setAttribute('aria-valuenow', String(radio.activeFreq));
  $('dial').setAttribute('aria-valuetext', `VFO ${s.active ? 'B' : 'A'} ${formatFreqShort(radio.activeFreq)}`);

  // band/mode buttons
  const curBand = bandForFreq(radio.activeFreq)?.id;
  for (const b of bandBox.children) {
    b.classList.toggle('active', b.dataset.band === curBand);
    const voice = bandDefault(BANDS.find(x => x.id === b.dataset.band), s.license).voice;
    b.classList.toggle('no-voice', !voice);
    b.title = voice ? '' : `No SSB voice privileges here for ${LICENSE_LABEL[s.license] || 'this license'}; tunes to the band's general default`;
  }
  for (const b of modeBox.children) b.classList.toggle('active', b.dataset.mode === radio.activeMode);
  refreshTone();

  // width slider range follows the mode's table
  const t = currentWidthTable();
  const rw = $('rWidth');
  rw.disabled = !t;
  rw.max = String(t ? t.length - 1 : 1);
  const pb = t?.[s.width];
  $('bwReadout').textContent = pb ? `BW ${pb} Hz${s.shift ? ` · shift ${s.shift > 0 ? '+' : ''}${s.shift}` : ''}` : radio.activeMode;
  $('dspTarget').textContent = `· ${s.active ? 'SUB (B)' : 'MAIN (A)'}`;
  refreshPreampSeg();

  // power slider range follows the head
  const rp = $('rPower');
  rp.min = String(s.minWatts); rp.max = String(s.maxWatts); rp.step = s.head === 'optima' ? '1' : '0.5';

  // TX panel
  ptt.disabled = !live;
  ptt.setAttribute('aria-pressed', String(s.tx));
  $('pttSub').textContent = !live ? 'not connected' : s.tx ? (settings.latchPtt ? 'ON AIR · click to stop' : 'ON AIR') : settings.latchPtt ? 'click to transmit' : settings.spacePtt ? 'hold (or hold space)' : 'hold to talk';
  $('btnTune').classList.toggle('active', s.tuning);
  $('btnTune').textContent = s.tuning ? 'TUNING…' : 'TUNE';
  if (pcMic && !audio.txReady) pcMic = false; // the TX path was torn down (e.g. the output device failed)
  $('tPcMic').setAttribute('aria-pressed', String(pcMic));

  for (const f of bindings) f();
  if (s.warning && $('banner').hidden) banner(s.warning);
}
radio.addEventListener('change', update);
audio.addEventListener('change', update);
// Audio problems (a device that won't open, an output that can't be selected) go in the banner.
let shownAudioError = null;
audio.addEventListener('change', () => {
  const err = audio.state.error;
  if (err && err !== shownAudioError) banner(err, { error: true });
  shownAudioError = err;
});

// ---------------- render loop ----------------
function frame(now) {
  const s = radio.state;
  const m = radio.meters();
  const txing = s.tx || s.tuning;
  meters[0].set(s.sRaw, { active: s.connected && !txing });
  meters[1].set(m.poWatts, { max: s.maxWatts, active: s.connected && txing });
  meters[2].set(m.swr, { active: s.connected && txing });
  meters[3].set(m.alc, { active: s.connected && txing });
  for (const mt of meters) mt.draw(now);
  scope.draw();
  osc.draw();
  passband.draw();
  $('micBar').style.width = `${Math.min(100, audio.micLevel() * 140)}%`;
  const autoWait = radio.autoTuneWait();
  $('txTimer').textContent = s.tx && s.txStartedAt ? `TX ${Math.floor((Date.now() - s.txStartedAt) / 1000)} s / ${s.txTimeoutS} s`
    : autoWait != null ? `auto tune in ${Math.ceil(autoWait / 1000)} s` : '';
  requestAnimationFrame(frame);
}

update();
requestAnimationFrame(frame);
