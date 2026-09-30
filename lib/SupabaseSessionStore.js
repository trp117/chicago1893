import session from 'express-session';

// Persistent express-session store backed by the Supabase table public.admin_sessions.
//
// WHY. The default MemoryStore lives in the process, so every deploy/restart signed every
// admin out, and an open editor tab's next Save failed with 401 "Session expired" — data lost
// mid-authoring (Joan's scenes, 2026-09-30). Sessions here survive restarts.
//
// WHY THIS TABLE AND NOT connect-pg-simple: the app reaches Supabase only through the
// service-key REST client (lib/supabase.js); there is no Postgres connection string or `pg`
// dependency. This store reuses that client — no new secret, no new dependency. The table is
// RLS-on with a service-role-only policy and no anon/authenticated grants, so the public anon
// key cannot read a session id (migration create_admin_sessions).
//
// EXPIRY matches the old behaviour: a row expires when its cookie does (login + maxAge; the
// session is not rolling). touch() is deliberately a no-op — extending the row past the
// browser cookie would keep a session alive that no browser can present.
//
// READ CACHE. Every admin request with a cookie calls get(); a short in-process cache keeps
// that from being one Supabase round trip per request. Writes and destroys update it, and it
// is per-process, so a restart simply starts cold from the table.
//
// FAILURE. A failed read is logged and treated as "no session" (the request is signed out —
// the old behaviour, never a 500 for the site). A failed write is returned to express-session
// as an error, so a login that could not be persisted fails visibly instead of seeming to work.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MS       = 30 * 1000;
const PRUNE_MS       = 60 * 60 * 1000;

export class SupabaseSessionStore extends session.Store {
  constructor({ client, table = 'admin_sessions', cacheMs = CACHE_MS, pruneMs = PRUNE_MS } = {}) {
    super();
    if (!client) throw new Error('SupabaseSessionStore needs a Supabase client');
    this.client  = client;
    this.table   = table;
    this.cacheMs = cacheMs;
    this.cache   = new Map();   // sid → { sess, expire (ms), at (ms) }
    if (pruneMs > 0) {
      this.pruneTimer = setInterval(() => this.prune().catch(() => {}), pruneMs);
      this.pruneTimer.unref?.();
    }
  }

  expiryOf(sess) {
    const e = sess?.cookie?.expires;
    const t = e ? new Date(e).getTime() : NaN;
    if (Number.isFinite(t)) return t;
    const maxAge = sess?.cookie?.originalMaxAge ?? sess?.cookie?.maxAge;
    return Date.now() + (typeof maxAge === 'number' && maxAge > 0 ? maxAge : DEFAULT_TTL_MS);
  }

  get(sid, cb) {
    const hit = this.cache.get(sid);
    const now = Date.now();
    if (hit && now - hit.at < this.cacheMs) return cb(null, hit.expire > now ? hit.sess : null);
    this.client.from(this.table).select('sess, expire').eq('sid', sid).maybeSingle()
      .then(({ data, error }) => {
        if (error) throw error;
        if (!data) { this.cache.delete(sid); return cb(null, null); }
        const expire = new Date(data.expire).getTime();
        if (!(expire > Date.now())) {
          this.cache.delete(sid);
          this.destroy(sid, () => {});
          return cb(null, null);
        }
        this.cache.set(sid, { sess: data.sess, expire, at: Date.now() });
        cb(null, data.sess);
      })
      .catch(err => {
        console.error(`[SESSION] read failed — treating as signed out: ${err.message}`);
        cb(null, null);
      });
  }

  set(sid, sess, cb = () => {}) {
    const expire = this.expiryOf(sess);
    // Store a plain JSON copy: express-session hands over a live Session/Cookie object.
    const plain = JSON.parse(JSON.stringify(sess));
    this.client.from(this.table)
      .upsert({ sid, sess: plain, expire: new Date(expire).toISOString() }, { onConflict: 'sid' })
      .then(({ error }) => {
        if (error) throw error;
        this.cache.set(sid, { sess: plain, expire, at: Date.now() });
        cb(null);
      })
      .catch(err => {
        this.cache.delete(sid);
        console.error(`[SESSION] write failed: ${err.message}`);
        cb(err);
      });
  }

  destroy(sid, cb = () => {}) {
    this.cache.delete(sid);
    this.client.from(this.table).delete().eq('sid', sid)
      .then(({ error }) => { if (error) throw error; cb(null); })
      .catch(err => { console.error(`[SESSION] destroy failed: ${err.message}`); cb(err); });
  }

  touch(_sid, _sess, cb = () => {}) { cb(null); }

  // Deletes expired rows. Runs hourly; exported for the test.
  async prune() {
    const { error } = await this.client.from(this.table).delete().lt('expire', new Date().toISOString());
    if (error) throw error;
  }

  close() { if (this.pruneTimer) clearInterval(this.pruneTimer); }
}
