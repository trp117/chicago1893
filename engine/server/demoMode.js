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
export const DEMO_LANDING_PATH = path.resolve(HERE, '../demo/index.html');

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

// What the demo adds to the game page, injected at serve time so the file on disk — and so
// the page prod serves — never changes:
//   - the intro "Listen" button is hidden (the turn narration buttons already are, by CSS);
//   - the browser speech-synthesis fallback is silenced, so a refused /tts produces no audio.
//     ttsSpeakFallback calls window.speechSynthesis.speak; an own no-op on the instance
//     shadows the prototype method before the page script runs.
export const DEMO_GAME_INJECTION = `<style id="demo-mode">.intro-listen-bar, .intro-listen-btn { display: none !important; }</style>
<script id="demo-mode-js">window.__DEMO_MODE__ = true; try { if (window.speechSynthesis) { window.speechSynthesis.speak = function () {}; } } catch (e) {}</script>
`;

export function injectDemoIntoGameHtml(html) {
  // Into <head>, ahead of every page script. A page without </head> gets it at the top.
  const at = html.indexOf('</head>');
  return at === -1 ? DEMO_GAME_INJECTION + html : html.slice(0, at) + DEMO_GAME_INJECTION + html.slice(at);
}

// Page-level containment. Mounted by server.js ahead of express.static, and ONLY when the
// flag is on. Handles the routes that would otherwise reach the catalogue or the branding:
//   /                 -> the Grey Witness demo landing (instead of public/index.html)
//   /index.html       -> redirect to /
//   /categories[...]  -> redirect to /
//   /test, /test.html, /index.backup*.html, /index_backup.html -> 404
//   /game             -> engine/game/index.html with the demo injection
export function demoPageGuard({ gameHtmlPath, landingPath = DEMO_LANDING_PATH, cacheControl }) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path;
    if (p === '/') {
      res.set('Cache-Control', cacheControl);
      return res.sendFile(landingPath);
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
