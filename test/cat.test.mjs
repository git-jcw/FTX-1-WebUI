// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmd, parse, calibrate, splitReplies, replyKey, widthTable, bandForFreq, bandDefault, BANDS,
  MENU, TUNER, tuneCommands, powerLimits, SQL_TYPE, CTCSS_TONES, DCS_CODES, modSourceMenu } from '../js/cat/ftx1.js';
import { MockRadioTransport } from '../js/cat/mock-radio.js';
import { CatLink } from '../js/cat/cat-link.js';
import { RadioService } from '../js/radio.js';
import { SpectrumWaterfall, audibleDb } from '../js/ui/scope.js';
import { TuningDial, STEPS_PER_REV } from '../js/ui/dial.js';

test('command builders match the FTX-1 formats', () => {
  assert.equal(cmd.freq(0, 14250000), 'FA014250000;');
  assert.equal(cmd.freq(1, 7074000), 'FB007074000;');
  assert.equal(cmd.mode(0, 'USB'), 'MD02;');
  assert.equal(cmd.mode(1, 'DATA-U'), 'MD1C;');
  assert.equal(cmd.mode(0, 'CW-U'), 'MD03;');
  assert.equal(cmd.afGain(0, 128), 'AG0128;');
  assert.equal(cmd.width(0, 17), 'SH0017;');
  assert.equal(cmd.ifShift(0, 200), 'IS00+0200;');
  assert.equal(cmd.ifShift(0, -440), 'IS00-0440;');
  assert.equal(cmd.ifShift(0, 0), 'IS00+0000;');
  assert.equal(cmd.ifShift(1, 1500), 'IS10+1200;');
  assert.equal(cmd.nbLevel(0, 5), 'NL0005;');
  assert.equal(cmd.nrLevel(0, 7), 'RL007;');
  assert.equal(cmd.notch(0, true), 'BP00001;');
  assert.equal(cmd.notchFreq(0, 1500), 'BP01150;');
  assert.equal(cmd.contour(0, true), 'CO000001;');
  assert.equal(cmd.contourFreq(0, 800), 'CO010800;');
  assert.equal(cmd.power('optima', 50), 'PC2050;');
  assert.equal(cmd.power('optima', 150), 'PC2100;');
  assert.equal(cmd.power('optima', 1), 'PC2005;');
  assert.equal(cmd.power('field', 5), 'PC1005;');
  assert.equal(cmd.power('field', 2.5), 'PC12.5;');
  assert.equal(cmd.ptt(true), 'TX1;');
  assert.equal(cmd.ptt(false), 'TX0;');
  assert.equal(cmd.keyPitch(600), 'KP30;');
  assert.equal(cmd.preamp(0, 2), 'PA02;');
  assert.equal(cmd.readMenu(MENU.HF_ANT), 'EX030704;');
});

test('tune commands follow the tuner type', () => {
  assert.equal(tuneCommands(TUNER.INT).start[0], 'AC003;');
  assert.equal(tuneCommands(TUNER.EXT).start[0], 'AC103;');
  assert.deepEqual(tuneCommands(TUNER.ATAS), { start: ['AC123;'], stop: ['AC120;'] });
  assert.ok(tuneCommands(null).start.includes('AC123;'), 'unknown type tries every form');
  assert.equal(parse.menu('EX0307012;'), 2);
  assert.equal(parse.menu('?;'), null);
  assert.equal(replyKey('EX0307012;'), 'EX030701');
});

