let gameState = null;
let scenario = null;
let cluesCatalog = [];
let conversationHistory = []; // [{role:'user',content:...},{role:'assistant',content:...}]
const MAX_HISTORY_TURNS = 4;
let recentScenes = []; // rolling window: last 2 scene HTML strings
let bootstrapData = null;

const storyEl = document.getElementById('story');
const choicesEl = document.getElementById('choices');
const formEl = document.getElementById('input-form');
const inputEl = document.getElementById('player-input');
const ttsBarEl = document.getElementById('tts-bar');
const ttsToggleBtn = document.getElementById('tts-toggle');
const ttsStopBtn = document.getElementById('tts-stop');

// ── TTS ──────────────────────────────────────────────────────────────────────

const synth = window.speechSynthesis;
const ttsSupported = !!synth;

let ttsEnabled = localStorage.getItem('readAloudOn') === 'true';
let audioUnlocked = false;

function setTtsEnabled(val) {
  ttsEnabled = val;
  localStorage.setItem('readAloudOn', String(val));
}
let hasSpokenIntro = false;
let lastSpokenMessageId = 0;
let currentMessageId = 0;
let introText = null;
let lastRenderedSpeakText = '';

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
    ttsStopBtn.innerHTML = `${SVG_STOP_ICON} Stop reading`;
    ttsStopBtn.classList.add('active');
  } else {
    ttsStopBtn.innerHTML = `${SVG_PLAY_ICON} Start reading`;
    ttsStopBtn.classList.remove('active');
  }
}

function setTtsSpeaking(_on) {
  // bar is always visible; state communicated via updateTtsBarUI
}

function ttsSpeakRaw(text) {
  if (!ttsSupported) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(cleanForSpeech(text));
  utt.rate = 0.95;
  utt.onend = () => setTtsSpeaking(false);
  utt.onerror = () => setTtsSpeaking(false);
  synth.speak(utt);
  setTtsSpeaking(true);
}

function ttsStop() {
  if (!ttsSupported) return;
  synth.cancel();
  setTtsSpeaking(false);
}

const beginOverlay = document.getElementById('begin-overlay');
const beginBtn = document.getElementById('begin-btn');

