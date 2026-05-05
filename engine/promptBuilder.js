import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as data from './data.js';
import { buildSensoryOpeningRule } from './services/PromptComposer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load behavioral rules from the system prompt template, stripping the
// {{SCENARIO_CONTEXT}} placeholder block so only pure instructions remain.
const _rawTemplate = fs.readFileSync(
  path.join(__dirname, 'prompts/game_system_prompt.md'),
  'utf8'
);
const _templateParts = _rawTemplate.split('{{SCENARIO_CONTEXT}}');
const _preamble      = _templateParts[0].replace(/\n*---\s*$/, '').trim();
const _rulesBody     = _templateParts[1].replace(/^\s*---\n*/, '').trim();

const PLAYER_ACTION_RULE = `PLAYER ACTION RULES:
When player_action is present:
- Reference the player's specific words in the scene response.
  If they whispered, acknowledge they whispered.
  If they used an NPC's name, that NPC reacts to hearing their name.
- If the action is surprising or implausible, NPCs react to that
  specifically before the scene advances. They do not absorb it silently.
- Never skip past what the player said to advance the plot.
- The player's action is the most important thing that just happened.
  Respond to it before anything else.`;

const CHARACTER_BEHAVIOR_RULE = `CHARACTER BEHAVIOR RULES:

Every NPC in this story has something they are doing when the player
finds them. They are not waiting. They are not available. The player
has interrupted something, or they have interrupted the player.

NPCs do not exist to help the player. They have their own problem
that may or may not intersect with the player's problem. Their first
priority is always their own agenda (see privateGoal for each NPC).

NPCs respond to what the player actually said — the specific words,
the tone, whether it matches what they know about this person.
A frightened NPC stays frightened until given a concrete reason
not to be. An NPC hiding something does not reveal it without cost.

When the player says something an NPC finds surprising, implausible,
or threatening, the NPC reacts to that specifically before the scene
moves forward. They do not absorb it and continue.

NPCs never provide exposition unprompted. If an NPC knows something
the player needs, the player must earn it — through trust, through
trade, through cleverness, or through demonstrated knowledge.
Information has a price in every scene.

Every NPC is afraid of something (see fear field) and wants something
(see privateGoal field). Both should be visible in how they speak
and move, even when they say nothing about either directly.

NPCs speak in the language of their world. They do not use
anachronistic vocabulary. They do not explain their world to the
player. They live in it.`;

const NPC_TRUST_RULE = `NPC TRUST AND AGGRESSION:
trust 0-3: NPC is guarded. Gives minimal information. May mislead.
  Voice is clipped. Does not elaborate. Watches the player.
trust 4-6: NPC is neutral. Answers direct questions but does not volunteer.
  Follows their trustLogic field exactly.
trust 7-10: NPC is open. May reveal something from their hiding field
  if the moment feels right and trust has been consistently high.

When aggression_mode is mild: follow mildPressure from aggressionProfile.
When aggression_mode is heavy: follow heavyPressure from aggressionProfile.
Return updated aggression_mode in npc_updates based on player actions.`;