test('reply parsers', () => {
  assert.equal(parse.id('ID0840;'), '0840');
  assert.equal(parse.freq('FA014250000;'), 14250000);
  assert.equal(parse.freq('FB000475000;'), 475000);
  assert.equal(parse.mode('MD0C;'), 'DATA-U');
  assert.equal(parse.vfoLevel('AG0128;', 'AG'), 128);
  assert.equal(parse.width('SH0017;'), 17);
  assert.equal(parse.ifShift('IS00-0440;'), -440);
  assert.equal(parse.ifShift('IS00+0200;'), 200, 'P2 is always 0, so it says nothing about whether shift is in use');
  assert.equal(parse.ifShift('IS00+0000;'), 0);
  assert.equal(parse.smeter('SM0130;'), 130);
  assert.deepEqual(parse.meter('RM5123000;'), { meter: 5, raw: 123 });
  assert.deepEqual(parse.power('PC2050;'), { head: 'optima', watts: 50 });
  assert.deepEqual(parse.power('PC12.5;'), { head: 'field', watts: 2.5 });
  assert.equal(parse.ptt('TX0;'), false);
  assert.equal(parse.ptt('TX2;'), true);
  assert.deepEqual(parse.sub('BP01150;', 'BP'), { fn: '1', value: 150 });
  assert.equal(parse.keyPitch('KP30;'), 600);
  assert.equal(parse.freq('?;'), null);
  assert.equal(parse.mode('garbage'), null);
});

test('stream splitting and reply keys', () => {
  const { replies, rest } = splitReplies('FA014250000;SM0100;MD0');
  assert.deepEqual(replies, ['FA014250000;', 'SM0100;']);
  assert.equal(rest, 'MD0');
  assert.equal(replyKey('SM0100;'), 'SM0');
  assert.equal(replyKey('BP01150;'), 'BP01');
  assert.equal(replyKey('FA014250000;'), 'FA');
});

test('meter calibration', () => {
  assert.equal(calibrate.sLabel(130), 'S9');
  assert.equal(calibrate.sLabel(0), 'S0');
  assert.equal(calibrate.sLabel(172), 'S9+20');
  assert.ok(Math.abs(calibrate.swr(89) - 2.0) < 1e-9);
  assert.ok(Math.abs(calibrate.poWatts(200) - 92) < 1e-9);
  assert.equal(widthTable('USB')[17], 2700);
  assert.equal(widthTable('CW-U')[10], 500);
  assert.equal(widthTable('FM'), null);
  assert.equal(bandForFreq(14074000).id, '20');
});

test('band defaults follow the license class', () => {
  const at = (id, license) => bandDefault(BANDS.find(b => b.id === id), license);
  assert.deepEqual(at('20', 'general'), { freq: 14225000, mode: 'USB', voice: true });
  assert.deepEqual(at('20', 'extra'), { freq: 14150000, mode: 'USB', voice: true });
  assert.deepEqual(at('80', 'general'), { freq: 3803000, mode: 'LSB', voice: true }, 'LSB stays 3 kHz above the edge');
  assert.deepEqual(at('40', 'extra'), { freq: 7128000, mode: 'LSB', voice: true });
  assert.deepEqual(at('60', 'general'), { freq: 5332000, mode: 'USB', voice: true });
  assert.deepEqual(at('10', 'technician'), { freq: 28300000, mode: 'USB', voice: true });
  assert.deepEqual(at('2', 'technician'), { freq: 144100000, mode: 'USB', voice: true });
  assert.deepEqual(at('20', 'technician'), { freq: 14250000, mode: 'USB', voice: false });
  assert.deepEqual(at('30', 'extra'), { freq: 10136000, mode: 'DATA-U', voice: false });
  for (const b of BANDS) for (const l of ['technician', 'general', 'extra']) {
    const d = bandDefault(b, l);
    assert.ok(d.freq >= b.start && d.freq <= b.end, `${b.id} ${l} in band`);
  }
});

test('CatLink: reads, rejected sets, and coalescing against the mock radio', async () => {
  const t = new MockRadioTransport({ latencyMs: 1 });
  const link = new CatLink(t, { readTimeoutMs: 100, setGapMs: 5 });
  assert.equal(await link.read('ID;'), 'ID0840;');
  assert.equal(await link.set('FA007100000;'), true);
  assert.equal(await link.read('FA;'), 'FA007100000;');
  assert.equal(await link.set('NB01;'), false, 'FTX-1 rejects NB on/off');
  // Coalescing: three quick frequency sets should send only the latest one(s)
  const before = t.log.filter(c => c.startsWith('FA0')).length;
  link.read('SM0;');
  await Promise.all([
    link.set('FA014000000;', { coalesce: 'freqA' }),
    link.set('FA014001000;', { coalesce: 'freqA' }),
    link.set('FA014002000;', { coalesce: 'freqA' }),
  ]);
  const sent = t.log.filter(c => c.startsWith('FA0')).slice(before);
  assert.ok(sent.length <= 2, `coalesced to ${sent.length}`);
  assert.equal(await link.read('FA;'), 'FA014002000;');
  link.close();
});

