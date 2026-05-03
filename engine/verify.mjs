// Integration verification — run with: node engine/verify.mjs
import * as data from './data.js';
import { buildSystemPrompt } from './promptBuilder.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Load API key from .env manually (no dotenv needed)
const envPath = path.resolve(__dirname, '../.env');
const envVars = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) envVars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const ANTHROPIC_KEY = envVars.ANTHROPIC_API_KEY;

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─── STEP 1: buildSystemPrompt() output ──────────────────────────────────────
console.log('\n══ STEP 1: buildSystemPrompt() (no session) ══\n');

const promptNoSession = buildSystemPrompt(null);

check('Contains BEHAVIORAL RULES section',   promptNoSession.includes('## BEHAVIORAL RULES'));
check('Contains SENSORY OPENING RULE',        promptNoSession.includes('SENSORY OPENING RULE'));
check('Contains PLAYER ACTION RULES',         promptNoSession.includes('PLAYER ACTION RULES'));
check('Contains CHARACTER BEHAVIOR RULES',    promptNoSession.includes('CHARACTER BEHAVIOR RULES'));
check('Contains NPC TRUST AND AGGRESSION',    promptNoSession.includes('NPC TRUST AND AGGRESSION'));
check('Contains SCENARIO CONTEXT',            promptNoSession.includes('## SCENARIO CONTEXT'));
check('Contains WORLD LANGUAGE section',      promptNoSession.includes('## WORLD LANGUAGE'));
check('World language has period text',       promptNoSession.includes('the trouble, the irregularity'));
check('Contains ACTIVE NPCS',                 promptNoSession.includes('## ACTIVE NPCS'));

// Burnham fields
check('Burnham publicFace present',           promptNoSession.includes('Controlled, visionary, exhausted, commanding'));
check('Burnham privateGoal present',          promptNoSession.includes('Open the fair without scandal'));
check('Burnham fear present',                 promptNoSession.includes('Public failure and political embarrassment'));
check('Burnham voice present',                promptNoSession.includes('brief, precise, impatient'));
check('Burnham trustLogic present',           promptNoSession.includes('Trust rises when the player brings evidence'));
check('Burnham secrets present',              promptNoSession.includes('suppressed at least one smaller incident'));
check('Burnham aggressionProfile present',    promptNoSession.includes('mildPressure'));

// Mercier fields
check('Mercier publicFace present',           promptNoSession.includes('Elegant, clever, amused, cosmopolitan'));
check('Mercier privateGoal present',          promptNoSession.includes('Protect French prestige'));
check('Mercier aggressionProfile present',    promptNoSession.includes('fleeCondition'));

// No hardcoded story content check (no NPC names in BEHAVIORAL RULES section)
const behSection = promptNoSession.split('## SCENARIO CONTEXT')[0];
check('BEHAVIORAL RULES has no hardcoded story names (Burnham not in rules)',
  !behSection.includes('Burnham'));

// ─── STEP 2: Session start — npc_states seeding ──────────────────────────────
console.log('\n══ STEP 2: Session creation — npc_states seeding ══\n');

const testSessionId = randomUUID();
const scenario = data.getScenario();
const role = scenario.playerRoleOptions[0];

// Build a minimal initial state (mirrors what buildInitialState does)
const initialState = {
  scenarioId:             scenario.id,
  playerRoleId:           role.id,
  playerRoleName:         role.name,
  playerAccessLevel:      role.accessLevel || 'staff',
  playerPerspective:      role.perspective || '',
  playerStartingKnowledge: role.startingKnowledge || [],
  location:               role.startLocation || role.startLocationId,
  visitedLocations:       [role.startLocation || role.startLocationId],
  elapsedMinutes:         0,
  remainingMinutes:       scenario.sessionTargetMinutes,
  act:                    1,
  threat:                 0,
  authorityTrust:         0,
  suspicion:              {},
  discoveredClueIds:      [],
  introducedNpcs:         [],
  character_context:      'Test briefing context.',
};

const seeded = data.saveSession(testSessionId, initialState);

// Verify session file exists
const sessionsDir = path.resolve(__dirname, '../data/sessions');
const sessionFile = path.join(sessionsDir, `${testSessionId}.json`);
check('Session file created in data/sessions/', fs.existsSync(sessionFile));