export function buildSystemPrompt(sessionId) {
  const session  = sessionId ? data.getSession(sessionId) : null;
  const scenario = data.getScenario();
  const npcs     = data.getNPCs();

  const locationId     = session?.location ?? scenario.initialState?.location ?? null;
  const currentLocation = locationId ? data.getLocation(locationId) : null;

  const sections = [];

  // ── BEHAVIORAL RULES ──────────────────────────────────────────────────────
  const sensoryRule    = buildSensoryOpeningRule(scenario.sensory_opening);
  const rulesWithSensory = _rulesBody.replace('{{SENSORY_OPENING_RULE}}', sensoryRule);
  const BEHAVIORAL_RULES = `${_preamble}\n\n${rulesWithSensory}\n\n${PLAYER_ACTION_RULE}\n\n${NPC_TRUST_RULE}\n\n${CHARACTER_BEHAVIOR_RULE}`;
  sections.push(`## BEHAVIORAL RULES\n\n${BEHAVIORAL_RULES}`);

  // ── SCENARIO CONTEXT ──────────────────────────────────────────────────────
  const winLines     = (scenario.winConditions     || []).map(c => `- ${c}`).join('\n');
  const failLines    = (scenario.failConditions    || []).map(c => `- ${c}`).join('\n');
  const partialLines = (scenario.partialSuccessExamples || []).map(c => `- ${c}`).join('\n');
  const pressureLines = (scenario.coreSystems?.pressureEvents || []).map(e => `- ${e}`).join('\n');

  sections.push([
    '## SCENARIO CONTEXT',
    `Title: ${scenario.title}`,
    `Premise: ${scenario.premise}`,
    `Tone: ${(scenario.tone || []).join(', ')}`,
    `Historical Realism: ${scenario.historicalRealism}`,
    `Session Target: ${scenario.sessionTargetMinutes} minutes`,
    '',
    'Win Conditions:',
    winLines,
    '',
    'Fail Conditions:',
    failLines,
    '',
    'Partial Success Examples:',
    partialLines,
    '',
    'Pressure Events (inject when player is stuck or pacing lags):',
    pressureLines,
  ].join('\n'));

  // ── WORLD LANGUAGE ───────────────────────────────────────────────────────
  if (scenario.world_language) {
    sections.push(`## WORLD LANGUAGE\n\n${scenario.world_language}`);
  }

  // ── ACTIVE NPCS ───────────────────────────────────────────────────────────
  const npcBlocks = npcs.map(npc => [
    `### ${npc.name} (id: ${npc.id})`,
    `Role: ${npc.role}`,
    `Public Face: ${npc.publicFace}`,
    `Private Goal: ${npc.privateGoal}`,
    `Fear: ${npc.fear}`,
    `Voice: ${npc.voice}`,
    `Trust Logic: ${npc.trustLogic}`,
    `Secrets: ${(npc.secrets || []).join('; ')}`,
    `Aggression Profile: ${JSON.stringify(npc.aggressionProfile, null, 0)}`,
  ].join('\n')).join('\n\n');

  sections.push(`## ACTIVE NPCS\n\n${npcBlocks}`);

  // ── CURRENT LOCATION ──────────────────────────────────────────────────────
  if (currentLocation) {
    sections.push([
      '## CURRENT LOCATION',
      `ID: ${currentLocation.id}`,
      `Name: ${currentLocation.name}`,
      `Description: ${currentLocation.description}`,
      `Mood: ${currentLocation.mood}`,
      `Linked NPCs: ${(currentLocation.linkedNPCs || []).join(', ')}`,
    ].join('\n'));
  } else {
    const locList = data.getLocations()
      .map(l => `- ${l.id}: ${l.name} — ${l.description.slice(0, 90)}`)
      .join('\n');
    sections.push(`## CURRENT LOCATION\n\nApproved locations:\n${locList}`);
  }

  // ── CHARACTER CONTEXT ─────────────────────────────────────────────────────
  if (session) {
    const ctxLines = [
      '## CHARACTER CONTEXT',
      `Role: ${session.playerRoleName || 'Unknown'} (id: ${session.playerRoleId || 'unknown'})`,
      `Access Level: ${session.playerAccessLevel || 'staff'}`,
      `Perspective: ${session.playerPerspective || ''}`,
      `Starting Knowledge: ${(session.playerStartingKnowledge || []).join('; ') || 'none'}`,
    ];
    if (session.playerRealName && session.playerCoverName) {
      const firstName = session.playerRealName.split(' ')[0];
      ctxLines.push('', `CRITICAL IDENTITY NOTE: The player character is ${session.playerRealName}, operating under the cover name ${session.playerCoverName}. These are the same person. ${session.playerRealName} must NEVER appear as a separate NPC, bystander, or named character in any scene. If you are about to write "${firstName}" or "${session.playerRealName}" as someone other than the player, stop — that is the player. Other characters may refer to her as ${session.playerCoverName} or by no name at all depending on what they know. There is one woman. She is the player.`);
    }
    if (session.character_context) {
      ctxLines.push('', 'Character Briefing (player read this before the game started):', session.character_context);
    }
    if (session.player_addition) {
      ctxLines.push('', 'Player Note (carry this into the session):', session.player_addition);
    }
    sections.push(ctxLines.join('\n'));
  }

  // ── NPC STATES ────────────────────────────────────────────────────────────
  if (session) {
    const authorityTrust = session.authorityTrust ?? 0;

    const suspicionLines = Object.entries(session.suspicion || {})
      .map(([id, score]) => {
        const npc = data.getNPC(id);
        return `- ${npc?.name ?? id}: ${score}`;
      }).join('\n') || '- (none elevated)';

    const introducedLines = (session.introducedNpcs || [])
      .map(id => {
        const npc = data.getNPC(id);
        return `- ${npc?.name ?? id}`;
      }).join('\n') || '- (none yet)';

    const npcStateBlocks = session.npc_states
      ? Object.entries(session.npc_states).map(([id, s]) => {
          const npc = data.getNPC(id);
          const name = npc?.name ?? id;
          return [
            `${name} — current session state:`,
            `Trust in player: ${s.trust_level}/10`,
            `Trust logic: ${s.trust_logic}`,
            `Currently wants from player: ${s.wants}`,
            `Currently hiding: ${s.hiding ?? 'nothing disclosed'}`,
            `Last interaction: ${s.last_interaction ?? 'none yet'}`,
            `Aggression mode: ${s.aggression_mode}`,
            `Aggression profile: ${JSON.stringify(s.aggression_profile, null, 0)}`,
          ].join('\n');
        }).join('\n\n')
      : '(not yet initialised)';

    sections.push([
      '## NPC STATES',
      `Authority Trust: ${authorityTrust}`,
      '',
      'Suspicion scores:',
      suspicionLines,
      '',
      'Introduced NPCs (already appeared in session):',
      introducedLines,
      '',
      'Per-NPC session state:',
      npcStateBlocks,
    ].join('\n'));
  }

  return sections.join('\n\n---\n\n');
}
