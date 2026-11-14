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

// Page-level containment. Mounted by server.js ahead of express.static, and ONLY when the
// flag is on. Handles the routes that would otherwise reach the catalogue or the branding:
//   /                 -> the Grey Witness demo landing (instead of public/index.html)
//   /index.html       -> redirect to /
//   /categories[...]  -> redirect to /
//   /test, /test.html, /index.backup*.html, /index_backup.html -> 404
//   /admin, /admin/*, /admin-*.html (any method) -> 404
//   /game             -> engine/game/index.html with the demo injection
export function demoPageGuard({ gameHtmlPath, landingPath = DEMO_LANDING_PATH, cacheControl }) {
  return (req, res, next) => {
    const p = req.path;
    // The admin surface is not part of the demo: any method (the login is a POST), any depth,
    // plus the two admin pages express.static would otherwise serve from public/.
    if (ADMIN_PATH.test(p)) return res.status(404).send('Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
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