// Verify npc_states
const npcs = data.getNPCs();
check('npc_states initialised on session',    !!seeded.npc_states);
check('npc_states has all NPCs',              seeded.npc_states && Object.keys(seeded.npc_states).length === npcs.length);

if (seeded.npc_states) {
  const burnhamState = seeded.npc_states['daniel_burnham'];
  check('Burnham trust_level seeded to 5',       burnhamState?.trust_level === 5);
  check('Burnham knows seeded as []',            Array.isArray(burnhamState?.knows) && burnhamState.knows.length === 0);
  check('Burnham wants seeded from privateGoal', burnhamState?.wants === 'Open the fair without scandal, delay, or humiliation');
  check('Burnham hiding seeded from secrets[0]', burnhamState?.hiding?.includes('suppressed'));
  check('Burnham aggression_mode neutral',       burnhamState?.aggression_mode === 'neutral');
  check('Burnham last_interaction null',         burnhamState?.last_interaction === null);
  check('Burnham trust_logic carried forward',   burnhamState?.trust_logic?.includes('brings evidence'));
  check('Burnham aggression_profile carried',    !!burnhamState?.aggression_profile?.mildPressure);
}

// Verify buildSystemPrompt with the seeded session includes NPC states
const promptWithSession = buildSystemPrompt(testSessionId);
check('NPC STATES section present in prompt',        promptWithSession.includes('## NPC STATES'));
check('Per-NPC session state present',               promptWithSession.includes('Per-NPC session state'));
check('Burnham trust in prompt',                     promptWithSession.includes('Trust in player: 5/10'));
check('CHARACTER CONTEXT section present',           promptWithSession.includes('## CHARACTER CONTEXT'));
check('Character briefing text in prompt',           promptWithSession.includes('Test briefing context.'));

// ─── STEP 3: Simulated player action — freeform ───────────────────────────────
console.log('\n══ STEP 3: Simulated player action (Anthropic API call) ══\n');

