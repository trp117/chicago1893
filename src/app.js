let gameState = null;
let scenario = null;
let cluesCatalog = [];
let locationsList = [];
let conversationHistory = []; // [{role:'user',content:...},{role:'assistant',content:...}]
const MAX_HISTORY_TURNS = 4;
let locationFeed = [];   // all turns for the current location: [{playerInput, html}]
let feedLocationId = null;
let pendingEntryEl = null; // DOM node holding player input + dots, awaiting AI response
let locationShowing = false; // false = header shows "Chicago, 1893"; true = shows location name
let bootstrapData = null;
let lastChoices = []; // preserved so choices can be restored after time extension

const storyEl = document.getElementById('story');
const choicesEl = document.getElementById('choices');
const arrowLeft = document.querySelector('.choices-arrow--left');
const arrowRight = document.querySelector('.choices-arrow--right');
const formEl = document.getElementById('input-form');
const inputEl = document.getElementById('player-input');
const ttsBarEl = document.getElementById('tts-bar');
const ttsToggleBtn = document.getElementById('tts-toggle');
const ttsStopBtn = document.getElementById('tts-stop');

// ── TTS ──────────────────────────────────────────────────────────────────────

const synth = window.speechSynthesis;
const ttsSupported = true; // Audio element always available; Web Speech API is fallback only

let ttsEnabled = localStorage.getItem('readAloudOn') !== 'false';
let audioUnlocked = false;
let audioEl = null;   // single reusable Audio element, unlocked on first user gesture
let currentAudio = null;

function setTtsEnabled(val) {
  ttsEnabled = val;
  localStorage.setItem('readAloudOn', String(val));
}
let lastSpokenMessageId = 0;
let currentMessageId = 0;
let lastRenderedSpeakText = '';
let pendingTeleprompterEl = null;
let teleprompterRafId = null;

const SVG_SPEAKER_OFF = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M2 6h2l4-4v12l-4-4H2z"/>
  <line x1="11" y1="5.5" x2="15" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="15" y1="5.5" x2="11" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const SVG_SPEAKER_ON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M2 6h2l4-4v12l-4-4H2z"/>
  <path d="M10 6.5a2.5 2.5 0 0 1 0 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
  <path d="M12 4a5.5 5.5 0 0 1 0 8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