if (!ttsSupported) {
  ttsToggleBtn.remove();
  ttsBarEl.hidden = true;
  beginOverlay.classList.add('hidden');
} else {
  updateTtsToggleUI();
  updateTtsBarUI();

  beginBtn.addEventListener('click', () => {
    audioUnlocked = true;
    updateTtsToggleUI();
    updateTtsBarUI();
    beginOverlay.classList.add('hidden');
    hasSpokenIntro = true;
    if (ttsEnabled && introText) {
      lastSpokenMessageId = currentMessageId;
      ttsSpeakRaw(introText);
    }
  });

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
      ttsSpeakRaw(lastRenderedSpeakText);
    }
    updateTtsBarUI();
    updateTtsToggleUI();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function renderSidebar() {
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

function prettifyId(id) {
  return id.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function renderChoices(choices = []) {
  choicesEl.innerHTML = '';
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.type = 'button';
    btn.textContent = choice;
    btn.addEventListener('click', () => submitTurn(choice));
    choicesEl.appendChild(btn);
  }
}

function renderOutput(output, meta = {}) {
  let html = `<p>${output.narrative}</p>`;
  const speakParts = [output.narrative];

  if (Array.isArray(output.npcMoments)) {
    for (const npcMoment of output.npcMoments) {
      html += `<div class="npc-line"><strong>${prettifyId(npcMoment.npc)}:</strong> ${npcMoment.text}</div>`;
      speakParts.push(`${prettifyId(npcMoment.npc)} says: ${npcMoment.text}`);
    }
  }
  if (meta.mockMode) {
    html += `<div class="npc-line"><em>Running in mock mode until an Anthropic API key is added.</em></div>`;
  }

  recentScenes.push(html);
  if (recentScenes.length > 2) recentScenes = recentScenes.slice(-2);

  storyEl.innerHTML = recentScenes.map((sceneHtml, i) => {
    const isCurrent = i === recentScenes.length - 1;
    const cls = isCurrent ? 'scene-card scene-card--current' : 'scene-card scene-card--previous';
    return `<div class="${cls}">${sceneHtml}</div>`;
  }).join('');
  storyEl.scrollTop = 0;
  renderChoices(output.choices || []);

  const messageId = ++currentMessageId;
  const speakText = speakParts.join(' ');
  lastRenderedSpeakText = speakText;

  if (!hasSpokenIntro) {
    introText = speakText;
  } else if (ttsEnabled && audioUnlocked) {
    setTimeout(() => {
      if (lastSpokenMessageId < messageId) {
        lastSpokenMessageId = messageId;
        ttsSpeakRaw(speakText);
      }
    }, 300);
  }
}

async function loadGame() {
  const response = await fetch('/api/bootstrap');
  bootstrapData = await response.json();
  scenario = bootstrapData.scenario;
  cluesCatalog = bootstrapData.cluesCatalog || [];
  showRoleSelection();
}

function showRoleSelection() {
  const roleOverlay = document.getElementById('role-overlay');
  const roleCardsEl = document.getElementById('role-cards');
  const roleBeginBtn = document.getElementById('role-begin-btn');

  let selectedRoleId = null;

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

  roleBeginBtn.addEventListener('click', () => {
    if (!selectedRoleId) return;
    roleOverlay.classList.add('hidden');
    startGame(selectedRoleId);
  });
}

function startGame(roleId) {
  const role = (scenario.playerRoleOptions || []).find((r) => r.id === roleId);
  gameState = structuredClone(scenario.initialState);
  if (role) {
    gameState.playerRole = role.id;
    gameState.playerRoleName = role.name;
    gameState.location = role.startLocation;
    gameState.visitedLocations = [role.startLocation];
    gameState.startingKnowledge = role.startingKnowledge;
  }
  conversationHistory = [];
  recentScenes = [];
  renderSidebar();
  renderOutput(bootstrapData.opening);
}

function renderEnding(endState) {
  const result = endState.result || 'failure';
  const perf = endState.performance || {};

  const resultLabel = { success: 'SUCCESS', partial: 'PARTIAL SUCCESS', failure: 'FAILURE' }[result] || result.toUpperCase();

  const sections = [];

  if (endState.scene) {
    sections.push(`<div class="ending-scene">${endState.scene.split('\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('')}</div>`);
  }

  if (endState.conspiracySummary) {
    sections.push(`<section class="ending-section"><h3>The Conspiracy</h3><p>${endState.conspiracySummary}</p></section>`);
  }

  if (endState.whatPlayerDiscovered) {
    sections.push(`<section class="ending-section"><h3>What You Uncovered</h3><p>${endState.whatPlayerDiscovered}</p></section>`);
  }

  if (endState.outcome) {
    sections.push(`<section class="ending-section"><h3>Outcome</h3><p>${endState.outcome}</p></section>`);
  }

  if (endState.playerContribution) {
    sections.push(`<section class="ending-section"><h3>Your Role</h3><p>${endState.playerContribution}</p></section>`);
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
  storyEl.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let submitting = false;

function buildAssistantHistoryContent(output) {
  let text = output.narrative || '';
  for (const m of output.npcMoments || []) {
    text += `\n${prettifyId(m.npc)}: ${m.text}`;
  }
  return text.trim();
}

async function submitTurn(playerInput) {
  if (!playerInput?.trim() || submitting) return;
  submitting = true;
  storyEl.innerHTML = '<div class="scene-thinking">&#8230;</div>';
  inputEl.value = '';
  try {
    const response = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: gameState, playerInput, history: conversationHistory })
    });

    const data = await response.json();
    if (data.error) {
      storyEl.innerHTML = `<div class="scene-card scene-error"><p>${data.error}</p></div>`;
      return;
    }

    gameState = data.nextState;

    // Append this exchange to history, keep last MAX_HISTORY_TURNS turns
    conversationHistory.push(
      { role: 'user', content: playerInput },
      { role: 'assistant', content: buildAssistantHistoryContent(data.output) }
    );
    if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
    }

    renderSidebar();
    renderOutput(data.output, { mockMode: data.mockMode });

    if (data.output?.endState?.isEnding) {
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
      if (audioUnlocked && lastRenderedSpeakText) ttsSpeakRaw(lastRenderedSpeakText);
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
    if (isMobile) {
      // Push-to-talk: don't auto-restart. Let the browser's natural silence detection
      // end the session; put the transcript in the input for the user to review and send.
      if (listening) {
        setListening(false);
        inputEl.value = finalTranscript;
      }
      return;
    }
    // Desktop: auto-restart keeps recognition alive through browser silence timeouts.
    // Set postRestartDedup so the first final result of the new session is checked for re-delivery.
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
      // Desktop: stop and auto-submit. Mobile: stop only — user reviews and taps Send.
      stopListening(!isMobile);
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

loadGame();