if (!ANTHROPIC_KEY) {
  console.error('  ✗ ANTHROPIC_API_KEY not found — skipping API step');
  failed++;
} else {
  const systemPrompt = buildSystemPrompt(testSessionId);

  const playerAction = 'I lower my voice and ask Burnham directly whether he has seen the delivery manifests himself.';

  // Use the actual turn template format (mirrors what composeTurnPrompt does for the primary scenario)
  const scenario2  = data.getScenario();
  const locations2 = data.getLocations();
  const location2  = locations2.find(l => l.id === seeded.location) || {};
  const npcs2      = data.getNPCs();

  const userPrompt = [
    `PLAYER ROLE: ${seeded.playerRoleName}`,
    `Perspective: ${seeded.playerPerspective}`,
    '',
    `Current game state:`,
    JSON.stringify(seeded),
    '',
    `Current location:`,
    JSON.stringify({ id: location2.id, name: location2.name, description: location2.description, mood: location2.mood }),
    '',
    `Relevant NPCs:`,
    JSON.stringify(npcs2.slice(0, 2)),
    '',
    `Clues the player has already discovered: []`,
    `Clues available at this location: []`,
    '',
    `Narrative style for this session: focused`,
    '',
    `Player input:`,
    playerAction,
    '',
    `⚠️ PLAYER ACTION: The player lowered their voice. You MUST reference this in the narrative — acknowledge that they spoke quietly or in a lowered tone.`,
    '',
    `⚠️ NPC_UPDATES REQUIRED: Burnham is present. Include npc_updates.daniel_burnham with trust_delta, aggression_mode, and last_interaction.`,
  ].join('\n');

  console.log(`  Calling Anthropic with player_action: "${playerAction}"`);

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        temperature: 0.8,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    const apiData = await resp.json();
    const rawText = apiData?.content?.[0]?.text;

    if (!rawText) {
      console.error('  ✗ No text returned from Anthropic');
      console.error('    API response:', JSON.stringify(apiData).slice(0, 300));
      failed++;
    } else {
      // Parse JSON
      let output;
      try {
        const trimmed = rawText.trim();
        const first = trimmed.indexOf('{'), last = trimmed.lastIndexOf('}');
        output = JSON.parse(first !== -1 ? trimmed.slice(first, last + 1) : trimmed);
      } catch (e) {
        console.error('  ✗ Model returned invalid JSON:', rawText.slice(0, 400));
        failed++;
        output = null;
      }

      if (output) {
        console.log('\n  Raw narrative (first 500 chars):');
        console.log('  ' + (output.narrative || '').slice(0, 500).replace(/\n/g, '\n  '));
        console.log('');

        const narrative = (output.narrative || '').toLowerCase();
        const sensory   = (output.sensory_opening || '').toLowerCase();

        check('Scene references lowered voice',
          narrative.includes('lower') || narrative.includes('quiet') || narrative.includes('hush') || narrative.includes('murmur') || narrative.includes('soft') || narrative.includes('voice'),
          `narrative: "${output.narrative?.slice(0, 120)}"`);

        check('Burnham appears in scene (npcMoments)',
          Array.isArray(output.npcMoments) && output.npcMoments.some(m => m.npc === 'daniel_burnham'),
          `npcMoments: ${JSON.stringify(output.npcMoments)}`);

        // Burnham voice: brief, precise, impatient — check his dialogue is short
        const burnhamLines = (output.npcMoments || []).filter(m => m.npc === 'daniel_burnham');
        if (burnhamLines.length > 0) {
          const burnhamText = burnhamLines[0].text || '';
          check('Burnham dialogue is concise (brief voice)',
            burnhamText.split(' ').length < 40,
            `dialogue: "${burnhamText}"`);
          console.log(`  Burnham said: "${burnhamText}"`);
        }

        check('sensory_opening present',
          !!output.sensory_opening && output.sensory_opening.length > 20,
          `sensory_opening: "${output.sensory_opening?.slice(0, 80)}"`);

        check('npc_updates returned',
          !!output.npc_updates,
          `npc_updates: ${JSON.stringify(output.npc_updates)}`);

        if (output.npc_updates) {
          const bu = output.npc_updates['daniel_burnham'];
          check('npc_updates has trust_delta for Burnham',
            bu && bu.trust_delta != null,
            `burnham update: ${JSON.stringify(bu)}`);
          check('last_interaction returned for Burnham',
            bu && typeof bu.last_interaction === 'string',
            `last_interaction: ${bu?.last_interaction}`);

          // Apply updates and save session
          const updatedNpcStates = { ...seeded.npc_states };
          for (const [id, u] of Object.entries(output.npc_updates)) {
            if (!updatedNpcStates[id]) continue;
            const s = { ...updatedNpcStates[id] };
            if (u.trust_delta != null)        s.trust_level = Math.max(0, Math.min(10, s.trust_level + u.trust_delta));
            if (Array.isArray(u.knows_add))   s.knows = [...s.knows, ...u.knows_add];
            if (u.aggression_mode != null)    s.aggression_mode = u.aggression_mode;
            if (u.last_interaction != null)   s.last_interaction = u.last_interaction;
            updatedNpcStates[id] = s;
          }
          data.updateSession(testSessionId, { npc_states: updatedNpcStates });

          // Verify session file was updated
          const updatedSession = data.getSession(testSessionId);
          const burnhamUpdated = updatedSession?.npc_states?.['daniel_burnham'];
          check('Session JSON updated with new npc_states',
            !!burnhamUpdated && burnhamUpdated.trust_level !== null,
            `trust_level after update: ${burnhamUpdated?.trust_level}`);
          check('last_interaction saved to session',
            typeof burnhamUpdated?.last_interaction === 'string' && burnhamUpdated.last_interaction.length > 0,
            `last_interaction: "${burnhamUpdated?.last_interaction}"`);

          console.log(`\n  Burnham trust after update: ${burnhamUpdated?.trust_level}/10`);
          console.log(`  Burnham last_interaction: "${burnhamUpdated?.last_interaction}"`);
        }
      }
    }
  } catch (err) {
    console.error(`  ✗ API call failed: ${err.message}`);
    failed++;
  }
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n══ RESULT: ${passed} passed, ${failed} failed ══\n`);
if (failed > 0) process.exit(1);
