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
import { STORY_CLOCK_ENABLED } from '../services/StoryClock.js';

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

export function readingLayoutFiles({ storyClock = STORY_CLOCK_ENABLED } = {}) {
  const js = fs.readFileSync(READING_LAYOUT_JS_PATH, 'utf8');
  return { css: fs.readFileSync(READING_LAYOUT_CSS_PATH, 'utf8'), js: storyClock ? withStoryClockDisplay(js) : js };
}

// STORY CLOCK display (StoryClock.js): with STORY_CLOCK_ENABLED the header's clock() prefers the
// time the server stamped on state (gameState.storyClock — set only for a clock session) over
// sessionStartTime + elapsed. Patched at serve time, like everything else here, so the file — and
// with the flag off, every served byte — is unchanged. A missing anchor leaves the script as is.
export const STORY_CLOCK_DISPLAY_ANCHOR = 'function clock() {';
export function withStoryClockDisplay(js) {
  if (js.split(STORY_CLOCK_DISPLAY_ANCHOR).length !== 2) {
    console.warn('[STORY-CLOCK] reading-layout.js clock() anchor not found exactly once — header keeps the 1:1 clock');
    return js;
  }
  return js.replace(STORY_CLOCK_DISPLAY_ANCHOR,
    `${STORY_CLOCK_DISPLAY_ANCHOR}\n    if (typeof gameState !== 'undefined' && gameState && typeof gameState.storyClock === 'string' && gameState.storyClock) return gameState.storyClock;`);
}

// ── Direct start (/game only, never the cold-open page) ─────────────────────────────────────
// With the layout on, /game's own entry (the native role screen + character screen overlays) is
// replaced by direct-start.js: the character entry and Begin in the column, /start on Begin
// only. A separate file because, unlike the layout, it drives the page's /start. The boot config
// is per deployment, never per request (/game stays cacheable): coldOpen = whether / routes a
// role to its cold open (DEMO_COLD_OPEN on) — the role panel's link target.
export const DIRECT_START_CSS_PATH = path.join(DEMO_DIR, 'direct-start.css');
export const DIRECT_START_JS_PATH  = path.join(DEMO_DIR, 'direct-start.js');

export function injectDirectStartIntoGameHtml(html, { coldOpen = false } = {}, { css, js }) {
  const head = `<style id="direct-start-css">${css}</style>
<script id="direct-start-boot">window.__DIRECT_START__ = ${JSON.stringify({ coldOpen: coldOpen === true })};</script>
`;
  const tail = `<script id="direct-start-js">${js}</script>\n`;
  const h = html.indexOf('</head>');
  let out = h === -1 ? head + html : html.slice(0, h) + head + html.slice(h);
  const b = out.lastIndexOf('</body>');
  out = b === -1 ? out + tail : out.slice(0, b) + tail + out.slice(b);
  return out;
}

export function directStartFiles() {
  return { css: fs.readFileSync(DIRECT_START_CSS_PATH, 'utf8'), js: fs.readFileSync(DIRECT_START_JS_PATH, 'utf8') };
}