</svg>`;

function cleanForSpeech(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/[_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function updateTtsToggleUI() {
  ttsToggleBtn.innerHTML = ttsEnabled ? SVG_SPEAKER_ON : SVG_SPEAKER_OFF;
  ttsToggleBtn.classList.toggle('active', ttsEnabled);
  ttsToggleBtn.setAttribute('aria-label', ttsEnabled ? 'Disable read-aloud' : 'Enable read-aloud');
  ttsToggleBtn.title = ttsEnabled ? 'Read aloud: on' : 'Read aloud: off';
}

const SVG_STOP_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><rect width="10" height="10" rx="2"/></svg>`;
const SVG_PLAY_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><polygon points="0,0 10,5 0,10"/></svg>`;

function updateTtsBarUI() {
  if (ttsEnabled) {
    ttsStopBtn.innerHTML = `${SVG_STOP_ICON} Mute narration`;
    ttsStopBtn.classList.add('active');
  } else {
    ttsStopBtn.innerHTML = `${SVG_PLAY_ICON} Unmute narration`;
    ttsStopBtn.classList.remove('active');
  }
}

function setTtsSpeaking(_on) {
  // bar is always visible; state communicated via updateTtsBarUI
}

function ttsSpeakFallback(text) {
  if (!synth) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(cleanForSpeech(text));
  utt.rate = 0.95;
  utt.onend = () => setTtsSpeaking(false);
  utt.onerror = () => setTtsSpeaking(false);
  synth.speak(utt);
  setTtsSpeaking(true);
}

async function ttsSpeak(text) {
  if (!ttsEnabled) return;
  ttsStop();
  if (!audioEl) { ttsSpeakFallback(text); return; }
  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      console.warn('[TTS] server error', response.status, '— falling back to Web Speech');
      ttsSpeakFallback(text);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    audioEl.src = url;
    audioEl.playbackRate = 1.15;
    audioEl.onended = () => { URL.revokeObjectURL(url); currentAudio = null; setTtsSpeaking(false); };
    audioEl.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; console.warn('[TTS] audio error, falling back'); ttsSpeakFallback(text); };
    currentAudio = audioEl;
    await audioEl.play();
    setTtsSpeaking(true);
    if (pendingTeleprompterEl) { startTeleprompter(pendingTeleprompterEl); pendingTeleprompterEl = null; }
  } catch (err) {
    console.warn('[TTS] play() failed, falling back:', err?.message);
    ttsSpeakFallback(text);
  }
}

function ttsStop() {
  cancelAnimationFrame(teleprompterRafId);
  teleprompterRafId = null;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (synth) synth.cancel();
  setTtsSpeaking(false);
}

function startTeleprompter(sceneEl) {
  if (!sceneEl || !audioEl || !audioEl.duration || !isFinite(audioEl.duration)) return;
  cancelAnimationFrame(teleprompterRafId);

  const startScroll = storyEl.scrollTop;
  const feedRect = storyEl.getBoundingClientRect();
  const entryEl = sceneEl.closest('.feed-entry') || sceneEl;
  const entryRect = entryEl.getBoundingClientRect();
  const scrollDistance = Math.max(0, entryRect.bottom - feedRect.bottom + 16);
  const duration = audioEl.duration;

  function tick() {
    if (!audioEl || audioEl.paused || audioEl.ended) { teleprompterRafId = null; return; }
    storyEl.scrollTop = startScroll + (audioEl.currentTime / duration) * scrollDistance;
    teleprompterRafId = requestAnimationFrame(tick);
  }
  teleprompterRafId = requestAnimationFrame(tick);
}

if (!ttsSupported) {
  ttsToggleBtn.remove();
  ttsBarEl.hidden = true;
} else {
  updateTtsToggleUI();
  updateTtsBarUI();

  ttsToggleBtn.addEventListener('click', () => {
    setTtsEnabled(!ttsEnabled);
    if (!ttsEnabled) ttsStop();
    updateTtsToggleUI();
    updateTtsBarUI();
  });

  // True Start/Stop toggle: changes ttsEnabled AND stops current speech when disabling
  ttsStopBtn.addEventListener('click', () => {
    setTtsEnabled(!ttsEnabled);
    if (!ttsEnabled) {
      ttsStop();
    } else if (audioUnlocked && lastRenderedSpeakText) {
      ttsSpeak(lastRenderedSpeakText);
    }
    updateTtsBarUI();
    updateTtsToggleUI();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function updateChaseUI() {
  const isChasing = !!gameState?.chaseState?.active;
  const turnsLeft = gameState?.chaseState?.turnsRemaining ?? 0;
  document.body.classList.toggle('chase-active', isChasing);
  const bottomActEl = document.getElementById('bottom-act');
  if (bottomActEl) {
    bottomActEl.textContent = isChasing
      ? `CHASE — ${turnsLeft} turn${turnsLeft !== 1 ? 's' : ''} left`
      : `Act ${gameState?.act || 1}`;
  }
  const countdownEl = document.getElementById('countdown');
  if (countdownEl) {
    countdownEl.classList.toggle('countdown--urgent', isChasing || (gameState?.remainingMinutes ?? 0) <= 5);
  }
  const inputEl2 = document.getElementById('player-input');
  if (inputEl2 && !inputEl2.disabled) {
    inputEl2.placeholder = isChasing ? 'What do you do?' : 'What do you do next?';
  }
}

function renderSidebarClues() {
  const cluesEl = document.getElementById('clues');
  cluesEl.innerHTML = '';
  const discoveredIds = gameState.discoveredClueIds || [];
  const clueCountEl = document.getElementById('clue-count');
  if (clueCountEl) clueCountEl.textContent = discoveredIds.length ? `(${discoveredIds.length})` : '';
  if (discoveredIds.length === 0) {
    cluesEl.innerHTML = '<li class="clue-empty">No clues discovered yet.</li>';
  } else {
    for (const id of discoveredIds) {
      const clue = cluesCatalog.find((c) => c.id === id);
      if (!clue) continue;
      const li = document.createElement('li');
      li.className = 'clue-card';
      li.innerHTML = `<span class="clue-category clue-category--${clue.category}">${clue.category}</span><strong class="clue-title">${clue.title}</strong><p class="clue-desc">${clue.description}</p>`;
      cluesEl.appendChild(li);
    }
  }
}

function renderSidebar({ includeClues = true } = {}) {
  document.getElementById('objective').textContent = scenario.goal;
  document.getElementById('location').textContent = prettifyId(gameState.location);
  document.getElementById('act').textContent = `Act ${gameState.act}`;
  document.getElementById('elapsed').textContent = `${gameState.elapsedMinutes} min`;
  document.getElementById('remaining').textContent = `${gameState.remainingMinutes} min`;
  document.getElementById('threat').textContent = String(gameState.threat);
  document.getElementById('trust').textContent = String(gameState.burnhamTrust);

  document.getElementById('bottom-act').textContent = `Act ${gameState.act}`;
  const mins = gameState.remainingMinutes;
  const countdownEl = document.getElementById('countdown');
  if (countdownEl) {
    countdownEl.textContent = `${String(mins).padStart(2, '0')}:00`;
    countdownEl.classList.toggle('countdown--urgent', mins <= 5);
  }

  if (includeClues) renderSidebarClues();
}

function prettifyId(id) {
  return id.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function syncArrows() {
  if (!arrowLeft || !arrowRight) return;
  const { scrollLeft, scrollWidth, clientWidth } = choicesEl;
  arrowLeft.classList.toggle('visible', scrollLeft > 4);
  arrowRight.classList.toggle('visible', scrollLeft + clientWidth < scrollWidth - 4);
}

function renderChoices(choices = []) {
  if (choices.length > 0) lastChoices = choices;
  choicesEl.innerHTML = '';
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.type = 'button';
    btn.textContent = choice;
    btn.addEventListener('click', () => submitTurn(choice));
    choicesEl.appendChild(btn);
  }
  choicesEl.scrollLeft = 0;
  requestAnimationFrame(syncArrows);
}

choicesEl.addEventListener('scroll', syncArrows, { passive: true });
if (arrowLeft)  arrowLeft.addEventListener('click',  () => { choicesEl.scrollBy({ left: -choicesEl.clientWidth * 0.85, behavior: 'smooth' }); });
if (arrowRight) arrowRight.addEventListener('click', () => { choicesEl.scrollBy({ left:  choicesEl.clientWidth * 0.85, behavior: 'smooth' }); });

function markupNarrative(text) {
  const lines = (text || '').split('\n').map(line => {
    if (!line.trim()) return null;
    if (/\*[^*]+\*/.test(line)) return `<span class="line">${line.replace(/\*([^*]+)\*/g, '<em>$1</em>')}</span>`;
    if (/^\w[^:]{0,30}:\s*["']/.test(line)) return `<span class="line dialogue">${line}</span>`;
    return `<span class="line"><em>${line}</em></span>`;
  });
  return lines.filter(Boolean).join('');
}

function renderOutput(output, meta = {}) {
  const narrativeHtml = markupNarrative(output.narrative);
  let html = `<p>${narrativeHtml}</p>`;

  if (meta.mockMode) {
    html += `<div class="npc-line"><em>Running in mock mode until an Anthropic API key is added.</em></div>`;
  }

  // Reset feed when location changes
  const currentLocation = gameState?.location;
  if (currentLocation && currentLocation !== feedLocationId) {
    locationFeed = [];
    feedLocationId = currentLocation;
    storyEl.innerHTML = '';
    pendingEntryEl = null;
  }

  locationFeed.push({ playerInput: meta.playerInput || null, html });

  const sceneEl = document.createElement('div');
  sceneEl.className = 'scene-card';
  sceneEl.innerHTML = html;

  if (pendingEntryEl) {
    // Response arrived — swap dots for the scene card in the existing entry
    pendingEntryEl.querySelector('.thinking-dots')?.remove();
    pendingEntryEl.appendChild(sceneEl);
    pendingEntryEl = null;
  } else {
    // Opening scene (no pending entry) — build a full entry
    const entryEl = document.createElement('div');
    entryEl.className = 'feed-entry';
    entryEl.appendChild(sceneEl);
    storyEl.appendChild(entryEl);
  }

  // Scroll to show top of new scene card, then teleprompter takes over
  pendingTeleprompterEl = sceneEl;
  requestAnimationFrame(() => {
    const newScrollTop = sceneEl.getBoundingClientRect().top
      - storyEl.getBoundingClientRect().top
      + storyEl.scrollTop - 8;
    storyEl.scrollTop = Math.max(0, newScrollTop);
  });

  renderChoices(output.choices || []);

  const messageId = ++currentMessageId;
  lastRenderedSpeakText = output.narrative;

  if (!meta.skipTts && ttsEnabled && audioUnlocked) {
    setTimeout(() => {
      if (lastSpokenMessageId < messageId) {
        lastSpokenMessageId = messageId;
        ttsSpeak(output.narrative);
      }
    }, 300);
  }
}

async function loadGame() {
  const response = await fetch('/api/bootstrap');
  bootstrapData = await response.json();
  scenario = bootstrapData.scenario;
  cluesCatalog = bootstrapData.cluesCatalog || [];
  locationsList = bootstrapData.locations || [];
  showRoleSelection();
}

function showRoleSelection() {
  const roleOverlay = document.getElementById('role-overlay');
  const roleCardsEl = document.getElementById('role-cards');

  // Clear cards and clone begin button to remove stale event listeners on re-use
  roleCardsEl.innerHTML = '';
  const oldBeginBtn = document.getElementById('role-begin-btn');
  const roleBeginBtn = oldBeginBtn.cloneNode(true);
  oldBeginBtn.replaceWith(roleBeginBtn);
  roleBeginBtn.disabled = true;

  let selectedRoleId = null;
  let selectedStyle = 'focused';

  for (const role of scenario.playerRoleOptions || []) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'role-card';
    card.innerHTML = `<span class="role-card-name">${role.name}</span><span class="role-card-desc">${role.description}</span>`;
    card.addEventListener('click', () => {
      selectedRoleId = role.id;
      roleBeginBtn.disabled = false;
      roleCardsEl.querySelectorAll('.role-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    roleCardsEl.appendChild(card);
  }

  roleOverlay.querySelectorAll('.style-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedStyle = btn.dataset.style;
      roleOverlay.querySelectorAll('.style-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  roleBeginBtn.addEventListener('click', () => {
    if (!selectedRoleId) return;
    audioUnlocked = true;
    // Unlock audio for mobile (iOS requires play() inside a user gesture)
    audioEl = new Audio();
    audioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAIARKwAABCxAgAEABAAZGF0YQAAAAA=';
    audioEl.play().catch(() => {});
    updateTtsToggleUI();
    updateTtsBarUI();
    roleOverlay.classList.add('hidden');
    startGame(selectedRoleId, selectedStyle);
  });
}

function restartGame() {
  ttsStop();
  gameState = null;
  audioUnlocked = false;
  audioEl = null;
  conversationHistory = [];
  locationFeed = [];
  feedLocationId = null;
  pendingEntryEl = null;
  pendingTeleprompterEl = null;
  lastChoices = [];
  submitting = false;
  storyEl.innerHTML = '';
  renderChoices([]);
  locationShowing = false;
  const h1 = document.getElementById('header-title');
  if (h1) h1.textContent = 'Chicago, 1893';
  document.getElementById('role-overlay').classList.remove('hidden');
  showRoleSelection();
}

function updateLocationDisplay(locationId) {
  if (!locationShowing) return;
  const h1 = document.getElementById('header-title');
  if (!h1) return;
  const loc = locationsList.find(l => l.id === locationId);
  h1.textContent = loc ? loc.name : locationId;
}

async function startGame(roleId, narrativeStyle) {
  const role = (scenario.playerRoleOptions || []).find((r) => r.id === roleId);
  gameState = structuredClone(scenario.initialState);
  gameState.narrativeStyle = narrativeStyle || 'focused';
  if (role) {
    gameState.playerRoleId = role.id;
    gameState.playerRoleName = role.name;
    gameState.playerAccessLevel = role.accessLevel;
    gameState.playerPerspective = role.perspective;
    gameState.playerStartingKnowledge = role.startingKnowledge;
    gameState.location = role.startLocation;
    gameState.visitedLocations = [role.startLocation];
  }
  // Pre-mark NPCs in the opening scene as introduced so the first turn
  // doesn't re-introduce characters already described in the role opening.
  const startLoc = locationsList.find((l) => l.id === gameState.location);
  gameState.introducedNpcs = (startLoc?.linkedNPCs || []).filter(
    (id) => id !== gameState.playerRoleId
  );

  conversationHistory = [];
  locationFeed = [];
  feedLocationId = null;
  pendingEntryEl = null;
  locationShowing = false;
  const h1 = document.getElementById('header-title');
  if (h1) h1.textContent = 'Chicago, 1893';
  renderSidebar();
  updateLocationDisplay(gameState.location);

  const openingData = bootstrapData.roleOpenings?.[roleId] ?? bootstrapData.opening;

  if (ttsEnabled && audioUnlocked) {
    // Show loading dots while pre-fetching opening audio
    const loadingEl = document.createElement('div');
    loadingEl.className = 'feed-entry';
    const dotsEl = document.createElement('div');
    dotsEl.className = 'thinking-dots';
    dotsEl.innerHTML = '<span></span><span></span><span></span>';
    loadingEl.appendChild(dotsEl);
    storyEl.appendChild(loadingEl);
    storyEl.scrollTop = storyEl.scrollHeight;

    // Pre-fetch audio
    let audioBlobUrl = null;
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: openingData.narrative })
      });
      if (resp.ok) {
        const blob = await resp.blob();
        audioBlobUrl = URL.createObjectURL(blob);
      }
    } catch {}

    // Dots gone — render scene and play audio simultaneously
    loadingEl.remove();
    renderOutput(openingData, { skipTts: true });

    if (audioBlobUrl && audioEl) {
      const url = audioBlobUrl;
      audioEl.src = url;
      audioEl.playbackRate = 1.15;
      audioEl.onended = () => { URL.revokeObjectURL(url); currentAudio = null; setTtsSpeaking(false); };
      audioEl.onerror = () => { URL.revokeObjectURL(url); currentAudio = null; ttsSpeakFallback(openingData.narrative); };
      currentAudio = audioEl;
      try {
        await audioEl.play();
        setTtsSpeaking(true);
        if (pendingTeleprompterEl) { startTeleprompter(pendingTeleprompterEl); pendingTeleprompterEl = null; }
      } catch (err) {
        console.warn('[TTS] opening play() failed:', err?.message);
        ttsSpeakFallback(openingData.narrative);
      }
    } else {
      ttsSpeakFallback(openingData.narrative);
    }
  } else {
    renderOutput(openingData);
  }
}

function renderEnding(endState) {
  const result = endState.result || 'failure';
  const perf = endState.performance || {};

  const resultLabel = { success: 'CASE CLOSED', partial: 'INCOMPLETE', failure: 'CASE UNSOLVED' }[result] || result.toUpperCase();

  const sections = [];

  if (endState.scene) {
    sections.push(`<div class="ending-scene">${endState.scene.split('\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('')}</div>`);
  }

  if (endState.conspiracySummary) {
    sections.push(`<section class="ending-section"><h3>The Hidden Plot</h3><p>${endState.conspiracySummary}</p></section>`);
  }

  if (endState.whatPlayerDiscovered) {
    sections.push(`<section class="ending-section"><h3>What You Uncovered</h3><p>${endState.whatPlayerDiscovered}</p></section>`);
  }

  if (endState.outcome) {
    sections.push(`<section class="ending-section"><h3>The Aftermath</h3><p>${endState.outcome}</p></section>`);
  }

  if (endState.playerContribution) {
    sections.push(`<section class="ending-section"><h3>Your Part in It</h3><p>${endState.playerContribution}</p></section>`);
  }

  if (endState.burnhamResponse) {
    sections.push(`<section class="ending-section ending-burnham"><blockquote>\u201c${endState.burnhamResponse}\u201d</blockquote><cite>\u2014 Daniel Burnham</cite></section>`);
  }

  if (perf.cluesDiscovered !== undefined) {
    const correct = endState.correctSuspectIdentified;
    sections.push(`<div class="ending-stats">
      <div class="ending-stat"><span class="ending-stat-label">Clues Found</span><span class="ending-stat-value">${perf.cluesDiscovered} / ${perf.totalClues}</span></div>
      <div class="ending-stat"><span class="ending-stat-label">Suspect Identified</span><span class="ending-stat-value">${correct ? 'Yes' : 'No'}</span></div>
      <div class="ending-stat"><span class="ending-stat-label">Time Remaining</span><span class="ending-stat-value">${perf.timeRemaining} min</span></div>
      <div class="ending-stat"><span class="ending-stat-label">Outcome</span><span class="ending-stat-value ending-result--${result}">${resultLabel}</span></div>
    </div>`);
  }

  const card = document.createElement('div');
  card.className = `ending-card ending-card--${result}`;
  card.innerHTML = `<div class="ending-header"><span class="ending-result ending-result--${result}">${resultLabel}</span></div>${sections.join('')}`;

  const playAgainBtn = document.createElement('button');
  playAgainBtn.type = 'button';
  playAgainBtn.className = 'play-again-btn';
  playAgainBtn.textContent = 'New Game';
  playAgainBtn.addEventListener('click', restartGame);
  card.appendChild(playAgainBtn);

  storyEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let submitting = false;

function showTimeDecision() {
  renderChoices([]);

  const panel = document.createElement('div');
  panel.className = 'time-decision';

  const label = document.createElement('p');
  label.className = 'time-decision-label';
  label.textContent = 'Time has run out. The exposition opens at dawn.';
  panel.appendChild(label);

  const extendBtn = document.createElement('button');
  extendBtn.type = 'button';
  extendBtn.className = 'choice-btn';
  extendBtn.textContent = 'Push on — extend the investigation (+5 minutes, harder conditions)';
  extendBtn.addEventListener('click', () => {
    gameState.remainingMinutes = 5;
    gameState.extensionUsed = true;
    gameState.timeExpired = false;
    gameState.flags = gameState.flags || {};
    gameState.flags.overtime = true;

    // Inject a brief overtime narrative beat into the feed
    const overtimeEl = document.createElement('div');
    overtimeEl.className = 'feed-entry';
    const sceneEl = document.createElement('div');
    sceneEl.className = 'scene-card';
    sceneEl.innerHTML = `<p><span class="line"><em>*Five minutes. The exposition opens at dawn — there is no more room for error.*</em></span></p>`;
    overtimeEl.appendChild(sceneEl);
    storyEl.appendChild(overtimeEl);
    storyEl.scrollTop = storyEl.scrollHeight;

    renderSidebar();
    updateChaseUI();
    inputEl.disabled = false;
    formEl.querySelector('button[type="submit"]').disabled = false;
    renderChoices(lastChoices); // restore the choices from before time ran out
  });

  const concludeBtn = document.createElement('button');
  concludeBtn.type = 'button';
  concludeBtn.className = 'choice-btn';
  concludeBtn.textContent = 'Make your final accusation — name the suspect and state your case';
  concludeBtn.addEventListener('click', () => {
    gameState.finalAccusation = true;
    choicesEl.innerHTML = '';
    inputEl.disabled = false;
    formEl.querySelector('button[type="submit"]').disabled = false;
    inputEl.placeholder = 'Name your suspect and state your case…';
    inputEl.focus();
  });

  panel.appendChild(extendBtn);
  panel.appendChild(concludeBtn);
  choicesEl.appendChild(panel);

  inputEl.disabled = true;
  formEl.querySelector('button[type="submit"]').disabled = true;
}

function buildAssistantHistoryContent(output) {
  let text = output.narrative || '';
  for (const m of output.npcMoments || []) {
    text += `\n${prettifyId(m.npc)}: ${m.text}`;
  }
  return text.trim();
}

async function submitTurn(playerInput) {
  if (!playerInput?.trim() || submitting) return;
  if (gameState?.remainingMinutes <= 0 && !gameState.extensionUsed && !gameState.finalAccusation) {
    gameState.timeExpired = true;
    showTimeDecision();
    return;
  }
  submitting = true;
  inputEl.value = '';

  // Immediately show player input + pulsing dots
  const entryEl = document.createElement('div');
  entryEl.className = 'feed-entry';
  const playerEl = document.createElement('div');
  playerEl.className = 'player-turn';
  playerEl.textContent = playerInput;
  entryEl.appendChild(playerEl);
  const dotsEl = document.createElement('div');
  dotsEl.className = 'thinking-dots';
  dotsEl.innerHTML = '<span></span><span></span><span></span>';
  entryEl.appendChild(dotsEl);
  storyEl.appendChild(entryEl);
  storyEl.scrollTop = storyEl.scrollHeight;
  pendingEntryEl = entryEl;

  try {
    const response = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: gameState, playerInput, history: conversationHistory })
    });

    const data = await response.json();
    if (data.error) {
      dotsEl.remove();
      const errEl = document.createElement('div');
      errEl.className = 'scene-card scene-error';
      errEl.innerHTML = `<p>${data.error}</p>`;
      entryEl.appendChild(errEl);
      pendingEntryEl = null;
      return;
    }

    gameState = data.nextState;
    locationShowing = true;
    updateLocationDisplay(gameState.location);

    // Append this exchange to history, keep last MAX_HISTORY_TURNS turns
    conversationHistory.push(
      { role: 'user', content: playerInput },
      { role: 'assistant', content: buildAssistantHistoryContent(data.output) }
    );
    if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
    }

    renderSidebar({ includeClues: false });
    updateChaseUI();
    renderOutput(data.output, { mockMode: data.mockMode, playerInput });
    renderSidebarClues(); // update clues after narrative so reveal lands first

    if (gameState.remainingMinutes <= 0 && !gameState.extensionUsed && !gameState.finalAccusation) {
      gameState.timeExpired = true;
      showTimeDecision();
    } else if (data.output?.endState?.isEnding) {
      formEl.querySelector('button').disabled = true;
      inputEl.disabled = true;
      renderChoices([]);
      renderEnding(data.output.endState);
    }
  } finally {
    submitting = false;
  }
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitTurn(inputEl.value);
});

