let gameState = null;
let scenario = null;

const storyEl = document.getElementById('story');
const choicesEl = document.getElementById('choices');
const formEl = document.getElementById('input-form');
const inputEl = document.getElementById('player-input');

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
  if (Array.isArray(output.npcMoments)) {
    for (const npcMoment of output.npcMoments) {
      html += `<div class="npc-line"><strong>${prettifyId(npcMoment.npc)}:</strong> ${npcMoment.text}</div>`;
    }
  }
  if (meta.mockMode) {
    html += `<div class="npc-line"><em>Running in mock mode until an Anthropic API key is added.</em></div>`;
  }
  addEntry('engine', 'Story', html);
  renderChoices(output.choices || []);
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
