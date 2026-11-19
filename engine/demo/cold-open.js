// DEMO_COLD_OPEN entry — injected just before </body> of the game page, only when the flag is
// on (demoMode.js injectColdOpenIntoGameHtml). The game page on disk never changes.
//
// It runs after the page script, so it can hook the page's own globals. Every name it relies
// on is in COLD_OPEN_HOOKS; tests/cold-open.test.mjs fails the build if one disappears from
// engine/game/index.html. If any is missing at run time, the visitor goes to the card grid.
//
// What it does, in order:
//   1. Covers the page with the overlay at once (black), before anything else is seen.
//   2. When the page has loaded the scenario (loadGame → renderStreamlinedScreen1, hooked
//      here), reads the opening from /game/api/cold-open — a row read, never a model call —
//      and sets the scene up underneath: lean narrative, instruction, choices, input.
//   3. Plays the two beats, then dissolves onto the scene. Tap / Enter / Escape skips.
//   4. The first choice or typed action goes through the page's own submitTurn. The /turn
//      request is tagged `coldOpen` here; the server swaps in the baked state. That is the
//      first model call of the session.
(function () {
  'use strict';
  var CO = window.__COLD_OPEN__;
  if (!CO) return;

  var COLD_OPEN_HOOKS = ['renderStreamlinedScreen1', 'restartGame', 'submitTurn', 'renderOutput', 'renderChoices',
    'renderSidebar', 'updateLocationDisplay', 'updateCandleIndicator', 'applyFreeInputMode', 'buildClientInitialState',
    'buildIntroPanelEl', 'getCardDisplayName'];
  // Top-level function declarations of a classic script are properties of window. (The page's
  // `let`/`const` globals it also uses — gameState, sessionId, … — are checked by the test.)
  var missing = COLD_OPEN_HOOKS.filter(function (n) { return typeof window[n] !== 'function'; });
  if (missing.length) { try { console.warn('[cold-open] game page hooks missing: ' + missing.join(', ')); } catch (e) {} location.replace('/moments'); return; }

  var T = CO.timings || {};
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var fade = function (ms) { return reduced ? 0 : (ms || 0); };
  var roleId = CO.roleId;
  var content = null;
  var enc = encodeURIComponent;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function goToGrid() { location.replace('/moments'); }

  // ── 1. Overlay, up at once ───────────────────────────────────────────────
  var overlay = el('div');
  overlay.id = 'co-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Opening');
  var beatEls = [0, 1].map(function () {
    var b = el('div', 'co-beat');
    b.appendChild(el('p', 'co-beat-header'));
    b.appendChild(el('p', 'co-beat-line'));
    overlay.appendChild(b);
    return b;
  });
  overlay.appendChild(el('p', 'co-skip', 'Tap to skip'));
  document.body.appendChild(overlay);

  // Back link (“← Stories”) leads to the card grid, not back into this entry.
  var back = document.querySelector('header.hero .back-link');
  if (back) back.setAttribute('href', '/moments');

  // ── 2. Entry: the page calls this once the scenario is loaded (and on restart) ─────────
  renderStreamlinedScreen1 = function () {      // eslint-disable-line no-global-assign
    enter().catch(function (e) { try { console.warn('[cold-open]', e); } catch (x) {} goToGrid(); });
  };

  function enter() {
    document.getElementById('role-overlay').classList.add('hidden');
    showOverlayBlank();
    return fetch('/game/api/cold-open?scenarioId=' + enc(scenario.id) + '&roleId=' + enc(roleId))
      .then(function (resp) { if (!resp.ok) throw new Error('cold-open HTTP ' + resp.status); return resp.json(); })
      .then(function (data) {
        content = data;
        var role = (scenario.playerRoleOptions || []).find(function (r) { return r.id === roleId; });
        if (!role) throw new Error('role ' + roleId + ' not in this scenario');
        setUpScene(role);
        playBeats();
      });
  }

  function setUpScene(role) {
    currentRoleId = role.id;
    applyFreeInputMode(scenario.allow_free_input !== false);
    // Display state only. The server never reads it for the first turn: it uses the baked state.
    gameState = buildClientInitialState(scenario, role);
    gameState.narrativeStyle = 'focused';
    gameState.onboardingFlow = 'streamlined';
    if (content.location) { gameState.location = content.location; gameState.visitedLocations = [content.location]; }
    gameState.__coldOpen = true;
    sessionId = crypto.randomUUID();
    // The model's history starts with the opening as the player read it (the server seeds the
    // first turn the same way); later turns carry it like any other turn until it ages out.
    conversationHistory = [
      { role: 'user', content: CO.historyUser },
      { role: 'assistant', content: String(content.narrative).trim() },
    ];
    var hero = document.querySelector('header.hero');
    if (hero) hero.classList.add('game-active');
    renderSidebar();
    updateLocationDisplay(gameState.location);
    var opening = { narrative: content.narrative, choices: content.choices };
    if (content.scene) opening.scene = content.scene;
    renderOutput(opening, { skipTts: true });
    markEmphasisLines();
    updateCandleIndicator(gameState.remainingMinutes, scenario.sessionTargetMinutes || 15);
    addChrome(role);
    detachNativeInput();
    document.documentElement.classList.add('co-active');
    streamOptionsDots.classList.add('hidden');
    choicesAreaWrapEl.classList.remove('hidden');
    choicesAreaWrapEl.style.transition = '';
    choicesAreaWrapEl.style.opacity = '';
    submitBtn.disabled = false;
    inputEl.disabled = false;
    storyEl.scrollTop = 0;
    // The scene is built under the overlay: the page may now be painted (the overlay covers it).
    document.documentElement.classList.remove('co-pending');
  }

  // ── The input: the cold open's own, below the choices ───────────────────
  // The page's native input form sits ABOVE the choices in the bottom bar; on the cold open it
  // would land between the narrative and the instruction line. It is taken out of the DOM while
  // the cold open is the screen (the page's formEl/inputEl constants keep the element and its
  // listeners) and put back, in place, on the first live action.
  var nativeSlot = null;
  function detachNativeInput() {
    if (nativeSlot || !formEl.isConnected) return;
    nativeSlot = document.createComment('cold-open: native input');
    formEl.replaceWith(nativeSlot);
  }
  function restoreNativeInput() {
    if (!nativeSlot) return;
    nativeSlot.replaceWith(formEl);
    nativeSlot = null;
  }
  function buildColdOpenInput() {
    if (scenario.allow_free_input === false) return null;
    var form = el('form', 'co-input');
    var ta = el('textarea');
    ta.id = 'co-player-input';
    ta.rows = 2;
    ta.placeholder = 'Or write your own…';
    ta.setAttribute('aria-label', 'Write your own move');
    var send = el('button', null, 'Send');
    send.type = 'submit';
    form.appendChild(ta);
    form.appendChild(send);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      submitTurn(text);   // typed: the page sends it as player_action, as with its own input
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    return form;
  }

  // First live action: the cold open's own chrome goes, the page's own input comes back.
  function goLive() {
    document.querySelectorAll('.co-instruction, .co-foot, .co-input').forEach(function (n) { n.remove(); });
    restoreNativeInput();
    document.documentElement.classList.remove('co-active');
  }

  // A paragraph authored wholly in *asterisks* (the engine's own emphasis mark) is meant to read
  // italic — the call line. markupNarrative makes it a lone <em>, which the redesign CSS sets
  // upright like plain narration, so such lines are tagged and kept italic (cold-open.css).
  function markEmphasisLines() {
    var paras = String(content.narrative).split('\n').filter(function (l) { return l.trim(); });
    var cards = storyEl.querySelectorAll('.scene-card');
    var lines = cards.length ? cards[cards.length - 1].querySelectorAll('.line') : [];
    paras.forEach(function (para, i) {
      if (lines[i] && /^\s*\*[^*]+\*\s*$/.test(para)) lines[i].classList.add('co-em');
    });
  }

  // ── Chrome: header row, instruction, footer ──────────────────────────────
  function removeChrome() {
    document.querySelectorAll('.co-head, .co-instruction, .co-foot, .co-input').forEach(function (n) { n.remove(); });
  }
  function addChrome(role) {
    removeChrome();
    var head = el('div', 'co-head');
    var roleBtn = el('button', 'co-role', getCardDisplayName(role) + ' ▾');
    roleBtn.type = 'button';
    roleBtn.setAttribute('aria-haspopup', 'dialog');
    roleBtn.setAttribute('aria-label', 'Role: ' + getCardDisplayName(role) + '. Choose another role');
    roleBtn.addEventListener('click', openRoles);
    head.appendChild(roleBtn);
    if (buildIntroPanelEl(scenario)) {
      var histBtn = el('button', 'co-history', 'The history');
      histBtn.type = 'button';
      histBtn.setAttribute('aria-haspopup', 'dialog');
      histBtn.addEventListener('click', openHistory);
      head.appendChild(histBtn);
    }
    storyEl.insertBefore(head, storyEl.firstChild);

    choicesAreaWrapEl.insertBefore(el('p', 'co-instruction', content.instruction), choicesAreaWrapEl.firstChild);
    var own = buildColdOpenInput();
    if (own) choicesAreaWrapEl.parentNode.insertBefore(own, choicesAreaWrapEl.nextSibling);

    var foot = el('nav', 'co-foot');
    foot.setAttribute('aria-label', 'More');
    var more = el('a', null, 'Another moment');
    more.href = '/moments';
    var replay = el('button', null, 'Replay the open');
    replay.type = 'button';
    replay.addEventListener('click', function () { restartGame(); });
    foot.appendChild(more);
    foot.appendChild(replay);
    document.querySelector('.bottom-bar').appendChild(foot);
  }

  // ── 3. The beats ─────────────────────────────────────────────────────────
  var timers = [];
  var finishing = null;
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function setOpacity(node, value, ms) { node.style.transition = 'opacity ' + ms + 'ms ease'; node.style.opacity = value; }

  function showOverlayBlank() {
    clearTimers();
    finishing = null;
    overlay.hidden = false;
    overlay.style.transition = 'none';
    overlay.style.opacity = '1';
    beatEls.forEach(function (b) { b.style.transition = 'none'; b.style.opacity = '0'; });
  }

  function quoted(line) {
    var s = String(line || '').trim();
    return /^["“‘']/.test(s) ? s : '“' + s + '”';
  }

  function playBeats() {
    showOverlayBlank();
    (content.beats || []).slice(0, 2).forEach(function (beat, i) {
      beatEls[i].querySelector('.co-beat-header').textContent = beat.header;
      beatEls[i].querySelector('.co-beat-line').textContent = quoted(beat.line);
    });
    var t = T.startDelay || 0;
    beatEls.forEach(function (b) {
      at(t, function () { setOpacity(b, '1', fade(T.fadeIn)); });
      t += fade(T.fadeIn) + (T.hold || 0);
      at(t, function () { setOpacity(b, '0', fade(T.fadeOut)); });
      t += fade(T.fadeOut) + (T.gap || 0);
    });
    at(t, dissolve);
  }

  function dissolve() {
    if (finishing) return;
    clearTimers();
    finishing = true;
    beatEls.forEach(function (b) { setOpacity(b, '0', fade(T.fadeOut) / 2); });
    setOpacity(overlay, '0', fade(T.dissolve));
    at(fade(T.dissolve), function () { overlay.hidden = true; });
  }

  // Skip: any tap on the overlay, or Enter / Space / Escape while it is up. Before the content
  // has arrived a skip just waits for it (playBeats is then cut short by the same flag).
  overlay.addEventListener('click', function () { if (content) dissolve(); });
  document.addEventListener('keydown', function (e) {
    if (overlay.hidden || !content) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); dissolve(); }
  });

  // ── Panels: role switcher, the history ───────────────────────────────────
  var openPanelEl = null, panelReturnFocus = null;
  function closePanel() {
    if (!openPanelEl) return;
    openPanelEl.remove();
    openPanelEl = null;
    if (panelReturnFocus && panelReturnFocus.isConnected) panelReturnFocus.focus();
  }
  function openPanel(title, bodyEl) {
    closePanel();
    panelReturnFocus = document.activeElement;
    var wrap = el('div', 'co-panel');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', title);
    var sheet = el('div', 'co-panel-sheet');
    var top = el('div', 'co-panel-top');
    top.appendChild(el('h2', 'co-panel-title', title));
    var x = el('button', 'co-close', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closePanel);
    top.appendChild(x);
    sheet.appendChild(top);
    sheet.appendChild(bodyEl);
    wrap.appendChild(sheet);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closePanel(); });
    document.body.appendChild(wrap);
    openPanelEl = wrap;
    x.focus();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openPanelEl) closePanel(); });

  function openRoles() {
    var ready = (content && content.readyRoles) || [];
    var list = el('ul', 'co-roles');
    (scenario.playerRoleOptions || []).forEach(function (r) {
      var li = el('li');
      var b = el('button');
      b.type = 'button';
      var name = el('span', 'co-role-name', getCardDisplayName(r));
      if (r.id === roleId) { b.setAttribute('aria-current', 'true'); name.appendChild(el('span', 'co-role-tag', 'Current')); }
      b.appendChild(name);
      if (r.description) b.appendChild(el('span', 'co-role-desc', r.description));
      b.addEventListener('click', function () {
        if (r.id === roleId) return closePanel();
        // A role with its own cold open re-opens here; any other goes to the normal start.
        if (ready.indexOf(r.id) !== -1) { roleId = r.id; closePanel(); restartGame(); }
        else location.href = '/game?scenarioId=' + enc(scenario.id);
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    openPanel('Choose your role', list);
  }

  function openHistory() {
    var panel = buildIntroPanelEl(scenario);
    if (!panel) return;
    var body = panel.querySelector('.intro-panel-content');
    body.hidden = false;
    var close = body.querySelector('.intro-panel-close');
    if (close) close.remove();
    openPanel('The history', body);
  }

  // ── 4. First action: tag the /turn request ───────────────────────────────
  // While the session is still on the cold-open display state, the /turn the page sends is the
  // session's first live turn. The server replaces the state and history with its own.
  var pageFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/\/game\/api\/turn(\?|$)/.test(url) && gameState && gameState.__coldOpen && init && typeof init.body === 'string') {
      try {
        var body = JSON.parse(init.body);
        body.coldOpen = { scenarioId: scenario.id, roleId: roleId };
        init = Object.assign({}, init, { body: JSON.stringify(body) });
        goLive();
      } catch (e) {}
    }
    return pageFetch.call(window, input, init);
  };
})();
