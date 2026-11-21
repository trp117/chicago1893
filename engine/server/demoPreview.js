// DEMO_PREVIEW_KEY — a private tester bypass of the per-IP daily playthrough cap. DEMO_MODE only.
//
// THE CONTRACT: with DEMO_PREVIEW_KEY unset (or shorter than MIN_KEY_LENGTH), nothing here is
// mounted and no request can skip the cap. The public cap, the rate limiter and the spend
// budget are unchanged for everyone, including a tester: the key skips the DAILY CAP ONLY.
//
// How it is used: open any demo page once with `?preview_key=<DEMO_PREVIEW_KEY>`. The server
// sets an HttpOnly cookie (an HMAC of the key, never the key itself) and redirects to the same
// URL without the parameter, so the key does not sit in the address bar, history or a Referer.
// The page's own /start and /turn fetches are same-origin, so they carry the cookie; the game
// router asks `hasBypass(req)` before taking a daily slot. Rotating the key invalidates every
// cookie issued under the old one.
import crypto from 'crypto';

export const PREVIEW_PARAM   = 'preview_key';
export const PREVIEW_COOKIE  = 'demo_preview';
export const MIN_KEY_LENGTH  = 24;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const hmac = key => crypto.createHmac('sha256', key).update('demo-preview-daily-cap-bypass').digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// null when off. Otherwise { middleware, hasBypass }.
export function createDemoPreview({ demoMode, key, secureCookie = false, log = console } = {}) {
  if (!demoMode || typeof key !== 'string') return null;
  if (key.length < MIN_KEY_LENGTH) {
    log.warn?.(`[DEMO PREVIEW] DEMO_PREVIEW_KEY is shorter than ${MIN_KEY_LENGTH} characters — bypass disabled.`);
    return null;
  }
  const token = hmac(key);

  function hasBypass(req) {
    const c = readCookie(req, PREVIEW_COOKIE);
    return !!c && safeEqual(c, token);
  }

  // Mounted ahead of the page guard: only a GET carrying the parameter is touched.
  function middleware(req, res, next) {
    if (req.method !== 'GET' || req.query?.[PREVIEW_PARAM] === undefined) return next();
    const given = req.query[PREVIEW_PARAM];
    const url   = new URL(req.originalUrl, 'http://x');
    url.searchParams.delete(PREVIEW_PARAM);
    const clean = url.pathname + url.search + url.hash;
    res.set('Cache-Control', 'no-store');
    if (typeof given === 'string' && safeEqual(given, key)) {
      res.cookie(PREVIEW_COOKIE, token, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE_S * 1000 });
      log.log?.(`[DEMO PREVIEW] bypass cookie issued ip=${req.ip || 'unknown'}`);
    } else {
      log.warn?.(`[DEMO PREVIEW] wrong preview key ip=${req.ip || 'unknown'}`);
    }
    // Same response either way: a wrong key is not told it was wrong.
    return res.redirect(302, clean);
  }

  return { middleware, hasBypass };
}
