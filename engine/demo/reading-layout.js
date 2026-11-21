// DEMO_READING_LAYOUT — injected before </body> of /game and the cold-open page, only when the
// flag is on (readingLayout.js). The game page on disk never changes; this script and
// reading-layout.css re-lay it out:
//   - .main-column becomes the one scroller (a capped reading column); #story stops scrolling and
//     the bottom bar flows after it, so choices and input sit in the column — nothing pinned.
//     The page scrolls #story in 18 places; #story's scroll properties are mapped onto the column
//     below, so every one of them keeps working unchanged.
//   - the scenario's own image goes full-bleed behind the column.
//   - on wide screens (html.rl-wide), a cast rail: "You are" (role, where, when, The history) and
//     "In the scene" (present AND introduced NPCs only — never a name the narrative has not given).
// Layout only: it reads state the page already holds and makes no request of its own.
// Hooks are pinned by tests/reading-layout.test.mjs.
(function () {
  'use strict';
  var root = document.documentElement;
  if (!root.classList.contains('rl')) return;

  var RL_HOOKS = ['renderOutput', 'getCardDisplayName', 'getLocationDisplayName', 'sceneShortPlace', 'buildIntroPanelEl', 'applyRedesignRoleHero'];
  var missing = RL_HOOKS.filter(function (n) { return typeof window[n] !== 'function'; });
  if (missing.length) { try { console.warn('[reading-layout] game page hooks missing: ' + missing.join(', ')); } catch (e) {} }

  var RAIL_MIN_PX = 900;
  var CAST_CAP = 4;
  var TAG_MAX = 32;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── Wide / narrow ─────────────────────────────────────────────────────────
  var mq = null;
  try { mq = window.matchMedia('(min-width: ' + RAIL_MIN_PX + 'px)'); } catch (e) {}
  function syncWide() { root.classList.toggle('rl-wide', !!(mq && mq.matches)); }
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', syncWide); else if (mq.addListener) mq.addListener(syncWide); }
  syncWide();

  // ── Scroll: the column scrolls; #story's scroll API is mapped onto it ─────
  // #story's natural offset inside the column is its distance below the sticky top bar. Mapped:
  //   storyEl.scrollTop            ↔ column.scrollTop, measured from #story's own top
  //   storyEl.getBoundingClientRect → the column's visible area below the top bar
  //   storyEl.scrollHeight / clientHeight → the column's
  //   column 'scroll' events        → re-dispatched on #story
  // so `storyEl.scrollTop = el.top - storyEl.rect.top + storyEl.scrollTop` still lands `el` just
  // under the top bar, and `storyEl.scrollTop = 0` still means "the top of the story".
  var column = document.querySelector('.main-column');
  if (column && typeof storyEl !== 'undefined' && storyEl) {
    var nativeRect = Element.prototype.getBoundingClientRect;
    var headerH = function () {
      var h = document.querySelector('header.hero');
      if (!h) return 0;
      var cs = window.getComputedStyle(h);
      return cs.display === 'none' || cs.position !== 'sticky' ? 0 : nativeRect.call(h).height;
    };
    var storyOffset = function () { return nativeRect.call(storyEl).top - nativeRect.call(column).top + column.scrollTop; };
    Object.defineProperty(storyEl, 'scrollTop', {
      configurable: true,
      get: function () { return Math.max(0, column.scrollTop - storyOffset() + headerH()); },
      set: function (v) { column.scrollTop = Math.max(0, (Number(v) || 0) + storyOffset() - headerH()); },
    });
    Object.defineProperty(storyEl, 'scrollHeight', { configurable: true, get: function () { return column.scrollHeight; } });
    Object.defineProperty(storyEl, 'clientHeight', { configurable: true, get: function () { return Math.max(0, column.clientHeight - headerH()); } });
    storyEl.getBoundingClientRect = function () {
      var r = nativeRect.call(column), hh = headerH();
      return { top: r.top + hh, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: Math.max(0, r.height - hh), x: r.left, y: r.top + hh };
    };
    column.addEventListener('scroll', function () { storyEl.dispatchEvent(new Event('scroll')); }, { passive: true });
  }

  // ── Atmosphere: the scenario's image ──────────────────────────────────────
  var bgDone = false;
  function applyBackground() {
    if (bgDone || typeof scenario === 'undefined' || !scenario) return;
    bgDone = true;
    var img = scenario.image || {};
    var url = img.url || scenario.wide_image_url || scenario.image_url || null;
    if (url) root.style.setProperty('--rl-image', 'url("' + String(url).replace(/["\\\n\r]/g, '') + '")');
    var anchor = Number(img.cropAnchor);
    if (isFinite(anchor)) root.style.setProperty('--rl-image-pos', 'center ' + Math.max(0, Math.min(100, anchor)) + '%');
    var bright = Number(img.brightness);
    if (isFinite(bright) && bright > 0) root.style.setProperty('--rl-veil', String(Math.max(0.4, Math.min(0.8, 0.55 * bright / 100))));
  }
  if (typeof applyRedesignRoleHero === 'function') {
    var origHero = applyRedesignRoleHero;
    applyRedesignRoleHero = function () { var r = origHero.apply(this, arguments); try { applyBackground(); } catch (e) {} return r; };   // eslint-disable-line no-global-assign
  }

  // ── The cast rail ─────────────────────────────────────────────────────────
  var shell = document.querySelector('.app-shell');
  var rail = el('aside', 'rl-rail');
  rail.setAttribute('aria-label', 'Scene');
  if (shell) shell.appendChild(rail);

  var lastSession = null, prevHere = [], gone = {}, openId = null, showAll = false;

  function shortTag(role) {
    var s = String(role || '').split(',')[0].trim();
    return s.length > TAG_MAX ? s.slice(0, TAG_MAX - 1).trimEnd() + '…' : s;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // When: the scene's date; else the in-world clock from sessionStartTime ("HH:MM", 24-hour)
  // plus elapsed minutes; else "Minute N of M".
  function clock() {
    if (typeof currentScene !== 'undefined' && currentScene && currentScene.date) return currentScene.date;
    var elapsed = Math.max(0, Number(gameState.elapsedMinutes) || 0);
    var st = typeof scenario.sessionStartTime === 'string' ? scenario.sessionStartTime.trim() : '';
    var m = st.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      var t = ((+m[1]) * 60 + (+m[2]) + elapsed) % 1440;
      var h = Math.floor(t / 60);
      return ((h % 12) || 12) + ':' + pad(t % 60) + (h < 12 ? ' a.m.' : ' p.m.');
    }
    return 'Minute ' + elapsed + ' of ' + (scenario.sessionTargetMinutes || 15);
  }
  function where() {
    if (typeof currentScene !== 'undefined' && currentScene && typeof sceneShortPlace === 'function') {
      var p = sceneShortPlace(currentScene);
      if (p) return p;
    }
    return typeof getLocationDisplayName === 'function' ? getLocationDisplayName(gameState.location) : '';
  }
  function character(id) {
    var list = (typeof bootstrapData !== 'undefined' && bootstrapData && bootstrapData.characters) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function openHistory() {
    if (typeof buildIntroPanelEl !== 'function') return;
    var panel = buildIntroPanelEl(scenario);
    if (!panel) return;
    var body = panel.querySelector('.intro-panel-content');
    body.hidden = false;
    var c = body.querySelector('.intro-panel-close');
    if (c) c.remove();
    var back = document.activeElement;
    var wrap = el('div', 'rl-panel');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'The history');
    var sheet = el('div', 'rl-panel-sheet');
    var top = el('div', 'rl-panel-top');
    top.appendChild(el('h2', 'rl-panel-title', 'The history'));
    var x = el('button', 'rl-close', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    var close = function () { wrap.remove(); document.removeEventListener('keydown', onKey); if (back && back.isConnected) back.focus(); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    x.addEventListener('click', close);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    top.appendChild(x);
    sheet.appendChild(top);
    sheet.appendChild(body);
    wrap.appendChild(sheet);
    document.body.appendChild(wrap);
    x.focus();
  }

  function update() {
    if (typeof gameState === 'undefined' || !gameState || typeof scenario === 'undefined' || !scenario) { rail.hidden = true; return; }
    rail.hidden = false;
    applyBackground();
    var sid = typeof sessionId !== 'undefined' ? sessionId : null;
    if (sid !== lastSession) { lastSession = sid; prevHere = []; gone = {}; openId = null; showAll = false; }

    // In the scene: present AND introduced, never the player. Departed: dimmed for the turn
    // they leave, then dropped.
    var introduced = gameState.introducedNpcs || [];
    var turn = gameState.turnCount || 0;
    var here = (gameState.presentNpcs || []).filter(function (id) { return introduced.indexOf(id) !== -1 && id !== gameState.playerCharacterId && character(id); });
    prevHere.forEach(function (id) { if (here.indexOf(id) === -1 && gone[id] === undefined) gone[id] = turn; });
    here.forEach(function (id) { delete gone[id]; });
    Object.keys(gone).forEach(function (id) { if (gone[id] !== turn) delete gone[id]; });
    prevHere = here.slice();
    var cast = here.map(function (id) { return { id: id, gone: false }; })
      .concat(Object.keys(gone).map(function (id) { return { id: id, gone: true }; }));

    rail.innerHTML = '';
    var you = el('section', 'rl-block');
    you.appendChild(el('h2', 'rl-label', 'You are'));
    var role = (scenario.playerRoleOptions || []).find(function (r) { return r.id === gameState.playerRoleId; });
    var roleLine = el('p', 'rl-line');
    roleLine.appendChild(el('span', 'rl-role', role && typeof getCardDisplayName === 'function' ? getCardDisplayName(role) : (gameState.playerRoleName || '')));
    // Changing role belongs to the entry only — the cold open (it re-opens the scene) or the
    // direct start before Begin (direct-start.js) — never mid-session.
    var coRole = root.classList.contains('co-active') ? document.querySelector('.co-head .co-role') : null;
    var ds = window.__directStart;
    var changeRole = coRole ? function () { coRole.click(); }
      : (ds && ds.canChangeRole() ? ds.openRoles : null);
    if (changeRole) {
      var ch = el('button', 'rl-change', ' · change role ▾');
      ch.type = 'button';
      ch.setAttribute('aria-haspopup', 'dialog');
      ch.addEventListener('click', changeRole);
      roleLine.appendChild(ch);
    }
    you.appendChild(roleLine);
    var w = where();
    if (w) you.appendChild(el('p', 'rl-line rl-where', w));
    you.appendChild(el('p', 'rl-line rl-when', clock()));
    if (typeof buildIntroPanelEl === 'function' && buildIntroPanelEl(scenario)) {
      var hb = el('button', 'rl-history', 'The history');
      hb.type = 'button';
      hb.setAttribute('aria-haspopup', 'dialog');
      hb.addEventListener('click', openHistory);
      you.appendChild(hb);
    }
    rail.appendChild(you);

    var sc = el('section', 'rl-block');
    sc.appendChild(el('h2', 'rl-label', 'In the scene'));
    if (!cast.length) sc.appendChild(el('p', 'rl-empty', 'No one yet.'));
    else {
      var ul = el('ul', 'rl-cast');
      var visible = showAll ? cast : cast.slice(0, CAST_CAP);
      visible.forEach(function (item) {
        var c = character(item.id);
        var li = el('li', item.gone ? 'rl-gone' : null);
        li.setAttribute('data-npc', item.id);
        var b = el('button', 'rl-npc');
        b.type = 'button';
        b.setAttribute('aria-expanded', String(openId === item.id));
        b.appendChild(el('span', 'rl-npc-name', c.name));
        var tag = shortTag(c.role);
        if (tag) b.appendChild(el('span', 'rl-npc-tag', tag));
        b.addEventListener('click', function () { openId = openId === item.id ? null : item.id; update(); });
        li.appendChild(b);
        if (openId === item.id && c.publicFace) li.appendChild(el('p', 'rl-npc-more', c.publicFace));
        ul.appendChild(li);
      });
      sc.appendChild(ul);
      if (cast.length > CAST_CAP) {
        var more = el('button', 'rl-more', showAll ? 'Show fewer' : '+' + (cast.length - CAST_CAP) + ' more');
        more.type = 'button';
        more.addEventListener('click', function () { showAll = !showAll; update(); });
        sc.appendChild(more);
      }
    }
    rail.appendChild(sc);
  }

  // The rail follows every render: renderOutput runs after the turn's state is adopted (and at
  // the cold open's scene). Restart and role changes come through the same path.
  if (typeof renderOutput === 'function') {
    var origRender = renderOutput;
    renderOutput = function () { var r = origRender.apply(this, arguments); try { update(); } catch (e) {} return r; };   // eslint-disable-line no-global-assign
  }
  update();
  window.__readingLayout = { update: update };
})();