test('RadioService end-to-end with the mock radio', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  await radio.connect(t, { demo: true });
  const s = radio.state;
  assert.equal(s.connected, true);
  assert.equal(s.radioId, '0840');
  assert.equal(s.head, 'optima');
  assert.equal(s.maxWatts, 100);
  assert.equal(s.freqA, 14250000);

  await radio.setFreq(0, 7150000);
  await radio.setMode(0, 'LSB');
  await radio.setPower(75);
  await radio.setWidth(12);
  await radio.setShift(-300);
  await radio.setNr(5);
  assert.equal(t.s.FA, 7150000);
  assert.equal(t.s.MD[0], '1');
  assert.deepEqual(t.s.PC, ['2', 75]);
  assert.equal(t.s.SH[0], 12);
  assert.equal(t.s.IS[0], -300);
  assert.equal(t.s.RL[0], 5);

  await radio.setPtt(true);
  assert.equal(t.s.TX, 1);
  await radio.setPtt(false);
  assert.equal(t.s.TX, 0);

  radio.state.license = 'extra';
  radio.gotoBand('20');
  await radio.setAf(100); // flush the queue
  assert.equal(t.s.FA, 14150000);
  assert.equal(t.s.MD[0], '2');

  await radio.disconnect();
  assert.equal(radio.state.connected, false);
  assert.equal(radio.state.demo, false, 'leaving demo clears the demo flag');
  assert.ok(!t.log.includes('ST1;'), 'never uses ST for split');
});

test('SWR is reported while tuning', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  await radio.connect(t, { demo: true });
  await radio.tune();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(radio.state.tuning, true);
  assert.ok(radio.meters().swr > 1, `swr ${radio.meters().swr}`);
  await radio.tune();
  await radio.disconnect();
});

test('the waterfall is centred on the dial frequency', () => {
  const canvas = { addEventListener() {} };
  const sw = new SpectrumWaterfall(canvas, canvas, () => ({}));
  sw.span = 8000;
  const at = (x, mode, pitch = 600) => sw._audioAtX(x, { mode, pitch });
  assert.equal(at(0.5, 'USB'), 0, 'the carrier is at the centre');
  assert.equal(at(0.75, 'USB'), 2000);
  assert.equal(at(0.25, 'USB'), -2000, 'below the carrier there is nothing to hear');
  assert.equal(at(0.25, 'LSB'), 2000, 'LSB audio lies below the dial');
  assert.equal(at(0.5, 'CW-U'), 600, 'a CW signal on the dial frequency is heard at the pitch');
  assert.equal(at(0.25, 'AM'), 2000);
  assert.equal(at(0.75, 'AM'), 2000, 'AM is mirrored about the dial');
  for (const mode of ['USB', 'LSB', 'CW-U', 'CW-L', 'DATA-U']) {
    assert.ok(Math.abs(sw._xAtAudio(at(0.7, mode), { mode, pitch: 600 }) - 0.7) < 1e-9, `${mode} round trip`);
  }
  const m = { mode: 'USB', dial: 14250000, pitch: 600 };
  assert.equal(sw._tuneTargetAtX(0.75, m), 14252000);
  assert.equal(sw._tuneTargetAtX(0.25, { ...m, mode: 'FM' }), 14248000, 'AM/FM tune to the clicked frequency');
  assert.equal(sw._tuneTargetAtX(0.5, { ...m, mode: 'DATA-U' }), 14248500, 'DATA puts the clicked signal at 1500 Hz');
});