// Enter submits, Shift+Enter inserts newline
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

// Voice input
const micBtn = document.getElementById('mic-btn');
const drivingBtn = document.getElementById('driving-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  micBtn.remove();
  drivingBtn.remove();
} else {
  // Mobile browsers re-deliver finalized results on restart and mishandle continuous mode,
  // causing word doubling. Use push-to-talk (single-shot) on mobile instead.
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  const recognition = new SpeechRecognition();
  recognition.continuous = !isMobile;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let listening = false;
  let finalTranscript = '';
  let restartScheduled = false;
  // After a restart, Chrome often re-delivers the last finalized result. This flag
  // triggers a one-shot duplicate check on the first final chunk of the new session.
  let postRestartDedup = false;
  // Prevents the same text being submitted twice if onend fires after a manual stop+submit.
  let submissionLock = false;

  let drivingMode = false;
  let drivingTimer = null;

  function safeSend(text) {
    if (submissionLock) return;
    submissionLock = true;
    Promise.resolve(submitTurn(text)).finally(() => { submissionLock = false; });
  }

  const VOICE_COMMANDS = {
    'send': () => {
      if (finalTranscript.trim()) {
        const text = finalTranscript.trim();
        finalTranscript = '';
        inputEl.value = '';
        safeSend(text);
      }
    },
    'stop reading': () => {
      setTtsEnabled(false);
      ttsStop();
      updateTtsBarUI();
      updateTtsToggleUI();
    },
    'start reading': () => {
      setTtsEnabled(true);
      if (audioUnlocked && lastRenderedSpeakText) ttsSpeak(lastRenderedSpeakText);
      updateTtsBarUI();
      updateTtsToggleUI();
    },
    'notes': () => openNotes(),
  };

  function checkVoiceCommand(chunk) {
    const normalized = chunk.trim().toLowerCase().replace(/[.,!?]+$/, '');
    const handler = VOICE_COMMANDS[normalized];
    if (handler) { handler(); return true; }
    return false;
  }

  function appendFinalChunk(chunk) {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    if (postRestartDedup) {
      postRestartDedup = false;
      // Skip if this chunk was already committed before the restart
      if (finalTranscript.trimEnd().toLowerCase().endsWith(trimmed.toLowerCase())) return;
    }
    const sep = finalTranscript && !finalTranscript.endsWith(' ') ? ' ' : '';
    finalTranscript += sep + trimmed;
  }

  function resetDrivingTimer() {
    clearTimeout(drivingTimer);
    if (!finalTranscript.trim()) return;
    drivingTimer = setTimeout(() => {
      const text = finalTranscript.trim();
      if (text && drivingMode) {
        finalTranscript = '';
        inputEl.value = '';
        safeSend(text);
      }
    }, 2500);
  }

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle('listening', on);
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start voice input');
    micBtn.title = on ? 'Listening… (click to stop)' : 'Voice input';
  }

  function startRecognition() {
    recognition.continuous = drivingMode || !isMobile;
    try { recognition.start(); } catch { /* already running */ }
  }

  function stopListening(autoSubmit = false) {
    clearTimeout(drivingTimer);
    setListening(false);
    restartScheduled = false;
    postRestartDedup = false;
    recognition.stop();
    inputEl.value = finalTranscript;
    if (autoSubmit && finalTranscript.trim()) {
      const text = finalTranscript.trim();
      finalTranscript = '';
      safeSend(text);
    }
  }

  function setDrivingMode(on) {
    drivingMode = on;
    drivingBtn.classList.toggle('active', on);
    drivingBtn.setAttribute('aria-label', on ? 'Disable driving mode' : 'Enable driving mode');
    drivingBtn.title = on ? 'Driving mode: on' : 'Driving mode';
    if (on) {
      if (!listening) {
        finalTranscript = inputEl.value.trimEnd();
        setListening(true);
        startRecognition();
      }
    } else {
      clearTimeout(drivingTimer);
      if (listening) stopListening(false);
    }
  }

  recognition.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        if (drivingMode && checkVoiceCommand(chunk)) {
          postRestartDedup = false; // command consumed the chunk
        } else {
          appendFinalChunk(chunk);
        }
      } else {
        interimTranscript += chunk;
      }
    }
    // Show finalized text + live interim so user can see and edit before sending
    const sep = finalTranscript && interimTranscript && !finalTranscript.endsWith(' ') ? ' ' : '';
    inputEl.value = finalTranscript + (interimTranscript ? sep + interimTranscript : '');
    if (drivingMode) resetDrivingTimer();
  };

  recognition.onend = () => {
    if (isMobile && !drivingMode) {
      // Push-to-talk on mobile: don't auto-restart.
      if (listening) {
        setListening(false);
        inputEl.value = finalTranscript;
      }
      return;
    }
    // Desktop or driving mode: auto-restart keeps recognition alive through silence timeouts.
    if (listening && !restartScheduled) {
      restartScheduled = true;
      setTimeout(() => {
        restartScheduled = false;
        if (listening) {
          postRestartDedup = true;
          startRecognition();
        }
      }, 150);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    console.warn('Speech recognition error:', event.error);
    setListening(false);
    restartScheduled = false;
    postRestartDedup = false;
  };

  micBtn.addEventListener('click', () => {
    if (listening) {
      stopListening(drivingMode || !isMobile);
    } else {
      finalTranscript = inputEl.value.trimEnd(); // preserve any text the user typed
      setListening(true);
      startRecognition();
    }
  });

  // In standard mode, form submit stops the mic (driving mode keeps it running)
  formEl.addEventListener('submit', () => {
    if (listening && !drivingMode) stopListening();
  }, { capture: true });

  drivingBtn.addEventListener('click', () => setDrivingMode(!drivingMode));

  // Overlay drive button on role selection screen — sets flag without starting mic yet
  const overlayDriveBtn = document.getElementById('overlay-drive-btn');
  if (overlayDriveBtn) {
    overlayDriveBtn.addEventListener('click', () => {
      drivingMode = !drivingMode;
      drivingBtn.classList.toggle('active', drivingMode);
      overlayDriveBtn.classList.toggle('active', drivingMode);
      overlayDriveBtn.textContent = drivingMode ? '🚗 Drive: On' : '🚗 Drive';
    });
  }
}

