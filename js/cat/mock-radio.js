// A simulated FTX-1 (Optima) for demo mode and tests.
// It speaks the same CAT text as the real radio, so the whole app path is
// exercised without hardware. Behaviour follows docs/FTX1-CAT-NOTES.md.

export class MockRadioTransport {
  constructor({ latencyMs = 4 } = {}) {
    this.onData = () => {};
    this.onClose = () => {};
    this.label = 'Demo radio (simulated FTX-1 Optima)';
    this.latencyMs = latencyMs;
    this.log = [];
    this.s = {
      FA: 14250000, FB: 7074000, MD: ['2', 'C'], VS: 0, FT: 0,
      AG: [128, 100], RG: [255, 255], SQ: [0, 0], GT: [4, 4], PA: [1, 0, 0], RA: 0,
      SH: [17, 16], IS: [0, 0], NL: [0, 0], RL: [0, 0], BC: [0, 0],
      BP: [[0, 100], [0, 100]], CO: [[0, 1000, 0, 25], [0, 1000, 0, 25]], NA: [0, 0],
      TX: 0, PC: ['2', 50], MG: 50, PR: 0, PL: 50, AO: 50, VX: 0, VG: 50, ML: 50,
      KS: 20, KP: 30, AC: '000', AI: 0,
    };
    this._tuneUntil = 0;
  }

  async open() {}
  async close() { this.onClose('closed'); }

  write(text) {
    for (const c of text.split(';').filter(Boolean)) {
      this.log.push(c + ';');
      const reply = this._handle(c);
      if (reply) setTimeout(() => this.onData(reply), this.latencyMs);
    }
    return Promise.resolve();
  }