test('a moment of digital silence does not break the RX DSP spectrum for good', () => {
  // the same running average the passband graphic keeps per pixel
  const run = (readings, clamp) => readings.reduce((avg, v) => avg + ((clamp ? audibleDb(v) : v) - avg) * 0.3, -200);
  const silenceThenAudio = [-90, -Infinity, -Infinity, -85, -80, -80, -80, -80, -80, -80, -80, -80];
  assert.ok(Number.isNaN(run(silenceThenAudio, false)), 'unclamped: the average becomes NaN and stays there');
  const avg = run(silenceThenAudio, true);
  assert.ok(Number.isFinite(avg) && avg > -90, `clamped: it recovers once audio returns (${avg.toFixed(1)} dB)`);
  assert.equal(audibleDb(NaN), -200);
});

test('the tuning dial pays out steps as it turns', () => {
  const el = { addEventListener() {}, querySelector: () => ({ style: {} }) };
  let steps = 0;
  const dial = new TuningDial(el, { onStep: n => { steps += n; } });
  dial.turn(2); dial.turn(-2);
  assert.equal(steps, 0, 'a wobble smaller than one step does nothing');
  for (let i = 0; i < 360; i++) dial.turn(1);
  assert.equal(steps, STEPS_PER_REV, 'one turn clockwise');
  for (let i = 0; i < 720; i++) dial.turn(-0.5);
  assert.equal(steps, 0, 'and back again');
  dial.nudge(-3);
  assert.equal(steps, -3);
});

test('single / dual receive follows the radio', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  t.s.FR = 1;
  await radio.connect(t, { demo: true });
  assert.equal(radio.state.dual, false);
  t.s.FR = 0;
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(radio.state.dual, true);
  await radio.disconnect();
});

test('the S meter follows the selected receiver', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  await radio.connect(t, { demo: true });
  await radio.selectVfo(1);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(radio.state.sRaw > 0, `SUB S meter ${radio.state.sRaw}`);
  assert.ok(t.log.includes('RM2;'), 'reads SUB with RM2');
  assert.ok(!t.log.some(c => c.startsWith('SM')), 'never polls SM');
  await radio.disconnect();
});

// Starts and stops a tune against a mock with the given tuner; returns the AC sets sent.
async function tuneCycle(opts) {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1, ...opts });
  await radio.connect(t, { demo: true });
  const started = await radio.tune();
  const tuning = radio.state.tuning;
  const radioTuning = Date.now() < t._tuneUntil;
  if (started) await radio.tune();
  const sent = t.log.filter(c => /^AC\d/.test(c));
  const result = { started, tuning, radioTuning, sent, stopped: t._tuneUntil === 0, warning: radio.state.warning };
  await radio.disconnect();
  return result;
}

test('TUNE works with the internal tuner, an external tuner and an ATAS', async () => {
  const int = await tuneCycle({ tuner: TUNER.INT });
  assert.deepEqual([int.started, int.tuning, int.radioTuning, int.stopped], [true, true, true, true]);
  assert.deepEqual(int.sent, ['AC003;', 'AC000;']);

  const ext = await tuneCycle({ tuner: TUNER.EXT });
  assert.deepEqual([ext.started, ext.tuning, ext.radioTuning, ext.stopped], [true, true, true, true]);
  assert.deepEqual(ext.sent, ['AC103;', 'AC000;']);

  const atas = await tuneCycle({ tuner: TUNER.ATAS });
  assert.deepEqual([atas.started, atas.radioTuning, atas.stopped], [true, true, true]);
  assert.deepEqual(atas.sent, ['AC123;', 'AC120;']);
});

test('TUNING clears when the radio finishes, though AC; still says the tuner is on', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1, tuneMs: 600 });
  await radio.connect(t, { demo: true });
  await radio.tune();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(radio.state.tuning, true, 'still tuning while the carrier is up');
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(await radio.link.read('AC;'), 'AC001;', 'the radio reports the tuner on');
  assert.equal(radio.state.tuning, false);
  assert.ok(!t.log.includes('AC000;'), 'and the tuner was not switched off');
  await radio.disconnect();
});