// ── Case Notes ───────────────────────────────────────────────────────────────

const notesBtn = document.getElementById('notes-btn');
const notesOverlay = document.getElementById('notes-overlay');
const notesCloseBtn = document.getElementById('notes-close');
const notesContentEl = document.getElementById('notes-content');

function openNotes() {
  notesOverlay.classList.remove('hidden');
  notesContentEl.innerHTML = '<p class="notes-loading">Gathering your thoughts\u2026</p>';
  fetchNotes();
}

function closeNotes() {
  notesOverlay.classList.add('hidden');
}

async function fetchNotes() {
  try {
    const response = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: gameState })
    });
    const data = await response.json();
    if (data.error) {
      notesContentEl.innerHTML = `<p class="notes-error">${data.error}</p>`;
      return;
    }
    renderNotes(data.notes);
  } catch {
    notesContentEl.innerHTML = '<p class="notes-error">Could not load notes.</p>';
  }
}

function renderNotes(notes) {
  const sections = [];

  if (notes.clues?.length) {
    const items = notes.clues.map((c) => `<li><strong>${c.title}</strong> — ${c.significance}</li>`).join('');
    sections.push(`<section class="notes-section"><h3>Clues Found</h3><ul>${items}</ul></section>`);
  }

  if (notes.suspicions?.length) {
    const items = notes.suspicions.map((s) =>
      `<li><span class="suspicion-badge suspicion--${s.level}">${s.level}</span> <strong>${s.name}</strong> — ${s.reasoning}</li>`
    ).join('');
    sections.push(`<section class="notes-section"><h3>Suspicions</h3><ul>${items}</ul></section>`);
  }

  if (notes.characterImpressions?.length) {
    const items = notes.characterImpressions.map((c) =>
      `<li><strong>${c.name}</strong> — ${c.impression}</li>`
    ).join('');
    sections.push(`<section class="notes-section"><h3>Impressions</h3><ul>${items}</ul></section>`);
  }

  if (notes.openQuestions?.length) {
    const items = notes.openQuestions.map((q) => `<li>${q}</li>`).join('');
    sections.push(`<section class="notes-section"><h3>Open Questions</h3><ul>${items}</ul></section>`);
  }

  if (notes.nextLeads?.length) {
    const items = notes.nextLeads.map((l) => `<li>${l}</li>`).join('');
    sections.push(`<section class="notes-section"><h3>Next Leads</h3><ul>${items}</ul></section>`);
  }

  notesContentEl.innerHTML = sections.length
    ? sections.join('')
    : '<p class="notes-empty">Nothing to report yet. Keep investigating.</p>';
}

