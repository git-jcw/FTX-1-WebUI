// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cmd, parse, calibrate, splitReplies, replyKey, widthTable, bandForFreq, bandDefault, BANDS } from '../js/cat/ftx1.js';
import { MockRadioTransport } from '../js/cat/mock-radio.js';
import { CatLink } from '../js/cat/cat-link.js';
import { RadioService } from '../js/radio.js';

test('command builders match the FTX-1 formats', () => {
  assert.equal(cmd.freq(0, 14250000), 'FA014250000;');
  assert.equal(cmd.freq(1, 7074000), 'FB007074000;');
  assert.equal(cmd.mode(0, 'USB'), 'MD02;');
  assert.equal(cmd.mode(1, 'DATA-U'), 'MD1C;');
  assert.equal(cmd.mode(0, 'CW-U'), 'MD03;');
  assert.equal(cmd.afGain(0, 128), 'AG0128;');
  assert.equal(cmd.width(0, 17), 'SH0017;');
  assert.equal(cmd.ifShift(0, 200), 'IS01+0200;');
  assert.equal(cmd.ifShift(0, -440), 'IS01-0440;');
  assert.equal(cmd.ifShift(0, 0), 'IS00+0000;');
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
  assert.equal(cmd.tuneStart(), 'AC003;');
});

test('reply parsers', () => {
  assert.equal(parse.id('ID0840;'), '0840');
  assert.equal(parse.freq('FA014250000;'), 14250000);
  assert.equal(parse.freq('FB000475000;'), 475000);
  assert.equal(parse.mode('MD0C;'), 'DATA-U');
  assert.equal(parse.vfoLevel('AG0128;', 'AG'), 128);
  assert.equal(parse.width('SH0017;'), 17);
  assert.equal(parse.ifShift('IS01-0440;'), -440);
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
