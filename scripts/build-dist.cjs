// Production deploy build: index.html -> dist/ minified + static assets.
// Run: npm run build (DIST_DIR override supported). No code semantics change.
'use strict';
const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist');

function fail(msg) {
  console.error('BUILD FAIL: ' + msg);
  process.exit(1);
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// --- Baked WS default: WOC_WS_URL=wss://backend.onrender.com npm run build ---
// Pone el backend por defecto en dist (overrideable por ?ws= y localStorage).
{
  const baked = (process.env.WOC_WS_URL || '').trim();
  if (baked && !/^wss?:\/\/[A-Za-z0-9.\-:]+(\/\S*)?$/.test(baked)) fail('WOC_WS_URL invalid URL: ' + baked);
  html = html.split('__WOC_WS_URL__').join(baked);
}

// --- JS: bare <script> block (exactly one) ---
const scriptBlocks = [];
let work = html.replace(/<script>([\s\S]*?)<\/script>/g, (m, js) => {
  scriptBlocks.push(js);
  return `<script data-ph="${scriptBlocks.length - 1}"></script>`;
});
if (scriptBlocks.length !== 1) fail('expected exactly 1 bare <script>, found ' + scriptBlocks.length);
if (/<\/script/i.test(scriptBlocks[0])) fail('inline script contains </script');
let minJs;
try {
  minJs = transformSync(scriptBlocks[0], { loader: 'js', minify: true, charset: 'utf8' }).code;
} catch (e) {
  fail('js minify: ' + (e && e.message));
}

// --- JSON-LD blocks: minify JSON in place ---
work = work.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (m, open, json, close) => {
  let min = json;
  try {
    min = JSON.stringify(JSON.parse(json));
  } catch (e) {
    fail('ld+json parse: ' + (e && e.message));
  }
  return open + min + close;
});

// --- CSS blocks ---
const cssBlocks = [];
work = work.replace(/<style>([\s\S]*?)<\/style>/g, (m, css) => {
  cssBlocks.push(css);
  return `<style data-ph="${cssBlocks.length - 1}"></style>`;
});
const minCss = cssBlocks.map((css, i) => {
  try {
    return transformSync(css, { loader: 'css', minify: true, charset: 'utf8' }).code;
  } catch (e) {
    fail('css minify block ' + i + ': ' + (e && e.message));
    return '';
  }
});

// --- conservative HTML minify (scripts/styles are placeholders now) ---
work = work.replace(/<!--[\s\S]*?-->/g, '');
work = work
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .join('\n');
work = work.replace(/>\s+</g, '><');

// --- restore ---
work = work.replace(/<script data-ph="(\d+)"><\/script>/g, (m, i) => `<script>${minJs}</script>`);
work = work.replace(/<style data-ph="(\d+)"><\/style>/g, (m, i) => {
  const n = Number(i);
  if (!Number.isInteger(n) || !minCss[n]) fail('css placeholder ' + i);
  return `<style>${minCss[n]}</style>`;
});
if (work.includes('data-ph=')) fail('unrestored placeholder remains');

// --- write dist ---
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), work, 'utf8');
const assets = [
  'robots.txt', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest', '_headers', '404.html',
  'og_cover.webp', 'title_poster.webp', 'title_poster_sm.webp', 'app_icon.webp', 'icon-192.png', 'icon-512.png',
  'explore_frame.webp', 'explore_frame_sm.webp', 'apple_touch.png'
];
let copied = 0;
for (const a of assets) {
  const from = path.join(ROOT, a);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(DIST, a));
    copied += 1;
  }
}
const before = Buffer.byteLength(html, 'utf8');
const after = Buffer.byteLength(work, 'utf8');
console.log(`dist/index.html: ${(before / 1024).toFixed(1)}KB -> ${(after / 1024).toFixed(1)}KB (${Math.round((1 - after / before) * 100)}% smaller), assets copied: ${copied}`);
