// DEMO_READING_LAYOUT — the demo's reading layout: a capped reading column over the scenario's
// full-bleed image, choices and input flowing in the column (no pinned bottom bar), and on wide
// screens a quiet cast rail ("You are" / "In the scene").
//
// THE CONTRACT: on only when DEMO_MODE is on AND DEMO_READING_LAYOUT is exactly 'true'. Off,
// nothing here is constructed and no response changes by a byte (scripts/cold-open-baseline.mjs).
// Layout only: no route, no API call, no model call. The game page on disk never changes — the
// layout is injected at serve time into /game and, with DEMO_COLD_OPEN, into the cold-open page,
// so the cold open and live turns share one column and rail and the handoff does not reflow.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo');
export const READING_LAYOUT_CSS_PATH = path.join(DEMO_DIR, 'reading-layout.css');
export const READING_LAYOUT_JS_PATH  = path.join(DEMO_DIR, 'reading-layout.js');

// The width at which the cast rail appears (and the top bar slims). Below it: one full-width
// column, no rail. Read by the <head> boot (first paint) and by reading-layout.js (resizes).
export const READING_LAYOUT_RAIL_MIN_PX = 900;

export function readReadingLayoutConfig(env = process.env, { demoMode = false } = {}) {
  return { enabled: demoMode === true && env.DEMO_READING_LAYOUT === 'true' };
}

// Into <head>: the stylesheet and a boot line that sets html.rl (and html.rl-wide on a wide
// screen) before first paint, so the page never paints in the old layout first. Before </body>:
// the script, after the page script has defined the globals it hooks. Files read at serve time.
export function injectReadingLayoutIntoGameHtml(html, { css, js }) {
  const head = `<style id="reading-layout-css">${css}</style>
<script id="reading-layout-boot">document.documentElement.classList.add('rl');
try { if (window.matchMedia('(min-width: ${READING_LAYOUT_RAIL_MIN_PX}px)').matches) document.documentElement.classList.add('rl-wide'); } catch (e) {}</script>
`;
  const tail = `<script id="reading-layout-js">${js}</script>\n`;
  const h = html.indexOf('</head>');
  let out = h === -1 ? head + html : html.slice(0, h) + head + html.slice(h);
  const b = out.lastIndexOf('</body>');
  out = b === -1 ? out + tail : out.slice(0, b) + tail + out.slice(b);
  return out;
}

export function readingLayoutFiles() {
  return { css: fs.readFileSync(READING_LAYOUT_CSS_PATH, 'utf8'), js: fs.readFileSync(READING_LAYOUT_JS_PATH, 'utf8') };
}
