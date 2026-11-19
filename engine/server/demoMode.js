// DEMO_MODE — a flag-gated, contained deployment: a fixed whitelist of vetted scenarios, no
// other-story navigation, no audio, a purpose-built landing page.
//
// THE PROD CONTRACT: with DEMO_MODE unset, nothing in this file changes a single byte that
// any route sends. server.js mounts demoPageGuard ONLY when the flag is on, and the game
// router's guards go through isAllowedScenario, which is `true` for every id when the flag
// is off. tests/demo-mode.test.mjs proves the flag-off responses byte-identical to the
// pre-DEMO prod commit.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = path.resolve(HERE, '../demo');
// The landing is a template: {{SITE_NAME}}, {{SITE_URL}}, {{TAGLINE}}, {{META_DESCRIPTION}}
// are filled at serve time from the demo branding (readDemoBranding). The file on disk is
// never served raw.
export const DEMO_LANDING_PATH = path.join(DEMO_DIR, 'index.html');

// ── Branding ────────────────────────────────────────────────────────────────
// One codebase, several independent demos: each demo deployment names itself through env.
// Every default is the Grey Witness value, so a deployment that sets none of these serves
// exactly the landing it served before the branding became configurable
// (tests/fixtures/greywitness-landing.html is that landing, frozen; demo-mode.test compares).
export const DEMO_BRANDING_DEFAULTS = Object.freeze({
  siteName:     'Grey Witness',
  siteUrl:      'https://greywitness.com',
  tagline:      'Step inside a decisive moment of history, as someone who was there.',
  // The link-preview card (1200×630) the landing's og:image / twitter:image point at, served
  // at GET /og-image.png by the demo guard only (prod has no such route). A file in engine/demo/.
  ogImageFile:  'greywitness-og.png',
});

// A bare file name inside engine/demo/ — no directory part, no traversal, a .png.
const OG_IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

// Reads DEMO_SITE_NAME / DEMO_SITE_URL / DEMO_SITE_TAGLINE / DEMO_OG_IMAGE_FILE. An unset or
// blank var takes its default. A bad image name throws: a demo that cannot name its own card
// must not boot and quietly show another demo's.
export function readDemoBranding(env = process.env) {
  const pick = (k, d) => (env[k] && env[k].trim()) || d;
  const D = DEMO_BRANDING_DEFAULTS;
  const branding = {
    siteName:    pick('DEMO_SITE_NAME', D.siteName),
    siteUrl:     pick('DEMO_SITE_URL', D.siteUrl).replace(/\/+$/, ''),
    tagline:     pick('DEMO_SITE_TAGLINE', D.tagline),
    ogImageFile: pick('DEMO_OG_IMAGE_FILE', D.ogImageFile),
  };
  if (!OG_IMAGE_FILE.test(branding.ogImageFile)) {
    throw new Error(`[DEMO] DEMO_OG_IMAGE_FILE must be a .png file name in engine/demo/ (got "${branding.ogImageFile}")`);
  }
  return branding;
}

export const demoOgImagePath = branding => path.join(DEMO_DIR, branding.ogImageFile);

const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The landing template filled with one demo's branding. Every value is HTML-escaped (they land
// in attributes and text). The meta description is "<name> — <tagline, first letter lowered>",
// which for the defaults is the Grey Witness line exactly.
export function renderDemoLanding(template, branding = DEMO_BRANDING_DEFAULTS) {
  const t = branding.tagline;
  const values = {
    SITE_NAME:        branding.siteName,
    SITE_URL:         branding.siteUrl,
    TAGLINE:          t,
    META_DESCRIPTION: `${branding.siteName} — ${t.charAt(0).toLowerCase()}${t.slice(1)}`,
  };
  return template.replace(/\{\{(SITE_NAME|SITE_URL|TAGLINE|META_DESCRIPTION)\}\}/g, (_, k) => escapeHtml(values[k]));
}

// ── Landing page views ──────────────────────────────────────────────────────
// A per-demo daily tally (public.demo_pageviews, migration 20261117): no cookies, no third
// parties, nothing about the visitor stored. Only a GET of the landing ("/") counts — not HEAD
// (uptime probes), assets, /health, /api/*, /game or /og-image.png.
//
// Obvious bots are skipped so the tally better reflects people: any user agent containing
// bot, crawl, spider, preview, facebookexternalhit, slackbot or redditbot (link-preview
// fetchers and search crawlers; "bot" alone already covers most, the rest are named so the
// list reads as what it catches). Case-insensitive. A missing user agent is not a bot here.
export const BOT_USER_AGENT = /bot|crawl|spider|preview|facebookexternalhit|slackbot|redditbot/i;
export const isBotUserAgent = ua => BOT_USER_AGENT.test(String(ua || ''));

// Fire-and-forget: runs after the response has been handed off, on a later tick, so the count
// can never block, delay or break the landing. Every failure (a throw, a rejection, Supabase
// down) is swallowed; the first one per process is logged so a missing migration is visible.
let pageviewWarned = false;
function countLandingView(onLandingView) {
  setImmediate(() => {
    const warn = e => {
      if (pageviewWarned) return;
      pageviewWarned = true;
      console.warn(`[DEMO PAGEVIEW] count failed (further failures not logged): ${e?.message || e}`);
    };
    try { Promise.resolve(onLandingView()).catch(warn); } catch (e) { warn(e); }
  });
}