test('FM tone squelch commands', async () => {
  assert.equal(cmd.sqlType(0, SQL_TYPE.TSQ), 'CT02;');
  assert.equal(cmd.ctcssTone(0, CTCSS_TONES.indexOf(100)), 'CN00012;');
  assert.equal(cmd.dcsCode(1, DCS_CODES.indexOf('754')), 'CN11103;');
  assert.equal(parse.sqlType('CT03;'), SQL_TYPE.DCS);
  assert.deepEqual(parse.toneCode('CN00012;'), { dcs: false, index: 12 });
  assert.deepEqual(parse.toneCode('CN01103;'), { dcs: true, index: 103 });
  assert.equal(replyKey('CN01103;'), 'CN01', 'CTCSS and DCS reads do not cross');
  assert.equal(CTCSS_TONES.length, 50);
  assert.equal(DCS_CODES.length, 104);

  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  t.s.CT[0] = 1; t.s.CN[0] = [18, 5];
  await radio.connect(t, { demo: true });
  assert.deepEqual([radio.state.sqlType, radio.state.toneIdx, radio.state.dcsIdx], [1, 18, 5], 'read from the radio');
  await radio.setSqlType(SQL_TYPE.TSQ);
  await radio.setToneIdx(CTCSS_TONES.indexOf(146.2));
  await radio.setDcsIdx(0);
  assert.deepEqual([t.s.CT[0], t.s.CN[0]], [2, [23, 0]]);
  await radio.disconnect();
});

test('power limits follow the head, band, mode and power source', async () => {
  assert.deepEqual(powerLimits({ head: 'optima', hz: 14250000, mode: 'USB' }), { min: 5, max: 100 });
  assert.deepEqual(powerLimits({ head: 'optima', hz: 146520000, mode: 'FM' }), { min: 5, max: 50 });
  assert.deepEqual(powerLimits({ head: 'optima', hz: 7200000, mode: 'AM' }), { min: 5, max: 25 });
  assert.deepEqual(powerLimits({ head: 'field', hz: 14250000, mode: 'USB' }), { min: 0.5, max: 10 });
  assert.deepEqual(powerLimits({ head: 'field', hz: 14250000, mode: 'USB', battery: true }), { min: 0.5, max: 6 });

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const optima = new RadioService();
  await optima.connect(new MockRadioTransport({ latencyMs: 1 }), { demo: true });
  await optima.setPower(100);
  assert.equal(optima.state.maxWatts, 100);
  await optima.setFreq(0, 146520000);
  await optima.setMode(0, 'FM');
  await wait(2500); // until the radio's own setting for the new band has been polled
  assert.equal(optima.state.maxWatts, 50, 'the slider tops out at 50 W on 2 m');
  await optima.setPower(100);
  assert.equal(optima.transport.s.PC[1], 50, 'and 100 W is not sent');
  await optima.disconnect();

  const field = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1, head: 'field', battery: true });
  await field.connect(t, { demo: true });
  assert.deepEqual([field.state.head, field.state.maxWatts, field.state.minWatts], ['field', 10, 0.5]);
  await field.setPower(8);
  await wait(300);
  assert.deepEqual([field.state.battery, field.state.maxWatts, field.state.power], [true, 6, 5], 'a refused 8 W means battery: cap at 6 W and show the real setting');
  t.head = 'optima'; t.s.PC = ['2', 50];
  await wait(2500);
  assert.deepEqual([field.state.head, field.state.maxWatts], ['optima', 100], 'fitting the SPA-1 is noticed without reconnecting');
  await field.disconnect();
});

test('auto tune waits for the frequency to settle, and tunes each frequency once', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1, tuneMs: 200 });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const starts = () => t.log.filter(c => c === 'AC003;').length;
  radio.state.autoTuneDelayS = 0.5;
  await radio.connect(t, { demo: true });
  radio.setAutoTune(true);
  await wait(900);
  assert.equal(starts(), 0, 'no tune just for switching it on');

  await radio.setFreq(0, 14255000);
  await wait(900);
  assert.equal(starts(), 0, 'a 5 kHz move is not worth a tune');

  for (let i = 1; i <= 8; i++) { await radio.setFreq(0, 14255000 + i * 5000); await wait(200); }
  assert.equal(starts(), 0, 'nothing while the frequency is still moving');
  assert.ok(radio.autoTuneWait() > 0, 'but one is pending');
  await wait(1500);
  assert.equal(starts(), 1, 'tunes once it has settled');
  await wait(1500);
  assert.equal(starts(), 1, 'and only once');

  await radio.setFreq(0, 7150000);
  await radio.setPtt(true);
  await wait(300);
  await radio.setPtt(false);
  await wait(1200);
  assert.equal(starts(), 1, 'transmitting on the new frequency cancels the auto tune');

  await radio.setFreq(0, 146520000);
  await wait(1200);
  assert.equal(starts(), 1, 'no tuner on 2 m');

  radio.setAutoTune(false);
  await radio.setFreq(0, 21300000);
  await wait(1200);
  assert.equal(starts(), 1, 'off means off');
  await radio.disconnect();
});

