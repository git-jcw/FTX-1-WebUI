// FTX-1 CAT command builders and reply parsers.
// Pure functions only — no I/O — so they can be unit-tested in Node.
// See docs/FTX1-CAT-NOTES.md for the protocol reference.

export const RADIO_ID = '0840';
export const DEFAULT_BAUD = 38400;

export const MODE_CODES = {
  LSB: '1', USB: '2', 'CW-U': '3', FM: '4', AM: '5', 'RTTY-L': '6', 'CW-L': '7',
  'DATA-L': '8', 'RTTY-U': '9', 'DATA-FM': 'A', 'FM-N': 'B', 'DATA-U': 'C',
  'AM-N': 'D', PSK: 'E', 'DATA-FM-N': 'F', 'C4FM-DN': 'H', 'C4FM-VW': 'I',
};
export const CODE_TO_MODE = Object.fromEntries(Object.entries(MODE_CODES).map(([k, v]) => [v, k]));

// Width tables, index = SH code (0 = radio default). Values as listed for the
// NAR WIDTH menu items in Yaesu's FTX-1 CAT manual (2508-C); Hamlib's FTX-1
// backend uses the same values.
export const SSB_WIDTHS = [null, 300, 400, 600, 850, 1100, 1200, 1500, 1650, 1800, 1950, 2100,
  2250, 2400, 2450, 2500, 2600, 2700, 2800, 2900, 3000, 3200, 3500, 4000];
export const NARROW_WIDTHS = [null, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 800,
  1200, 1400, 1700, 2000, 2400, 3000, 3200, 3500, 4000];

export const AGC_NAMES = ['OFF', 'FAST', 'MID', 'SLOW', 'AUTO', 'AUTO', 'AUTO'];
export const PREAMP_NAMES_HF = ['IPO', 'AMP1', 'AMP2'];

export const METER = { MAIN_S: 1, SUB_S: 2, COMP: 3, ALC: 4, PO: 5, SWR: 6, ID: 7, VDD: 8 };

// Squelch type (CT P2) and the tone / code tables CN indexes into.
export const SQL_TYPES = ['OFF', 'ENC', 'TSQ', 'DCS', 'PR FREQ', 'REV TONE'];
export const SQL_TYPE = { OFF: 0, ENC: 1, TSQ: 2, DCS: 3, PR_FREQ: 4, REV_TONE: 5 };
export const CTCSS_TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4,
  100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7,
  159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5,
  203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
export const DCS_CODES = ['023', '025', '026', '031', '032', '036', '043', '047', '051', '053', '054',
  '065', '071', '072', '073', '074', '114', '115', '116', '122', '125', '131', '132', '134', '143', '145',
  '152', '155', '156', '162', '165', '172', '174', '205', '212', '223', '225', '226', '243', '244', '245',
  '246', '251', '252', '255', '261', '263', '265', '266', '271', '274', '306', '311', '315', '325', '331',
  '332', '343', '346', '351', '356', '364', '365', '371', '411', '412', '413', '423', '431', '432', '445',
  '446', '452', '454', '455', '462', '464', '465', '466', '503', '506', '516', '523', '526', '532', '546',
  '565', '606', '612', '624', '627', '631', '632', '654', '662', '664', '703', '712', '723', '731', '732',
  '734', '743', '754'];

// Tuner type of an antenna port, as stored in the radio menu (TUNER TYPE SEL).
export const TUNER = { INT: 0, INT_FAST: 1, EXT: 2, ATAS: 3 };
export const TUNER_NAMES = ['INT', 'INT (FAST)', 'EXT', 'ATAS'];
export const MENU = { TUNER_ANT1: '030701', TUNER_ANT2: '030702', HF_ANT: '030704' };

