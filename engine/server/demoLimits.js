// DEMO_MODE Phase 2 — spend and abuse limits. Used only when DEMO_MODE is on: the game router
// builds these objects inside `if (demoMode)` and every guard that consults them is skipped
// when the flag is off.
//
//   budget      — a durable cumulative spend counter (cents) in Supabase. New sessions stop at
//                 the START ceiling ($90); in-progress sessions run on to the HARD ceiling ($98).
//   dailyCap    — at most N /start per client IP in a rolling 24h. In memory: a restart resets
//                 it, which is acceptable because the budget is the real ceiling.
//   rateLimiter — a global and a per-IP per-minute ceiling on the paid endpoints. In memory.

// Price per million tokens, USD. Sonnet 4.6 for every play call; Haiku 4.5 for /extract-facts
// (which demo mode disables — the rate is here so the table is complete).
export const RATES_PER_MTOK = {
  'claude-sonnet-4-6':         { input: 3, cacheWrite: 3.75, cacheRead: 0.30, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, cacheWrite: 1.25, cacheRead: 0.10, output: 5 },
};

// Cost of one call in cents, from the API's usage block. An unknown model is priced as Sonnet
// 4.6 (the dearest model on the play path) so a new model string can never be metered as free.
export function costCents(model, usage) {
  if (!usage) return 0;
  const r = RATES_PER_MTOK[model] || RATES_PER_MTOK['claude-sonnet-4-6'];
  const dollars = ((usage.input_tokens || 0) * r.input
                 + (usage.cache_creation_input_tokens || 0) * r.cacheWrite
                 + (usage.cache_read_input_tokens || 0) * r.cacheRead
                 + (usage.output_tokens || 0) * r.output) / 1e6;
  return dollars * 100;
}

// Player-facing copy. Shown by the demo client script (demoMode.js), never raw.
export const DEMO_LIMIT_COPY = {
  budget: 'This preview has reached its limit — thanks for trying it.',
  daily:  'You’ve reached today’s limit of two playthroughs for this preview — thanks for trying it.',
  rate:   'The preview is busy right now — please wait a minute and try again.',
};

// ── Budget ──────────────────────────────────────────────────────────────────
// Correctness:
//   - The counter lives in Supabase and is only ever changed by an atomic add
//     (demo_budget_add: a single INSERT … ON CONFLICT DO UPDATE … RETURNING), so concurrent
//     turns — in this process or another — never lose an increment, and a restart starts from
//     the committed total.
//   - Each call's cost is queued and flushed immediately; flushes are serialised and a failed
//     flush keeps its amount queued for the next one, so a Supabase blip delays the count
//     rather than dropping it. Only a crash between a call finishing and its flush loses that
//     one call's cents.
//   - Checks read a cached total (refreshed at most every `refreshMs`, and on every flush) plus
//     whatever is still queued. Overshoot is bounded by the calls already in flight when the
//     ceiling is crossed — a few turns' worth, cents to tens of cents.
//   - Fail closed: until the total has been read once, nothing is allowed.
export function createBudget({ store, startCeilingCents = 9000, hardCeilingCents = 9800, refreshMs = 30000, now = Date.now, log = console } = {}) {
  let committed = null;   // last total Supabase reported; null = never read
  let lastRead  = 0;
  let queued    = 0;      // cents recorded locally, not yet acknowledged by Supabase
  let chain     = Promise.resolve();

  async function refresh(force = false) {
    if (!force && committed !== null && now() - lastRead < refreshMs) return;
    try {
      committed = Number(await store.readBudget()) || 0;
      lastRead  = now();
    } catch (e) {
      log.error?.(`[DEMO BUDGET] read failed: ${e.message}`);
    }
  }

  async function spentCents() {
    await refresh();
    return committed === null ? null : committed + queued;
  }

  function flush() {
    chain = chain.then(async () => {
      if (queued <= 0) return;
      const amount = queued;
      try {
        const total = await store.addBudget(amount);
        queued   -= amount;
        committed = Number(total);
        lastRead  = now();
      } catch (e) {
        log.error?.(`[DEMO BUDGET] add of ${amount.toFixed(4)}¢ failed (kept queued): ${e.message}`);
      }
    });
    return chain;
  }

  return {
    // Before /start: below the start ceiling.
    async canStart()    { const s = await spentCents(); return s !== null && s < startCeilingCents; },
    // Before a mid-session paid call: below the hard ceiling.
    async canContinue() { const s = await spentCents(); return s !== null && s < hardCeilingCents; },
    record(model, usage) {
      const c = costCents(model, usage);
      if (c > 0) { queued += c; flush(); }
      return c;
    },
    flush,
    spentCents,
    ceilings: { startCeilingCents, hardCeilingCents },
  };
}

// ── Per-IP daily cap ────────────────────────────────────────────────────────
export function createDailyCap({ limit = 2, windowMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();   // ip -> timestamps of accepted /start
  return {
    // True and counted when the IP is under the cap; false (not counted) when it is at it.
    take(ip) {
      const t = now();
      const recent = (hits.get(ip) || []).filter(ts => t - ts < windowMs);
      if (recent.length >= limit) { hits.set(ip, recent); return false; }
      recent.push(t);
      hits.set(ip, recent);
      return true;
    },
    // Give back the IP's most recent slot — a /start that never delivered an opening.
    refund(ip) {
      const list = hits.get(ip);
      if (!list?.length) return;
      list.pop();
      if (!list.length) hits.delete(ip);
    },
    size: () => hits.size,
  };
}

// ── Rate limiter ────────────────────────────────────────────────────────────
// Sliding one-minute window, global and per IP. A refused request is not counted.
export function createRateLimiter({ globalPerMin = 30, ipPerMin = 6, windowMs = 60 * 1000, now = Date.now } = {}) {
  let global = [];
  const perIp = new Map();
  return {
    hit(ip) {
      const t = now();
      global = global.filter(ts => t - ts < windowMs);
      const mine = (perIp.get(ip) || []).filter(ts => t - ts < windowMs);
      if (global.length >= globalPerMin || mine.length >= ipPerMin) {
        if (mine.length) perIp.set(ip, mine); else perIp.delete(ip);
        return false;
      }
      global.push(t);
      mine.push(t);
      perIp.set(ip, mine);
      // Bound the map: drop IPs whose window has emptied.
      if (perIp.size > 1000) for (const [k, v] of perIp) if (!v.some(ts => t - ts < windowMs)) perIp.delete(k);
      return true;
    },
  };
}

export function readDemoLimitConfig(env = process.env) {
  const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    startCeilingCents: num(env.DEMO_BUDGET_START_CENTS, 9000),
    hardCeilingCents:  num(env.DEMO_BUDGET_HARD_CENTS, 9800),
    dailyStartsPerIp:  num(env.DEMO_DAILY_STARTS_PER_IP, 2),
    globalPerMin:      num(env.DEMO_RATE_GLOBAL_PER_MIN, 30),
    ipPerMin:          num(env.DEMO_RATE_IP_PER_MIN, 6),
  };
}