export function readDemoConfig(env = process.env) {
  return {
    demoMode:      env.DEMO_MODE === 'true',
    demoScenarios: (env.DEMO_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

// True for every id when the flag is off — so a guard written as
// `if (!isAllowedScenario(id)) return 404` is a no-op in prod.
export function makeIsAllowedScenario({ demoMode, demoScenarios = [] } = {}) {
  return id => !demoMode || demoScenarios.includes(id);
}

// Static files from public/ that carry the full catalogue or the Ledger 250 branding:
// the prod homepage under its own name, its backups, and the test page.
const BLOCKED_PUBLIC_FILE = /^\/(index[._-][^/]*\.html|test(\.html)?)$/i;
// /admin, /admin/…, and public/admin-login.html / admin-reset-password.html.
const ADMIN_PATH = /^\/admin(\/|$|-[^/]*\.html$)/i;

// What the demo adds to the game page, injected at serve time so the file on disk — and so
// the page prod serves — never changes:
//   - the intro "Listen" button is hidden (the turn narration buttons already are, by CSS);
//   - the browser speech-synthesis fallback is silenced, so a refused /tts produces no audio.
//     ttsSpeakFallback calls window.speechSynthesis.speak; an own no-op on the instance
//     shadows the prototype method before the page script runs.
//   - Phase 2: a demo limit refusal from /start or /turn ({ demoLimit, error, retryable }) is
//     shown with its own copy. The page's own failure path deliberately never shows server
//     words and always offers "Try again", which is wrong for a spent budget or a daily cap:
//       terminal (budget, daily) -> a full-page notice; the page's request is left pending, so
//                                   no retry card or button appears behind it;
//       retryable (rate)         -> a short notice, and the response is passed through so the
//                                   page's normal "try again" card appears.
//     /closing-prose refusals need nothing here: they arrive as the SSE error the page already
//     turns into the authored closing.
export const DEMO_GAME_INJECTION = `<style id="demo-mode">.intro-listen-bar, .intro-listen-btn { display: none !important; }
#demo-limit-overlay { position: fixed; inset: 0; z-index: 99999; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(12,10,9,.92); }
#demo-limit-overlay p { max-width: 34ch; text-align: center; font-size: 20px; line-height: 1.5; color: #ECE3D2; font-family: Georgia, serif; }
#demo-limit-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 99999; max-width: calc(100% - 32px); padding: 12px 18px; border-radius: 8px; background: #2b2420; color: #ECE3D2; font-size: 15px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }</style>
<script id="demo-mode-js">window.__DEMO_MODE__ = true; try { if (window.speechSynthesis) { window.speechSynthesis.speak = function () {}; } } catch (e) {}
(function () {
  var realFetch = window.fetch && window.fetch.bind(window);
  if (!realFetch) return;
  function notice(id, text, ms) {
    var old = document.getElementById(id); if (old) old.remove();
    var el = document.createElement('div'); el.id = id;
    var p = document.createElement('p'); p.textContent = text; el.appendChild(p);
    if (id === 'demo-limit-toast') { el.setAttribute('role', 'status'); el.textContent = text; }
    else el.setAttribute('role', 'alert');
    document.body.appendChild(el);
    if (ms) setTimeout(function () { el.remove(); }, ms);
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return realFetch(input, init).then(function (resp) {
      if (!/\\/game\\/api\\/(start|turn)(\\?|$)/.test(url) || (resp.status !== 403 && resp.status !== 429)) return resp;
      return resp.clone().json().then(function (data) {
        if (!data || !data.demoLimit) return resp;
        if (data.retryable) { notice('demo-limit-toast', data.error, 6000); return resp; }
        notice('demo-limit-overlay', data.error);
        return new Promise(function () {});
      }, function () { return resp; });
    });
  };
})();</script>
`;

export function injectDemoIntoGameHtml(html) {
  // Into <head>, ahead of every page script. A page without </head> gets it at the top.
  const at = html.indexOf('</head>');
  return at === -1 ? DEMO_GAME_INJECTION + html : html.slice(0, at) + DEMO_GAME_INJECTION + html.slice(at);
}

// ── DEMO_COLD_OPEN entry page ───────────────────────────────────────────────
// The cold-open entry is the game page (unchanged on disk) + the demo injection + this: a
// stylesheet and a boot config in <head> (after the demo injection, before every page script),
// and the cold-open script just before </body>, after the page script has defined the globals
// it hooks. Both files live in engine/demo/ and are read at serve time, like the landing.
export const COLD_OPEN_CSS_PATH = path.join(DEMO_DIR, 'cold-open.css');
export const COLD_OPEN_JS_PATH  = path.join(DEMO_DIR, 'cold-open.js');
// JSON that is safe inside a <script> element.
const SCRIPT_UNSAFE = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const scriptJson = v => JSON.stringify(v).replace(SCRIPT_UNSAFE, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function injectColdOpenIntoGameHtml(html, { scenarioId, roleId, timings, historyUser }, { css, js }) {
  const boot = { scenarioId, roleId, timings, historyUser };
  const head = `<style id="cold-open-css">${css}</style>
<script id="cold-open-boot">window.__COLD_OPEN__ = ${scriptJson(boot)};
document.documentElement.classList.add('co-boot');
try { var u = new URL(location.href); u.searchParams.set('scenarioId', window.__COLD_OPEN__.scenarioId); history.replaceState(history.state, '', u.pathname + u.search + u.hash); } catch (e) {}</script>
`;
  const tail = `<script id="cold-open-js">${js}</script>\n`;
  const h = html.indexOf('</head>');
  let out = h === -1 ? head + html : html.slice(0, h) + head + html.slice(h);
  const b = out.lastIndexOf('</body>');
  out = b === -1 ? out + tail : out.slice(0, b) + tail + out.slice(b);
  return out;
}

// Page-level containment. Mounted by server.js ahead of express.static, and ONLY when the
// flag is on. Handles the routes that would otherwise reach the catalogue or the branding:
//   /                 -> the demo landing, branded from env (instead of public/index.html)
//   /og-image.png     -> the landing's link-preview image (image/png), the env-named file
//   /index.html       -> redirect to /
//   /categories[...]  -> redirect to /
//   /test, /test.html, /index.backup*.html, /index_backup.html -> 404
//   /admin, /admin/*, /admin-*.html (any method) -> 404
//   /game             -> engine/game/index.html with the demo injection
// onLandingView: called (fire-and-forget) once per counted landing view; omitted = no counting.
//
// coldOpen (DEMO_COLD_OPEN only; omitted otherwise, and then nothing below changes): the
// runtime from coldOpen.js. With it, / is the cold-open entry when the featured role has a
// ready row — and the card landing on any failure — and /moments is the card landing.
export function demoPageGuard({ gameHtmlPath, landingPath = DEMO_LANDING_PATH, branding = DEMO_BRANDING_DEFAULTS, ogImagePath = demoOgImagePath(branding), cacheControl, onLandingView = null, coldOpen = null }) {
  const sendLanding = (req, res, next) => {
    let html;
    try { html = fs.readFileSync(landingPath, 'utf8'); } catch (e) { return next(e); }
    res.set('Cache-Control', cacheControl);
    res.type('html').send(renderDemoLanding(html, branding));
  };
  const countView = req => {
    if (onLandingView && req.method === 'GET' && !isBotUserAgent(req.get('user-agent'))) countLandingView(onLandingView);
  };
  // The cold-open entry, or the landing. Every failure lands on the landing.
  const sendEntry = async (req, res, next) => {
    let page = null;
    try {
      const row = await coldOpen.entryRow();
      if (row) {
        const html = injectDemoIntoGameHtml(fs.readFileSync(gameHtmlPath, 'utf8'));
        page = injectColdOpenIntoGameHtml(html, {
          scenarioId: coldOpen.config.featuredScenario, roleId: coldOpen.config.featuredRole,
          timings: coldOpen.timings, historyUser: coldOpen.historyUser,
        }, { css: fs.readFileSync(COLD_OPEN_CSS_PATH, 'utf8'), js: fs.readFileSync(COLD_OPEN_JS_PATH, 'utf8') });
      }
    } catch (e) {
      console.warn(`[COLD-OPEN] entry failed, serving the landing: ${e?.message || e}`);
      page = null;
    }
    if (!page) return sendLanding(req, res, next);
    // Never cached: whether / is the entry or the landing follows the row, which can change.
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page);
  };
  return (req, res, next) => {
    const p = req.path;
    // The admin surface is not part of the demo: any method (the login is a POST), any depth,
    // plus the two admin pages express.static would otherwise serve from public/.
    if (ADMIN_PATH.test(p)) return res.status(404).send('Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (p === '/' && coldOpen) {
      countView(req);
      return sendEntry(req, res, next);
    }
    if (p === '/moments' && coldOpen) return sendLanding(req, res, next);
    if (p === '/') {
      let html;
      try { html = fs.readFileSync(landingPath, 'utf8'); } catch (e) { return next(e); }
      res.set('Cache-Control', cacheControl);
      res.type('html').send(renderDemoLanding(html, branding));
      if (onLandingView && req.method === 'GET' && !isBotUserAgent(req.get('user-agent'))) countLandingView(onLandingView);
      return;
    }
    if (p === '/og-image.png') {
      res.set('Cache-Control', cacheControl);
      return res.type('image/png').sendFile(ogImagePath);
    }
    if (p === '/index.html') return res.redirect(302, '/');
    if (p === '/categories' || p.startsWith('/categories/')) return res.redirect(302, '/');
    if (BLOCKED_PUBLIC_FILE.test(p)) return res.status(404).send('Not found');
    if (p === '/game') {
      let html;
      try { html = fs.readFileSync(gameHtmlPath, 'utf8'); } catch (e) { return next(e); }
      res.set('Cache-Control', cacheControl);
      return res.type('html').send(injectDemoIntoGameHtml(html));
    }
    return next();
  };
}