test('TUNE still starts when the tuner menu cannot be read', async () => {
  const r = await tuneCycle({ tuner: null });
  assert.deepEqual([r.started, r.radioTuning, r.stopped], [true, true, true]);
  assert.equal(r.sent[0], 'AC103;');
});

test('a rejected TUNE says what the radio is set to', async () => {
  const r = await tuneCycle({ tuner: TUNER.INT, tunerFitted: false });
  assert.deepEqual([r.started, r.tuning], [false, false]);
  assert.deepEqual(r.sent, ['AC003;', 'AC103;'], 'falls back to the other start form');
  assert.match(r.warning, /tried AC003, AC103.*set to INT\./);
});

test('TX watchdog unkeys', async () => {
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  await radio.connect(t, { demo: true });
  radio.state.txTimeoutS = 0.2;
  await radio.setPtt(true);
  assert.equal(t.s.TX, 1);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(t.s.TX, 0);
  assert.match(radio.state.warning, /timeout/i);
  await radio.disconnect();
});

test('the radio audio devices are never Chrome\'s "Default" or "Communications" entries', async () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Microphone (USB Audio CODEC)' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Microphone (USB Audio CODEC)' },
    { kind: 'audioinput', deviceId: 'pcmic', label: 'Microphone (Realtek Audio)' },
    { kind: 'audioinput', deviceId: 'codec-in', label: 'Microphone (USB Audio CODEC)' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (USB Audio CODEC)' },
    { kind: 'audiooutput', deviceId: 'communications', label: 'Communications - Speakers (USB Audio CODEC)' },
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers (Realtek Audio)' },
    { kind: 'audiooutput', deviceId: 'codec-out', label: 'Speakers (USB Audio CODEC)' },
  ];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices: async () => devices } } });
  try {
    const { AudioEngine } = await import('../js/audio/audio-engine.js');
    const a = new AudioEngine();
    Object.assign(a.state, { radioIn: '', radioOut: '', speakers: '', mic: '' });
    await a.refreshDevices();
    assert.deepEqual([a.state.radioIn, a.state.radioOut], ['codec-in', 'codec-out'], 'auto-pick finds the real radio device');
    Object.assign(a.state, { radioIn: 'default', radioOut: 'communications' });
    await a.refreshDevices();
    assert.deepEqual([a.state.radioIn, a.state.radioOut], ['codec-in', 'codec-out'], 'a saved virtual entry is replaced by the real device');
    assert.deepEqual([a.state.speakers, a.state.mic], ['speakers', 'pcmic'], 'the PC speakers and mic are never the radio, even via "Default"');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});

test('MOD SOURCE can be read for the transmit mode', async () => {
  assert.deepEqual(modSourceMenu('USB'), { group: 'SSB', item: '010113' });
  assert.deepEqual(modSourceMenu('FM-N'), { group: 'FM', item: '010312' });
  assert.deepEqual(modSourceMenu('PSK'), { group: 'DATA', item: '010413' });
  assert.equal(modSourceMenu('CW-U'), null, 'CW sends no audio');
  const radio = new RadioService();
  const t = new MockRadioTransport({ latencyMs: 1 });
  t.menu['010113'] = 0; // SSB: MIC
  await radio.connect(t, { demo: true });
  assert.deepEqual(await radio.readModSource(), { group: 'SSB', source: 'MIC' });
  await radio.setMode(0, 'DATA-U');
  assert.deepEqual(await radio.readModSource(), { group: 'DATA', source: 'AUTO' });
  await radio.disconnect();
});