  _handle(c) {
    const s = this.s;
    const op = c.slice(0, 2);
    const a = c.slice(2);
    const v = a[0] === '1' ? 1 : 0;
    const p3 = n => String(n).padStart(3, '0');
    const p2 = n => String(n).padStart(2, '0');
    const p4 = n => String(n).padStart(4, '0');
    switch (op) {
      case 'ID': return 'ID0840;';
      case 'AI': if (a) { s.AI = +a; return null; } return `AI${s.AI};`;
      case 'FA': case 'FB':
        if (a) { s[op] = parseInt(a, 10); return null; }
        return `${op}${String(s[op]).padStart(9, '0')};`;
      case 'MD': if (a.length === 2) { s.MD[v] = a[1]; return null; } return `MD${v}${s.MD[v]};`;
      case 'VS': if (a) { s.VS = +a; return null; } return `VS${s.VS};`;
      case 'FT': if (a) { s.FT = +a; return null; } return `FT${s.FT};`;
      case 'AB': s.FB = s.FA; s.MD[1] = s.MD[0]; return null;
      case 'BA': s.FA = s.FB; s.MD[0] = s.MD[1]; return null;
      case 'SV': [s.FA, s.FB] = [s.FB, s.FA]; s.MD.reverse(); return null;
      case 'AG': case 'RG': case 'SQ':
        if (a.length === 4) { s[op][v] = +a.slice(1); return null; } return `${op}${v}${p3(s[op][v])};`;
      case 'GT': if (a.length === 2) { s.GT[v] = +a[1]; return null; } return `GT${v}${s.GT[v]};`;
      case 'PA': { const b = +a[0] || 0; if (a.length === 2) { s.PA[b] = +a[1]; return null; } return `PA${b}${s.PA[b]};`; }
      case 'RA': if (a.length === 2) { s.RA = +a[1]; return null; } return `RA0${s.RA};`;
      case 'SH': if (a.length === 4) { s.SH[v] = +a.slice(2); return null; } return `SH${v}0${p2(s.SH[v])};`;
      case 'IS':
        if (a.length === 7) { s.IS[v] = a[1] === '1' ? (a[2] === '-' ? -1 : 1) * +a.slice(3) : 0; return null; }
        return `IS${v}${s.IS[v] ? 1 : 0}${s.IS[v] < 0 ? '-' : '+'}${p4(Math.abs(s.IS[v]))};`;
      case 'NL': if (a.length === 4) { s.NL[v] = +a.slice(1); return null; } return `NL${v}${p3(s.NL[v])};`;
      case 'RL': if (a.length === 3) { s.RL[v] = +a.slice(1); return null; } return `RL${v}${p2(s.RL[v])};`;
      case 'BC': if (a.length === 2) { s.BC[v] = +a[1]; return null; } return `BC${v}${s.BC[v]};`;
      case 'NA': if (a.length === 2) { s.NA[v] = +a[1]; return null; } return `NA${v}${s.NA[v]};`;
      case 'BP': {
        const fn = +a[1];
        if (a.length === 5) { s.BP[v][fn] = +a.slice(2); return null; }
        return `BP${v}${fn}${p3(s.BP[v][fn])};`;
      }
      case 'CO': {
        const fn = +a[1];
        if (a.length === 6) { s.CO[v][fn] = +a.slice(2); return null; }
        return `CO${v}${fn}${p4(s.CO[v][fn])};`;
      }
      case 'TX': if (a) { s.TX = +a; return null; } return `TX${s.TX};`;
      case 'PC':
        if (a) {
          if (a[0] !== '2') return '?;';
          const w = +a.slice(1); if (w < 5 || w > 100) return '?;';
          s.PC = ['2', w]; return null;
        }
        return `PC2${p3(s.PC[1])};`;
      case 'MG': case 'PL': case 'AO': case 'VG': case 'KS':
        if (a) { s[op] = +a; return null; } return `${op}${p3(s[op])};`;
      case 'KP': if (a) { s.KP = +a; return null; } return `KP${p2(s.KP)};`;
      case 'PR': if (a.length === 2) { s.PR = +a[1]; return null; } return `PR0${s.PR};`;
      case 'ML': if (a.length === 4) { s.ML = +a.slice(1); return null; } return `ML0${p3(s.ML)};`;
      case 'VX': if (a) { s.VX = +a; return null; } return `VX${s.VX};`;
      case 'AC':
        if (a) {
          if (a === '003') { this._tuneUntil = Date.now() + 2500; return null; }
          if (a === '000') { this._tuneUntil = 0; return null; }
          return '?;';
        }
        return `AC00${Date.now() < this._tuneUntil ? 3 : 0};`;
      case 'SM': return `SM${v}${p3(this._sMeter(v))};`;
      case 'RM': return `RM${a[0]}${p3(this._meter(+a[0]))}000;`;
      // Commands the real FTX-1 rejects (see notes): answer like the radio does.
      case 'NB': case 'NR': case 'BS': case 'ST': return '?;';
      default: return '?;';
    }
  }

  _sMeter(v) {
    if (this.s.TX) return 0;
    const t = Date.now() / 1000;
    const base = v ? 60 : 105;
    return Math.max(0, Math.min(255, Math.round(base + 25 * Math.sin(t * 1.7) + 12 * Math.sin(t * 7.3) + (Math.random() * 10 - 5))));
  }

  _meter(n) {
    const tx = this.s.TX || Date.now() < this._tuneUntil;
    const t = Date.now() / 1000;
    const tuning = Date.now() < this._tuneUntil;
    switch (n) {
      case 1: return this._sMeter(0);
      case 2: return this._sMeter(1);
      case 4: return tx ? Math.round(30 + 20 * Math.abs(Math.sin(t * 3))) : 0;
      case 5: { // PO: roughly track the power setting, with speech-like variation
        if (!tx) return 0;
        const target = this.s.PC[1];
        const raw = target <= 26 ? 100 * (target / 26) ** 0.6 : 100 + 100 * ((target - 26) / 66);
        const env = tuning ? 0.35 : 0.55 + 0.45 * Math.abs(Math.sin(t * 4.1));
        return Math.round(Math.min(250, raw * env));
      }
      case 6: return tx ? (tuning ? Math.round(80 - 60 * Math.min(1, (2500 - (this._tuneUntil - Date.now())) / 2500)) : 22) : 0;
      case 8: return 196;
      default: return 0;
    }
  }
}
