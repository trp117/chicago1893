let gameState = null;
let scenario = null;

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
let ttsEnabled = localStorage.getItem('ttsEnabled') === 'true';

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

function updateTtsToggleUI() {
  ttsToggleBtn.innerHTML = ttsEnabled ? SVG_SPEAKER_ON : SVG_SPEAKER_OFF;
  ttsToggleBtn.classList.toggle('active', ttsEnabled);
  ttsToggleBtn.setAttribute('aria-label', ttsEnabled ? 'Disable read-aloud' : 'Enable read-aloud');
  ttsToggleBtn.title = ttsEnabled ? 'Read aloud: on' : 'Read aloud: off';
}

function setTtsSpeaking(on) {
  ttsBarEl.hidden = !on;
}

function ttsSpeak(text) {
  if (!ttsSupported || !ttsEnabled) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(text);
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

if (!ttsSupported) {
  ttsToggleBtn.remove();
} else {
  updateTtsToggleUI();

  ttsToggleBtn.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem('ttsEnabled', ttsEnabled);
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
  for (const clue of gameState.clues) {
    const li = document.createElement('li');
    li.textContent = clue;
    cluesEl.appendChild(li);
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
  ttsSpeak(speakParts.join(' '));
}

async function loadGame() {
  const response = await fetch('/api/bootstrap');
  const data = await response.json();
  scenario = data.scenario;
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
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  let listening = false;

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle('listening', on);
    micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start voice input');
    micBtn.title = on ? 'Listening… (click to stop)' : 'Voice input';
  }

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const current = inputEl.value.trimEnd();
    inputEl.value = current ? current + ' ' + transcript : transcript;
    inputEl.focus();
  };

  recognition.onend = () => setListening(false);

  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      console.warn('Speech recognition error:', event.error);
    }
    setListening(false);
  };

  micBtn.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  });
}

loadGame();