// AC commands that start / stop a tune cycle for a tuner type, in the order to
// try them; the radio answers "?;" to a form it doesn't take, which does nothing.
// AC P1 P2 P3: P1 0 internal / 1 external port, P2 0 tuner / 2 ATAS, P3 0 stop / 3 start.
// Yaesu documents AC003 for the internal tuner; Hamlib's hardware testing found
// AC103 starts the cycle whichever tuner is selected, and that an ATAS only
// takes the AC12x forms. `type` null = the menu couldn't be read.
export function tuneCommands(type) {
  if (type === TUNER.ATAS) return { start: ['AC123;'], stop: ['AC120;'] };
  if (type === TUNER.INT || type === TUNER.INT_FAST) return { start: ['AC003;', 'AC103;'], stop: ['AC000;', 'AC100;'] };
  if (type === TUNER.EXT) return { start: ['AC103;', 'AC003;'], stop: ['AC000;', 'AC100;'] };
  return { start: ['AC103;', 'AC003;', 'AC123;'], stop: ['AC000;', 'AC100;', 'AC120;'] };
}

// Bands for the band buttons. `start`/`end` are the band edges used to
// decide which band a frequency is in; `def`/`mode` are the fallback
// first-visit frequency and mode. `phone` is the lower edge of the US phone
// segment for each license class (FCC Part 97.305); a class that isn't listed
// has no voice privileges on that band.
const ALL = hz => ({ technician: hz, general: hz, extra: hz });
const GEN = (general, extra = general) => ({ general, extra });
export const BANDS = [
  { id: '160', label: '160', start: 1800000, end: 2000000, def: 1900000, mode: 'LSB', phone: GEN(1800000) },
  { id: '80', label: '80', start: 3500000, end: 4000000, def: 3750000, mode: 'LSB', phone: GEN(3800000, 3600000) },
  // 60 m is channelised: this is the dial frequency of the lowest channel.
  { id: '60', label: '60', start: 5330000, end: 5410000, def: 5357000, mode: 'USB', phone: GEN(5332000) },
  { id: '40', label: '40', start: 7000000, end: 7300000, def: 7150000, mode: 'LSB', phone: GEN(7175000, 7125000) },
  { id: '30', label: '30', start: 10100000, end: 10150000, def: 10136000, mode: 'DATA-U' }, // no phone for anyone
  { id: '20', label: '20', start: 14000000, end: 14350000, def: 14250000, mode: 'USB', phone: GEN(14225000, 14150000) },
  { id: '17', label: '17', start: 18068000, end: 18168000, def: 18130000, mode: 'USB', phone: GEN(18110000) },
  { id: '15', label: '15', start: 21000000, end: 21450000, def: 21300000, mode: 'USB', phone: GEN(21275000, 21200000) },
  { id: '12', label: '12', start: 24890000, end: 24990000, def: 24950000, mode: 'USB', phone: GEN(24930000) },
  { id: '10', label: '10', start: 28000000, end: 29700000, def: 28400000, mode: 'USB', phone: ALL(28300000) },
  { id: '6', label: '6', start: 50000000, end: 54000000, def: 50125000, mode: 'USB', phone: ALL(50100000) },
  { id: '2', label: '2', start: 144000000, end: 148000000, def: 146520000, mode: 'FM', phone: ALL(144100000) },
  // Phone is legal from 420 MHz, but SSB lives at the 432.100 calling frequency.
  { id: '70', label: '70cm', start: 420000000, end: 450000000, def: 446000000, mode: 'FM', phone: ALL(432100000) },
];

export function bandForFreq(hz) {
  return BANDS.find(b => hz >= b.start && hz <= b.end) || null;
}

// First-visit frequency and mode for a band: the lowest SSB voice dial
// frequency the license class may use. An LSB signal sits below the dial, so
// LSB bands start 3 kHz above the segment edge. Bands with no voice privileges
// for the class fall back to `def`/`mode` with voice: false.
const LSB_MARGIN = 3000;
export function bandDefault(band, license) {
  const edge = band.phone?.[license];
  if (edge == null) return { freq: band.def, mode: band.mode, voice: false };
  const lsb = edge < 10000000 && band.id !== '60';
  return { freq: lsb ? edge + LSB_MARGIN : edge, mode: lsb ? 'LSB' : 'USB', voice: true };
}

