// Colour themes. A theme is a set of CSS custom properties selected by
// <html data-theme="…"> (css/themes.css; the default lives on :root in
// app.css). The canvases draw with the same tokens, read through colors().
// Every colour token is a #rrggbb hex so alpha() can derive tints from it.

export const THEMES = [
  { id: 'shack', name: 'Shack (default)' },
  { id: 'daylight', name: 'Daylight' },
  { id: 'nightred', name: 'Night red' },
  { id: 'phosphor', name: 'Green phosphor' },
  { id: 'nixie', name: 'Nixie' },
  { id: 'bluelcd', name: 'Blue LCD' },
];

const WF_STOPS = [0, 0.2, 0.4, 0.58, 0.72, 0.86, 1]; // positions of --wf-0 … --wf-6

let cache = null;

export function applyTheme(id) {
  const theme = THEMES.find(t => t.id === id) ? id : 'shack';
  if (theme === 'shack') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  cache = null;
  return theme;
}

// The current theme's canvas colours (cached until the theme changes).
export function colors() {
  if (cache) return cache;
  const style = getComputedStyle(document.documentElement);
  const v = n => style.getPropertyValue(n).trim();
  cache = {
    mono: v('--mono'), text: v('--text'), accent: v('--amber'), notch: v('--red'),
    dnf: v('--green'), dnr: v('--cyan'), contour: v('--contour'),
    bg: v('--scope-bg'), grid: v('--scope-grid'), gridMinor: v('--scope-grid-2'), label: v('--scope-text'),
    trace: v('--trace'), traceFill: v('--trace-fill'), osc: v('--osc'),
    palette: buildPalette(WF_STOPS.map((t, i) => [t, rgb(v(`--wf-${i}`))])),
  };
  return cache;
}

export function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function alpha(hex, a) { return `rgba(${rgb(hex).join(',')},${a})`; }

// 256-entry RGB lookup for the waterfall, interpolated between the stops.
function buildPalette(stops) {
  const pal = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 1; while (j < stops.length - 1 && t > stops[j][0]) j++;
    const [t0, c0] = stops[j - 1], [t1, c1] = stops[j];
    const u = (t - t0) / (t1 - t0);
    for (let k = 0; k < 3; k++) pal[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * u;
  }
  return pal;
}
