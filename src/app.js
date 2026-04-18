let gameState = null;
let scenario = null;
let cluesCatalog = [];

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

let ttsEnabled = false;
let audioUnlocked = false;
let hasSpokenIntro = false;
let lastSpokenMessageId = 0;
let currentMessageId = 0;
let introText = null;

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

function setTtsSpeaking(on) {
  ttsBarEl.hidden = !on;
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
  beginOverlay.classList.add('hidden');
} else {
  updateTtsToggleUI();

  beginBtn.addEventListener('click', () => {
    audioUnlocked = true;
    ttsEnabled = true;
    updateTtsToggleUI();
    beginOverlay.classList.add('hidden');
    if (introText && !hasSpokenIntro) {
      hasSpokenIntro = true;
      lastSpokenMessageId = currentMessageId;
      ttsSpeakRaw(introText);
    }
  });

  ttsToggleBtn.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    if (!ttsEnabled) ttsStop();
    updateTtsToggleUI();
  });

  ttsStopBtn.addEventListener('click', ttsStop);
}

// ─────────────────────────────────────────────────────────────────────────────

function addEntry(kind, title, html) {
  const div = document.createElement('div');
  div.className = `entry ${kind}`;
  div.innerHTML = `<div class="meta">${title}</div><div>${html}</div>`;
  storyEl.appendChild(div);
  storyEl.scrollTop = storyEl.scrollHeight;
}

function renderSidebar() {
  document.getElementById('objective').textContent = scenario.goal;
  document.getElementById('location').textContent = prettifyId(gameState.location);
  document.getElementById('act').textContent = `Act ${gameState.act}`;
  document.getElementById('elapsed').textContent = `${gameState.elapsedMinutes} min`;
  document.getElementById('remaining').textContent = `${gameState.remainingMinutes} min`;
  document.getElementById('threat').textContent = String(gameState.threat);
  document.getElementById('trust').textContent = String(gameState.burnhamTrust);

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
  addEntry('engine', 'Story', html);
  renderChoices(output.choices || []);

  const messageId = ++currentMessageId;
  const speakText = speakParts.join(' ');

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
  const data = await response.json();
  scenario = data.scenario;
  cluesCatalog = data.cluesCatalog || [];
  gameState = data.state;
  renderSidebar();
  renderOutput(data.opening);
}

async function submitTurn(playerInput) {
  if (!playerInput?.trim()) return;
  addEntry('player', 'You', `<p>${playerInput}</p>`);
  inputEl.value = '';

  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: gameState, playerInput })
  });

  const data = await response.json();
  if (data.error) {
    addEntry('engine', 'Error', `<p>${data.error}</p>`);
    return;
  }

  gameState = data.nextState;
  renderSidebar();
  renderOutput(data.output, { mockMode: data.mockMode });

  if (data.output?.endState?.isEnding) {
    formEl.querySelector('button').disabled = true;
    inputEl.disabled = true;
    renderChoices([]);
  }
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitTurn(inputEl.value);
});

// Voice input
const micBtn = document.getElementById('mic-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  micBtn.remove();
} else {
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let listening = false;
  let confirmedText = '';  // base text + all finalized speech chunks
  let restartScheduled = false;

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle('listening', on);
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start voice input');
    micBtn.title = on ? 'Listening… (click to stop)' : 'Voice input';
  }

  function startRecognition() {
    try { recognition.start(); } catch { /* already running */ }
  }

  function stopListening() {
    setListening(false);
    restartScheduled = false;
    recognition.stop();
    inputEl.value = confirmedText;
  }

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const sep = confirmedText && !confirmedText.endsWith(' ') ? ' ' : '';
        confirmedText += sep + chunk;
      } else {
        interim += chunk;
      }
    }
    const sep = confirmedText && interim && !confirmedText.endsWith(' ') ? ' ' : '';
    inputEl.value = confirmedText + (interim ? sep + interim : '');
  };

  // Auto-restart on unexpected end (browser cuts off after silence on mobile/some desktop)
  recognition.onend = () => {
    if (listening && !restartScheduled) {
      restartScheduled = true;
      setTimeout(() => {
        restartScheduled = false;
        if (listening) startRecognition();
      }, 150);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    console.warn('Speech recognition error:', event.error);
    setListening(false);
    restartScheduled = false;
  };

  micBtn.addEventListener('click', () => {
    if (listening) {
      stopListening();
    } else {
      confirmedText = inputEl.value.trimEnd();
      setListening(true);
      startRecognition();
    }
  });

  // Stop mic when the form is submitted
  formEl.addEventListener('submit', () => {
    if (listening) stopListening();
  }, { capture: true });
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

// ─────────────────────────────────────────────────────────────────────────────

loadGame();
