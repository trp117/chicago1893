// SPEAKER NAMES — the one way a character id becomes something a person or the model reads.
//
// Character ids are name-shaped (pedro_de_loyola) and the roster's name is the approved label
// ("Household servant"). Prettifying an id is how an anonymized person got their name back:
// the client labelled each history line "Pedro De Loyola:" and the server replayed it to the
// model as its own earlier turn. So a label comes from the roster or it is UNKNOWN_SPEAKER —
// never the id, never a prettified id. The client keeps its own copy of the constant
// (engine/game/index.html); keep the two in step.

export const UNKNOWN_SPEAKER = 'someone';

// The roster label for a character id, else UNKNOWN_SPEAKER.
export function characterLabel(id, characters = []) {
  const c = typeof id === 'string' && id ? (characters || []).find(ch => ch?.id === id) : null;
  const name = typeof c?.name === 'string' ? c.name.trim() : '';
  return name || UNKNOWN_SPEAKER;
}

// Stamp each npcMoment with its resolved `speaker`, so the client labels history and display
// from the roster. `npc` stays as the internal key. Mutates and returns output.
export function attachSpeakerNames(output, characters = []) {
  if (Array.isArray(output?.npcMoments)) {
    output.npcMoments = output.npcMoments.map(m =>
      m && typeof m === 'object' ? { ...m, speaker: characterLabel(m.npc, characters) } : m);
  }
  return output;
}

// "How other characters address the player" lines from a role's known_as map. The key
// "to_player" is labelled with the literal PLAYER_LABEL. Every other key is a character id,
// optionally "to_"-prefixed ({ to_thomas_wren: "Hannah Cross" }), labelled with that character's
// roster name; an id with no roster entry (not in this scenario) is dropped: a line addressed to
// "someone" tells the model nothing.
export const PLAYER_LABEL = 'the player';

export function knownAsLines(knownAs, characters = []) {
  if (!knownAs || typeof knownAs !== 'object') return [];
  return Object.entries(knownAs).flatMap(([who, name]) => {
    const label = who === 'to_player' ? PLAYER_LABEL : characterLabel(String(who).replace(/^to_/, ''), characters);
    return label !== UNKNOWN_SPEAKER && typeof name === 'string' && name.trim() ? [`- ${label}: ${name}`] : [];
  });
}

// The id prettified the way the client's prettifyId did ("pedro_de_loyola" → "Pedro De Loyola").
// Used ONLY to find and replace labels an older client already wrote into history; never to
// produce a label.
function legacyPrettified(id) {
  return id.replaceAll('_', ' ').replace(/\b\w/g, m => m.toUpperCase());
}

// History replayed to the model: assistant lines an older client labelled with a prettified id
// ("Pedro De Loyola: …") are relabelled from the roster. A session already open in a browser
// keeps sending the history it built before the client fix, so this is what closes the leak for
// it. Only whole line-start labels are touched; everything else passes through unchanged.
export function relabelHistory(history = [], characters = []) {
  const labels = (characters || [])
    .filter(c => typeof c?.id === 'string' && c.id)
    .map(c => [legacyPrettified(c.id), characterLabel(c.id, characters)])
    .filter(([from, to]) => from !== to)
    .sort((a, b) => b[0].length - a[0].length);
  if (!labels.length || !Array.isArray(history)) return history;
  return history.map(msg => {
    if (msg?.role !== 'assistant' || typeof msg.content !== 'string') return msg;
    let content = msg.content;
    for (const [from, to] of labels) content = content.split(`\n${from}: `).join(`\n${to}: `);
    return content === msg.content ? msg : { ...msg, content };
  });
}
