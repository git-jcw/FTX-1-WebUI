// Builds FTX Deck into one self-contained HTML file: scripts bundled, styles,
// fonts and icon inlined. The desktop app (electron/main.cjs) loads this file.
//   node scripts/build.mjs   ->  dist/ftx-deck.html

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p, enc = 'utf8') => readFile(resolve(root, p), enc);
const out = resolve(root, 'dist/ftx-deck.html');

// Replace exactly one occurrence, so a changed index.html fails loudly instead
// of silently producing a page that still points at separate files.
function swap(html, find, replacement) {
  const n = html.split(find).length - 1;
  if (n !== 1) throw new Error(`build: expected one ${JSON.stringify(find)} in index.html, found ${n}`);
  return html.replace(find, () => replacement);
}

// fonts.css with each url(...) replaced by the font file as a data URL
async function inlineFonts(css) {
  let result = css;
  for (const [, url] of css.matchAll(/url\('([^']+\.woff2)'\)/g)) {
    const data = await read(resolve(root, 'css', url), null);
    result = result.replace(url, `data:font/woff2;base64,${data.toString('base64')}`);
  }
  return result;
}

const js = (await build({
  entryPoints: [resolve(root, 'js/main.js')],
  bundle: true, format: 'iife', target: 'chrome110', minify: true,
  legalComments: 'none', write: false,
})).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = `${await inlineFonts(await read('css/fonts.css'))}\n${await read('css/app.css')}\n${await read('css/themes.css')}`;
const icon = `data:image/svg+xml;base64,${(await read('assets/icon.svg', null)).toString('base64')}`;

let html = await read('index.html');
html = swap(html, '<link rel="stylesheet" href="css/fonts.css">', '');
html = swap(html, '<link rel="stylesheet" href="css/themes.css">', '');
html = swap(html, '<link rel="stylesheet" href="css/app.css">', `<style>\n${css}</style>`);
html = swap(html, 'href="assets/icon.svg"', `href="${icon}"`);
html = swap(html, 'src="assets/icon.svg"', `src="${icon}"`);
html = swap(html, '<script type="module" src="js/main.js"></script>', `<script>\n${js}</script>`);
html = swap(html, '<html lang="en">', '<html lang="en">\n<!-- FTX Deck, single-file build. Fonts: IBM Plex Sans and JetBrains Mono, SIL Open Font License 1.1. -->');

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`Built ${out} (${Math.round(html.length / 1024)} KB)`);