document.getElementById('new-game-btn').addEventListener('click', restartGame);
notesBtn.addEventListener('click', openNotes);
notesCloseBtn.addEventListener('click', closeNotes);
notesOverlay.addEventListener('click', (e) => { if (e.target === notesOverlay) closeNotes(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotes(); });

// ── Auto Test ────────────────────────────────────────────────────────────────

const AUTO_TEST_SCRIPT = [
  "Examine the shipping manifest on Burnham's desk",
  "Ask Burnham who authorized the rerouting and whether he trusts his own procurement staff",
  "Go to the freight yards to find the diverted crates",
  "Question the watchman about the after-hours delivery",
  "Head to Machinery Hall and inspect the wiring diagrams for tampering",
  "Return to Burnham and accuse Émile Mercier and Patrick Hanrahan as the conspirators",
];

const autotestBtnEl = document.getElementById('autotest-btn');
const autotestBarEl = document.getElementById('autotest-bar');
const autotestStopBtnEl = document.getElementById('autotest-stop-btn');

let autoTestRunning = false;
let autoTestStepIndex = 0;
let autoTestTimer = null;
const autoTestLog = { steps: [], startedAt: null, endedAt: null, stopReason: null };

function setAutoTestUI(running) {
  autotestBtnEl.classList.toggle('active', running);
  autotestBarEl.hidden = true;
  inputEl.disabled = running;
  formEl.querySelector('button[type="submit"]').disabled = running;
}

function stopAutoTest(reason = 'stopped') {
  autoTestRunning = false;
  clearTimeout(autoTestTimer);
  autoTestLog.endedAt = Date.now();
  autoTestLog.stopReason = reason;
  setAutoTestUI(false);

  const blob = new Blob([JSON.stringify(autoTestLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autotest-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function runAutoTestStep() {
  if (!autoTestRunning) return;

  let input;
  if (autoTestStepIndex < AUTO_TEST_SCRIPT.length) {
    input = AUTO_TEST_SCRIPT[autoTestStepIndex];
  } else {
    const firstChoice = choicesEl.querySelector('.choice-btn');
    if (firstChoice) {
      input = firstChoice.textContent.trim();
    } else {
      stopAutoTest('no-more-steps');
      return;
    }
  }

  autoTestStepIndex++;

  const step = {
    step: autoTestStepIndex,
    input,
    timestamp: Date.now(),
    cluesBefore: [...(gameState?.discoveredClueIds || [])],
  };
  autoTestLog.steps.push(step);

  await submitTurn(input);

  step.cluesAfter = [...(gameState?.discoveredClueIds || [])];
  step.newClues = step.cluesAfter.filter(id => !step.cluesBefore.includes(id));

  const sceneCards = storyEl.querySelectorAll('.scene-card');
  step.narrative = sceneCards[sceneCards.length - 1]?.textContent?.trim() || '';

  if (storyEl.querySelector('.ending-card')) {
    step.isEnding = true;
    step.endingSummary = storyEl.querySelector('.ending-card')?.textContent?.trim() || '';
    stopAutoTest('ending-reached');
    return;
  }

  if (autoTestRunning) {
    autoTestTimer = setTimeout(runAutoTestStep, 3000);
  }
}

function startAutoTest() {
  autoTestStepIndex = 0;
  Object.assign(autoTestLog, { steps: [], startedAt: Date.now(), endedAt: null, stopReason: null });
  autoTestRunning = true;
  setAutoTestUI(true);
  autoTestTimer = setTimeout(runAutoTestStep, 3000);
}

autotestBtnEl.addEventListener('click', () => {
  if (autoTestRunning) stopAutoTest('user-stopped');
  else startAutoTest();
});

// ─────────────────────────────────────────────────────────────────────────────

window.__setTime = (n) => { if (gameState) { gameState.remainingMinutes = n; gameState.elapsedMinutes = 20 - n; } };

loadGame();
