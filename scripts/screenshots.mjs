// Takes the README screenshots: the single-file build in demo mode, once per
// theme, in headless Chrome or Edge. Needs Node 22+ (built-in WebSocket).
//   npm run build && node scripts/screenshots.mjs
// Set BROWSER to the browser's path if it isn't found.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const page = resolve(root, 'dist/ftx-deck.html');
const outDir = resolve(root, 'docs/screenshots');
const PORT = 9333;
const SIZE = { width: 1600, height: 1000 };
const SHOTS = ['shack', 'daylight', 'nightred', 'phosphor', 'nixie', 'bluelcd'];

const browser = [process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => p && existsSync(p));
if (!browser) throw new Error('No Chrome or Edge found; set BROWSER to its path.');
if (!existsSync(page)) throw new Error('Run "npm run build" first.');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'ftxdeck-shots-'));
const proc = spawn(browser, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  `--window-size=${SIZE.width},${SIZE.height}`, 'about:blank'], { stdio: 'ignore' });

try {
  // the DevTools endpoint takes a moment to come up
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ }
  }
  if (!target) throw new Error('Browser did not open a DevTools endpoint.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const n = ++id;
    waiting.set(n, m => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const run = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || expr);
    return r.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 1, mobile: false });
  await mkdir(outDir, { recursive: true });
  for (const theme of SHOTS) {
    await send('Page.navigate', { url: pathToFileURL(page).href });
    await sleep(800);
    await run(`(async () => {
      localStorage.clear();
      const $ = id => document.getElementById(id);
      $('setTheme').value = '${theme}'; $('setTheme').dispatchEvent(new Event('change'));
      $('selSpeed').value = '4'; $('selSpeed').dispatchEvent(new Event('change'));
      $('btnDemo').click();
      await new Promise(r => setTimeout(r, 600));
      $('banner').hidden = true;
      document.querySelector('#modes [data-mode="CW-U"]').click();
      await ftx.radio.setFreq(0, 14025000);
      await ftx.radio.setShift(0);
    })()`);
    await sleep(9000); // let the waterfall fill
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(outDir, `${theme}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`wrote ${file}`);
  }
  ws.close();
} finally {
  proc.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