// ---------- helpers ----------
const pad = (n, w) => String(Math.max(0, Math.round(n))).padStart(w, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const vfo = v => (v === 1 || v === 'B' || v === 'SUB' ? '1' : '0');

// Split "FA014250000;FB..." style stream text into complete replies.
// Returns { replies: [...], rest: 'partial' }.
export function splitReplies(buffer) {
  const parts = buffer.split(';');
  const rest = parts.pop();
  return { replies: parts.filter(p => p.length).map(p => p + ';'), rest };
}

// The key a reply should be matched against (e.g. 'FA', 'SM0', 'RM5').
// Commands with a MAIN/SUB or sub-function digit are keyed with it so
// concurrent reads of the same opcode don't cross.
const KEYED_BY_DIGIT = new Set(['AG', 'RG', 'SQ', 'MD', 'SM', 'SH', 'IS', 'NL', 'RL', 'BC',
  'GT', 'PA', 'RA', 'PR', 'ML', 'NA', 'RM', 'CT']);
const KEYED_BY_TWO = new Set(['BP', 'CO', 'CN']);
export function replyKey(text) {
  const op = text.slice(0, 2);
  if (op === 'EX') return text.slice(0, 8); // menu item: EX + group, section, item
  if (KEYED_BY_TWO.has(op)) return text.slice(0, 4);
  if (KEYED_BY_DIGIT.has(op)) return text.slice(0, 3);
  return op;
}

// ---------- builders (set) ----------
export const cmd = {
  id: () => 'ID;',
  ai: on => `AI${on ? 1 : 0};`,
  freq: (v, hz) => `F${vfo(v) === '1' ? 'B' : 'A'}${pad(hz, 9)};`,
  readFreq: v => `F${vfo(v) === '1' ? 'B' : 'A'};`,
  mode: (v, mode) => {
    const code = MODE_CODES[mode];
    if (!code) throw new Error(`Unknown mode ${mode}`);
    return `MD${vfo(v)}${code};`;
  },
  readMode: v => `MD${vfo(v)};`,
  vfoSelect: v => `VS${vfo(v)};`,
  txVfo: v => `FT${vfo(v)};`,
  aToB: () => 'AB;',
  bToA: () => 'BA;',
  swap: () => 'SV;',
  afGain: (v, n) => `AG${vfo(v)}${pad(clamp(n, 0, 255), 3)};`,
  rfGain: (v, n) => `RG${vfo(v)}${pad(clamp(n, 0, 255), 3)};`,
  squelch: (v, n) => `SQ${vfo(v)}${pad(clamp(n, 0, 100), 3)};`,
  agc: (v, n) => `GT${vfo(v)}${clamp(n, 0, 4)};`,
  preamp: (bandType, n) => `PA${clamp(bandType, 0, 2)}${clamp(n, 0, 2)};`,
  att: on => `RA0${on ? 1 : 0};`,
  width: (v, code) => `SH${vfo(v)}0${pad(clamp(code, 0, 23), 2)};`,
  // IS P1 P2 P3 P4: P2 is fixed at 0 (Yaesu's manual; Hamlib's "on/off" 1 is refused).
  ifShift: (v, hz) => {
    const h = clamp(Math.round(hz / 20) * 20, -1200, 1200);
    return `IS${vfo(v)}0${h < 0 ? '-' : '+'}${pad(Math.abs(h), 4)};`;
  },
  nbLevel: (v, n) => `NL${vfo(v)}${pad(clamp(n, 0, 10), 3)};`,
  nrLevel: (v, n) => `RL${vfo(v)}${pad(clamp(n, 0, 10), 2)};`,
  dnf: (v, on) => `BC${vfo(v)}${on ? 1 : 0};`,
  notch: (v, on) => `BP${vfo(v)}0${on ? '001' : '000'};`,
  notchFreq: (v, hz) => `BP${vfo(v)}1${pad(clamp(Math.round(hz / 10), 1, 320), 3)};`,
  contour: (v, on) => `CO${vfo(v)}0${on ? '0001' : '0000'};`,
  contourFreq: (v, hz) => `CO${vfo(v)}1${pad(clamp(hz, 10, 3200), 4)};`,
  narrow: (v, on) => `NA${vfo(v)}${on ? 1 : 0};`,
  ptt: on => `TX${on ? 1 : 0};`,
  // Optima/SPA-1 uses P1=2 with whole watts; the Field head uses P1=1.
  power: (head, watts) => {
    if (head === 'optima') return `PC2${pad(clamp(watts, 5, 100), 3)};`;
    const w = clamp(watts, 0.5, 10);
    return Number.isInteger(w) ? `PC1${pad(w, 3)};` : `PC1${w.toFixed(1)};`;
  },
  micGain: n => `MG${pad(clamp(n, 0, 100), 3)};`,
  proc: on => `PR0${on ? 1 : 0};`,
  procLevel: n => `PL${pad(clamp(n, 0, 100), 3)};`,
  amc: n => `AO${pad(clamp(n, 0, 100), 3)};`,
  vox: on => `VX${on ? 1 : 0};`,
  voxGain: n => `VG${pad(clamp(n, 0, 100), 3)};`,
  monitorLevel: n => `ML0${pad(clamp(n, 0, 100), 3)};`,
  readMenu: item => `EX${item};`,
  sqlType: (v, n) => `CT${vfo(v)}${clamp(n, 0, SQL_TYPES.length - 1)};`,
  ctcssTone: (v, i) => `CN${vfo(v)}0${pad(clamp(i, 0, CTCSS_TONES.length - 1), 3)};`,
  dcsCode: (v, i) => `CN${vfo(v)}1${pad(clamp(i, 0, DCS_CODES.length - 1), 3)};`,
  keySpeed: wpm => `KS${pad(clamp(wpm, 4, 60), 3)};`,
  keyPitch: hz => `KP${pad(clamp(Math.round((hz - 300) / 10), 0, 75), 2)};`,
  readMeter: n => `RM${n};`,
};

// ---------- parsers ----------
// Every parser takes a full reply like "FA014250000;" and returns a value,
// or null if the reply isn't the expected shape.
const body = (r, op) => (typeof r === 'string' && r.startsWith(op) && r.endsWith(';')) ? r.slice(op.length, -1) : null;
const int = s => (s != null && /^[0-9]+$/.test(s) ? parseInt(s, 10) : null);

export const parse = {
  id: r => body(r, 'ID'),
  freq: r => {
    const b = body(r, r?.slice(0, 2));
    return (r?.[0] === 'F' && (r[1] === 'A' || r[1] === 'B')) ? int(b) : null;
  },
  mode: r => { const b = body(r, 'MD'); return b && b.length === 2 ? (CODE_TO_MODE[b[1]] ?? null) : null; },
  vfoLevel: (r, op) => { const b = body(r, op); return b ? int(b.slice(1)) : null; }, // AG0nnn, RG0nnn...
  plain: (r, op) => int(body(r, op)),               // MGnnn, PLnnn, KSnnn...
  flag: (r, op) => { const b = body(r, op); return b ? b.slice(-1) === '1' : null; },
  agc: r => { const b = body(r, 'GT'); return b ? int(b.slice(1)) : null; },
  preamp: r => { const b = body(r, 'PA'); return b ? int(b.slice(1)) : null; },
  width: r => { const b = body(r, 'SH'); return b && b.length >= 4 ? int(b.slice(2, 4)) : null; },
  ifShift: r => {
    const b = body(r, 'IS');
    if (!b || b.length < 7) return null;
    const mag = int(b.slice(3, 7));
    if (mag == null) return null;
    return b[2] === '-' ? -mag : mag;
  },
  // BP/CO replies: P1 VFO, P2 sub-function, then value.
  sub: (r, op) => { const b = body(r, op); return b && b.length >= 3 ? { fn: b[1], value: int(b.slice(2)) } : null; },
  smeter: r => { const b = body(r, 'SM'); return b && b.length === 4 ? int(b.slice(1)) : null; },
  meter: r => { const b = body(r, 'RM'); return b && b.length >= 4 ? { meter: int(b[0]), raw: int(b.slice(1, 4)) } : null; },
  ptt: r => { const b = body(r, 'TX'); return b ? b !== '0' : null; },
  power: r => {
    const b = body(r, 'PC');
    if (!b || b.length < 2) return null;
    const head = b[0] === '2' ? 'optima' : 'field';
    const watts = parseFloat(b.slice(1));
    return Number.isFinite(watts) ? { head, watts } : null;
  },
  txVfo: r => { const b = body(r, 'FT'); return b ? int(b) : null; },
  tuning: r => { const b = body(r, 'AC'); return b && b.length === 3 ? b[2] !== '0' : null; },
  sqlType: r => { const b = body(r, 'CT'); const n = b && b.length === 2 ? int(b[1]) : null; return n != null && n < SQL_TYPES.length ? n : null; },
  // CN reply: P1 receiver, P2 0 CTCSS / 1 DCS, then the table index
  toneCode: r => { const b = body(r, 'CN'); return b && b.length === 5 ? { dcs: b[1] === '1', index: int(b.slice(2)) } : null; },
  menu: r => { const b = body(r, 'EX'); return b && b.length > 6 ? int(b.slice(6)) : null; },
  keyPitch: r => { const n = int(body(r, 'KP')); return n == null ? null : 300 + n * 10; },
};

// ---------- meter calibration ----------
function interp(table, raw) {
  if (raw <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    const [x0, y0] = table[i - 1];
    if (raw <= x1) return y0 + (y1 - y0) * (raw - x0) / (x1 - x0);
  }
  return table[table.length - 1][1];
}
const S_CAL = [[0, -54], [12, -48], [27, -42], [40, -36], [55, -30], [65, -24], [80, -18], [95, -12],
  [112, -6], [130, 0], [150, 10], [172, 20], [190, 30], [220, 40], [240, 50], [255, 60]];
const PO_CAL = [[0, 0], [10, 0.8], [50, 8], [100, 26], [150, 54], [200, 92], [250, 140]];
const SWR_CAL = [[0, 1.0], [12, 1.0], [39, 1.35], [65, 1.5], [89, 2.0], [242, 5.0], [255, 5.5]];

export const calibrate = {
  sDb: raw => interp(S_CAL, raw),                 // dB relative to S9
  sLabel: raw => {
    const db = interp(S_CAL, raw);
    if (db <= 0) return `S${Math.max(0, Math.round((db + 54) / 6))}`;
    return `S9+${Math.round(db / 10) * 10}`;
  },
  // PO table is scaled for 100 W full scale; Field head readings scale down.
  poWatts: (raw, maxWatts = 100) => interp(PO_CAL, raw) * (maxWatts / 100),
  swr: raw => interp(SWR_CAL, raw),
  alcFraction: raw => Math.min(1, raw / 255),
};

export function widthTable(mode) {
  if (/^(LSB|USB)$/.test(mode)) return SSB_WIDTHS;
  if (/^(CW|DATA-[LU]|RTTY|PSK)/.test(mode)) return NARROW_WIDTHS;
  return null; // AM/FM: fixed
}

// RF power range for a configuration, from Yaesu's specifications:
//   Optima/SPA-1: 5-100 W on HF/50 MHz, 5-50 W from 70 MHz up (AM carrier 25 / 13 W)
//   Field head:   0.5-10 W on 13.8 V, 0.5-6 W on its battery (AM carrier 2.5 / 1.5 W)
export function powerLimits({ head, hz, mode, battery = false }) {
  const am = /^AM/.test(mode || '');
  if (head === 'optima') {
    const vu = hz >= 60000000;
    return { min: 5, max: am ? (vu ? 13 : 25) : (vu ? 50 : 100) };
  }
  return { min: 0.5, max: am ? (battery ? 1.5 : 2.5) : (battery ? 6 : 10) };
}
export const FIELD_BATTERY_MAX_W = 6;

export function preampBandType(hz) {
  if (hz >= 420000000) return 2;
  if (hz >= 144000000) return 1;
  return 0;
}
