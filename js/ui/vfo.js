// VFO display: renders a frequency as digit spans. Scrolling over a digit
// tunes by that digit's place value; scrolling elsewhere tunes by the step.

export function renderFreq(el, hz) {
  const s = String(Math.max(0, Math.round(hz))).padStart(9, '0');
  if (el.dataset.shown === s) return;
  el.dataset.shown = s;
  const firstSig = s.search(/[1-9]/);
  let html = '';
  for (let i = 0; i < 9; i++) {
    const place = 10 ** (8 - i);
    const dim = firstSig === -1 ? i < 8 : i < firstSig && i < 3;
    const small = i >= 6;
    html += `<span class="d${dim ? ' dim' : ''}${small ? ' small' : ''}" data-place="${place}">${s[i]}</span>`;
    if (i === 2 || i === 5) html += `<span class="sep${i === 5 ? ' small' : ''}">.</span>`;
  }
  el.innerHTML = html;
}

export function formatFreqShort(hz) {
  return `${(hz / 1e6).toFixed(6).replace(/(\.\d{3})(\d{3})$/, '$1.$2')} MHz`;
}

// Accepts "14.074", "14,074.5", "14074" (kHz) or "14074000" (Hz).
export function parseFreqInput(text) {
  const t = String(text).trim().replace(/,/g, '').replace(/\s*(mhz|khz|hz)$/i, m => ` ${m.trim().toLowerCase()}`);
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(mhz|khz|hz)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2]?.toLowerCase();
  let hz;
  if (unit === 'mhz') hz = n * 1e6;
  else if (unit === 'khz') hz = n * 1e3;
  else if (unit === 'hz') hz = n;
  else if (m[1].includes('.')) hz = n < 1000 ? n * 1e6 : n * 1e3;
  else hz = n < 1000 ? n * 1e6 : n < 1e6 ? n * 1e3 : n;
  hz = Math.round(hz);
  return hz >= 30000 && hz <= 470000000 ? hz : null;
}
