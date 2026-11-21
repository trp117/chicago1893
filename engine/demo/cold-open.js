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
//   3. Plays the two title screens (the row's `intro`), then dissolves onto the scene.
//      Screen 1: the story's name, place · date, then the wide line (narration, italic).
//      Screen 2: "You are a/an {role}, {unit}", then the character line (quoted).
//      Tap / Enter / Escape skips.
//   4. The first choice or typed action goes through the page's own submitTurn. The /turn
//      request is tagged `coldOpen` here; the server swaps in the baked state. That is the
//      first model call of the session.
(function () {
  'use strict';
  var CO = window.__COLD_OPEN__;
  // DEMO_READING_LAYOUT on (html.rl, set in <head> by readingLayout.js): the scene uses the
  // page's own controls inside the reading column. Off: the standalone column below, unchanged.
  var READING_LAYOUT = document.documentElement.classList.contains('rl');
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
  // Screen 1 (wide shot): title block (name, place · date), then the wide line.
  var s1 = el('div', 'co-screen co-s1');
  var titleBlock = el('div', 'co-title');
  var nameEl = el('p', 'co-name');
  nameEl.setAttribute('role', 'heading');
  nameEl.setAttribute('aria-level', '1');
  var datelineEl = el('p', 'co-dateline');
  titleBlock.appendChild(nameEl);
  titleBlock.appendChild(datelineEl);
  var wideEl = el('p', 'co-wide');
  s1.appendChild(titleBlock);
  s1.appendChild(wideEl);
  // Screen 2 (character): "You are a/an {role}, {unit}", then the character line.
  var s2 = el('div', 'co-screen co-s2');
  var youEl = el('p', 'co-you');
  var charEl = el('p', 'co-character');
  s2.appendChild(youEl);
  s2.appendChild(charEl);
  var skipEl = el('p', 'co-skip', 'Tap to skip');
  overlay.appendChild(s1);
  overlay.appendChild(s2);
  overlay.appendChild(skipEl);
  // Every element that fades on its own, in the order they appear.
  var stagedEls = [titleBlock, wideEl, youEl, charEl, skipEl];
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
        playIntro();
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
    // Reading layout: the page's own input stays — it is the column's input at the cold open
    // and in every turn after it.
    if (!READING_LAYOUT) detachNativeInput();
    document.documentElement.classList.add('co-active');
    if (READING_LAYOUT && window.__readingLayout) window.__readingLayout.update();   // the rail's "change role"
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

  // First live action: the page's header, bottom bar and input come back. The column's own
  // controls go now (no second click mid-turn); the narrative fades and is cleared by the page.
  function goLive() {
    document.querySelectorAll('.co-instruction, .co-choices, .co-foot, .co-input').forEach(function (n) { n.remove(); });
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

  // ── The scene column ─────────────────────────────────────────────────────
  // While the cold open is the screen (html.co-active) the page's header and its pinned bottom
  // bar are hidden (cold-open.css), and the scene is one flowing column in the story feed:
  //   header row (role · change role ▾ | The history) → narrative → instruction → choices →
  //   own input + Send → footer (Another moment · Replay the open).
  // The page's own choices (#choices) are rendered too, by renderOutput, but sit in the hidden
  // bottom bar; the column has its own buttons, which go through the same submitTurn. On the
  // first action the page clears the feed itself, and the header and bottom bar come back.
  function removeChrome() {
    document.querySelectorAll('.co-head, .co-instruction, .co-choices, .co-foot, .co-input').forEach(function (n) { n.remove(); });
  }
  function addToColumn(node) { storyEl.insertBefore(node, scrollHintEl); }
  function addChrome(role) {
    removeChrome();
    var head = el('div', 'co-head');
    var roleBtn = el('button', 'co-role');
    roleBtn.appendChild(el('span', 'co-role-name-label', getCardDisplayName(role)));
    roleBtn.appendChild(el('span', 'co-role-hint', ' · change role ▾'));
    roleBtn.type = 'button';
    roleBtn.setAttribute('aria-haspopup', 'dialog');
    roleBtn.setAttribute('aria-label', 'Role: ' + getCardDisplayName(role) + '. Change role');
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

    if (READING_LAYOUT) {
      // The reading layout's column IS the page's own layout (narrative, then the bottom bar
      // flowing after it): the page's #choices already hold this opening's choices (renderOutput)
      // and its #input-form is the input. Only the instruction (above the choices) and the footer
      // (last) are added — and removed on the first action — so live turns do not reflow.
      choicesAreaWrapEl.insertBefore(el('p', 'co-instruction', content.instruction), choicesAreaWrapEl.firstChild);
      document.querySelector('.bottom-bar').appendChild(buildFooter());
      return;
    }

    addToColumn(el('p', 'co-instruction', content.instruction));
    var list = el('div', 'co-choices');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Choices');
    (content.choices || []).forEach(function (text) {
      var b = el('button', 'choice-btn co-choice', text);
      b.type = 'button';
      b.addEventListener('click', function () { submitTurn(text, { isChoice: true }); });
      list.appendChild(b);
    });
    addToColumn(list);
    var own = buildColdOpenInput();
    if (own) addToColumn(own);
    addToColumn(buildFooter());
  }
  function buildFooter() {
    var foot = el('nav', 'co-foot');
    foot.setAttribute('aria-label', 'More');
    var more = el('a', null, 'Another moment');
    more.href = '/moments';
    var replay = el('button', null, 'Replay the open');
    replay.type = 'button';
    replay.addEventListener('click', function () { restartGame(); });
    foot.appendChild(more);
    foot.appendChild(replay);
    return foot;
  }

  // ── 3. The title screens ─────────────────────────────────────────────────
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
    [s1, s2].concat(stagedEls).forEach(function (n) { n.style.transition = 'none'; n.style.opacity = '0'; });
    s1.style.opacity = '1';
    s2.style.opacity = '1';
  }

  function quoted(line) {
    var s = String(line || '').trim();
    return /^["“‘']/.test(s) ? s : '“' + s + '”';
  }
  // The wide line is narration: shown without quotation marks, even if the row has them.
  function unquoted(line) {
    return String(line || '').trim().replace(/^["“‘']+|["”’']+$/g, '').trim();
  }
  // "a" or "an" by the role's first letter.
  function article(noun) { return /^[aeiou]/i.test(String(noun || '').trim()) ? 'an' : 'a'; }

  function fillIntro(intro) {
    nameEl.textContent = intro.name;
    datelineEl.textContent = intro.place + ' · ' + intro.date;
    wideEl.textContent = unquoted(intro.wide);
    youEl.textContent = '';
    youEl.appendChild(document.createTextNode('You are ' + article(intro.role) + ' '));
    youEl.appendChild(el('span', 'co-you-role', intro.role));
    if (intro.unit) youEl.appendChild(el('span', 'co-you-unit', ', ' + intro.unit));
    charEl.textContent = quoted(intro.character);
  }

  function playIntro() {
    showOverlayBlank();
    var intro = content.intro || {};
    fillIntro(intro);
    var f = fade(T.fade);
    at(T.skipHint || 0, function () { setOpacity(skipEl, '1', f); });
    if (reduced) {
      // Reduced motion: screen 1 whole and at once, then the scene. No staged fades.
      setOpacity(titleBlock, '1', 0);
      setOpacity(wideEl, '1', 0);
      at(T.s1out || 0, dissolve);
      return;
    }
    at(T.titleIn || 0, function () { setOpacity(titleBlock, '1', f); });
    at(T.quoteIn || 0, function () { setOpacity(wideEl, '1', f); });
    at(T.s1out || 0, function () { setOpacity(s1, '0', f); });
    at(T.s2in || 0, function () { setOpacity(youEl, '1', f); });
    at(T.charIn || 0, function () { setOpacity(charEl, '1', f); });
    at(T.s2out || 0, function () { setOpacity(s2, '0', f); });
    at(T.reveal || 0, dissolve);
  }

  function dissolve() {
    if (finishing) return;
    clearTimers();
    finishing = true;
    var d = fade(T.dissolve);
    [s1, s2, skipEl].forEach(function (n) { setOpacity(n, '0', d / 2); });
    setOpacity(overlay, '0', d);
    at(d, function () { overlay.hidden = true; });
  }

  // Skip: any tap on the overlay, or Enter / Space / Escape while it is up. Before the content
  // has arrived a skip just waits for it.
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
        // A role with its own cold open re-opens here; any other goes to the normal start —
        // with the reading layout, the direct start in that role (layout off: unchanged).
        if (ready.indexOf(r.id) !== -1) { roleId = r.id; closePanel(); restartGame(); }
        else location.href = '/game?scenarioId=' + enc(scenario.id) + (READING_LAYOUT ? '&roleId=' + enc(r.id) : '');
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
