// DEMO_READING_LAYOUT direct start — injected before </body> of /game, only when the reading
// layout is on (readingLayout.js injectDirectStartIntoGameHtml). Never on the cold-open page.
// The game page on disk never changes.
//
// Why: with the layout on, /game's own entry is the native #role-overlay (Screen 1: title + role
// cards) and #intro-overlay (Screen 2: the character entry + Enter). Neither is part of the
// reading layout, so a non-baked entry (card grid, "Another moment" → card, the role switcher,
// restart) used to open in the old format. This replaces renderStreamlinedScreen1 — the page
// calls it after loading the scenario and again from restartGame — the way cold-open.js does:
//   1. The role: ?roleId= if it is one of scenario.playerRoleOptions, else the first of them.
//      Restart keeps the role in play.
//   2. Screen 2's character entry (bridge → context → entry paragraphs) is written into the
//      reading column with a Begin button. Both native overlays stay hidden. The bottom bar
//      (choices, input) is hidden until Begin.
//   3. Begin calls the page's own startGame with character_context / active_hook built exactly
//      as Screen 1 builds them. /start fires THERE and nowhere else: never on load or reload,
//      and no warm start — so a daily playthrough slot is spent on Begin, as with today's Enter.
//   4. Until Begin, the rail offers "change role" (and, on narrow screens with no rail, the entry
//      offers it inline): a role panel in the layout's style. Picking a role goes to that role's
//      entry — with DEMO_COLD_OPEN on, / decides (its cold open when ready, else back here);
//      otherwise /game directly.
// Hooks are pinned by tests/reading-layout.test.mjs.
(function () {
  'use strict';
  var root = document.documentElement;
  var DS = window.__DIRECT_START__;
  if (!DS || window.__COLD_OPEN__ || !root.classList.contains('rl')) return;

  var DS_HOOKS = ['renderStreamlinedScreen1', 'startGame', 'restartGame', 'buildClientInitialState', 'buildCharacterHeader',
    'getCardDisplayName', 'updateLocationDisplay', 'feedAppend'];
  var missing = DS_HOOKS.filter(function (n) { return typeof window[n] !== 'function'; });
  // Missing hooks: leave the page's own entry in place (old format, but it works).
  if (missing.length) { try { console.warn('[direct-start] game page hooks missing: ' + missing.join(', ')); } catch (e) {} return; }

  var enc = encodeURIComponent;
  var roleId = null;
  try { roleId = new URLSearchParams(location.search).get('roleId'); } catch (e) {}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function roles() { return (scenario && scenario.playerRoleOptions) || []; }
  function resolveRole() {
    var list = roles();
    return list.find(function (r) { return r.id === roleId; }) || list[0] || null;
  }

  // Screen 1's briefing for the chosen role (engine/game/index.html renderStreamlinedScreen1).
  function briefingFor(role) {
    var hooks = Array.isArray(role.character_hooks) ? role.character_hooks.filter(Boolean) : [];
    var hookIndex = hooks.length > 0 ? Math.floor(Math.random() * hooks.length) : -1;
    var activeHook = hookIndex >= 0 ? hooks[hookIndex] : null;
    var baseBriefing = typeof role.briefing === 'string' && role.briefing.trim() ? role.briefing.trim() : (role.description || '');
    var characterContext = activeHook ? baseBriefing + ' ' + activeHook : baseBriefing;
    return { character_context: characterContext, player_addition: null, active_hook: activeHook };
  }

  // Screen 2's character texts (renderStreamlinedScreen2): bridge → context → entry paragraphs.
  function entryTexts(role) {
    var out = [];
    var bridge = (role.bridge_sentence || '').replace(/^\[DRAFT\]\s*/i, '').trim();
    if (bridge) out.push({ text: bridge, cls: 'ds-bridge' });
    if (role.context_sentence && role.context_sentence.trim()) out.push({ text: role.context_sentence.trim(), cls: 'ds-context' });
    ((scenario.introduction && scenario.introduction.sections) || []).forEach(function (section) {
      if (!section.character_entries) return;
      var vals = Object.keys(section.character_entries).map(function (k) { return section.character_entries[k]; });
      var text = section.character_entries[role.id] || vals[0] || '';
      if (String(text).trim()) out.push({ text: String(text).trim(), cls: 'ds-para' });
    });
    return out;
  }

  // ── Before Begin ──────────────────────────────────────────────────────────
  function canChangeRole() { return root.classList.contains('ds-pre') && roles().length > 1; }
  function endPre() {
    root.classList.remove('ds-pre');
    document.querySelectorAll('.ds-actions').forEach(function (n) { n.remove(); });
    closePanel();
  }

  renderStreamlinedScreen1 = function () {      // eslint-disable-line no-global-assign
    var role = resolveRole();
    if (!role) return;
    roleId = role.id;
    ['role-overlay', 'intro-overlay'].forEach(function (id) { var o = document.getElementById(id); if (o) o.classList.add('hidden'); });

    // Display state only (the rail's "You are"); startGame replaces it, and the server's
    // opening state replaces that.
    currentRoleId = role.id;
    gameState = buildClientInitialState(scenario, role);
    gameState.narrativeStyle = 'focused';
    gameState.onboardingFlow = 'streamlined';
    updateLocationDisplay(gameState.location);
    root.classList.add('ds-pre');

    document.querySelectorAll('.ds-entry').forEach(function (n) { n.remove(); });
    var block = el('div', 'feed-entry ds-entry');
    block.appendChild(el('h2', 'ds-role', buildCharacterHeader(role)));
    entryTexts(role).forEach(function (t) { block.appendChild(el('p', 'ds-p ' + t.cls, t.text)); });
    var actions = el('div', 'ds-actions');
    var begin = el('button', 'ds-begin', 'Begin');
    begin.type = 'button';
    var briefing = briefingFor(role);
    begin.addEventListener('click', function () {
      if (begin.disabled) return;
      begin.disabled = true;
      startGame(role.id, 'focused', briefing);
    });
    actions.appendChild(begin);
    if (roles().length > 1) {
      var change = el('button', 'ds-change', 'Change role');
      change.type = 'button';
      change.addEventListener('click', openRoles);
      actions.appendChild(change);
    }
    block.appendChild(actions);
    feedAppend(block);
    storyEl.scrollTop = 0;
    if (window.__readingLayout) window.__readingLayout.update();
    begin.focus({ preventScroll: true });
  };

  // Every way into a session (Begin, the opening-failure retry) goes through startGame: the
  // entry's controls go with it. The page's own calls resolve to this binding.
  var pageStartGame = startGame;
  startGame = function () {                       // eslint-disable-line no-global-assign
    endPre();
    var r = pageStartGame.apply(this, arguments);
    if (window.__readingLayout) window.__readingLayout.update();
    return r;
  };

  // ── Role panel ────────────────────────────────────────────────────────────
  var panelEl = null, panelReturn = null;
  function closePanel() {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    document.removeEventListener('keydown', onKey);
    if (panelReturn && panelReturn.isConnected) panelReturn.focus();
  }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }
  function roleHref(id) {
    var q = 'scenarioId=' + enc(scenario.id) + '&roleId=' + enc(id);
    return DS.coldOpen ? '/?' + q : '/game?' + q;
  }
  function openRoles() {
    if (!canChangeRole()) return;
    closePanel();
    panelReturn = document.activeElement;
    var wrap = el('div', 'rl-panel ds-panel');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Choose your role');
    var sheet = el('div', 'rl-panel-sheet');
    var top = el('div', 'rl-panel-top');
    top.appendChild(el('h2', 'rl-panel-title', 'Choose your role'));
    var x = el('button', 'rl-close', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closePanel);
    top.appendChild(x);
    sheet.appendChild(top);
    var list = el('ul', 'ds-roles');
    roles().forEach(function (r) {
      var li = el('li');
      var b = el('button');
      b.type = 'button';
      b.setAttribute('data-role', r.id);
      var name = el('span', 'ds-role-name', getCardDisplayName(r));
      if (r.id === roleId) { b.setAttribute('aria-current', 'true'); name.appendChild(el('span', 'ds-role-tag', 'Current')); }
      b.appendChild(name);
      if (r.description) b.appendChild(el('span', 'ds-role-desc', r.description));
      b.addEventListener('click', function () {
        if (r.id === roleId) return closePanel();
        location.href = roleHref(r.id);
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    sheet.appendChild(list);
    wrap.appendChild(sheet);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closePanel(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    panelEl = wrap;
    x.focus();
  }

  // Read by reading-layout.js for the rail's "change role".
  window.__directStart = { canChangeRole: canChangeRole, openRoles: openRoles, roleHref: roleHref };
})();
