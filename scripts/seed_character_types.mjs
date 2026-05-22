// One-time seeding script: adds character_type, represents, historical_record_note, fact_checked
// to all player role files and NPC character files.
// Run once: node scripts/seed_character_types.mjs

import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PLAYER_ROLES_DIR = path.join(ROOT, 'engine/data/scenarios/player_roles');
const CHARACTERS_DIR   = path.join(ROOT, 'engine/data/characters');

// ── Player Role Assignments ───────────────────────────────────────────────────

const PLAYER_ROLE_DATA = {
  // Apollo 13
  'role_mission_commander':    { character_type: 'real', represents: null, historical_record_note: 'Jim Lovell, Commander of Apollo 13. Survived the mission. Became the first person to fly to the Moon twice without landing. Later commanded the crew of Apollo 13 in the 1995 film.' },
  'role_flight_director':      { character_type: 'real', represents: null, historical_record_note: 'Gene Kranz, Flight Director during the Apollo 13 crisis. His white vest became iconic. His account is the basis for the film\'s famous "failure is not an option" framing (a phrase actually coined by the screenwriters, not Kranz).' },
  'role_cm_pilot':             { character_type: 'real', represents: null, historical_record_note: 'Jack Swigert, Command Module Pilot. A last-minute replacement for Ken Mattingly. Survived. Later elected to Congress from Colorado but died of cancer before taking his seat in 1983.' },

  // Bornholmer
  'role_gatekeeper':           { character_type: 'real', represents: null, historical_record_note: 'Harald Jäger, Stasi Oberstleutnant commanding the Bornholmer Straße passport control unit. Made the unilateral decision to open the checkpoint at approximately 23:30 on November 9, 1989. Primary source on the opening night.' },
  'role_catalyst':             { character_type: 'fictional', represents: 'East Berlin students and civilians who pressed against the Bornholmer Straße checkpoint on the night of November 9, 1989', historical_record_note: '' },
  'role_chronicler':           { character_type: 'fictional', represents: 'West German ARD television camera operators covering the Bornholmer Straße opening on November 9, 1989', historical_record_note: '' },

  // Chicago 1893
  'daniel_burnham':            { character_type: 'real', represents: null, historical_record_note: 'Daniel Burnham, Director of Works for the World\'s Columbian Exposition. Completed the fair on time despite enormous pressure. Later designed the 1909 Plan of Chicago and Union Station.' },
  'burnhams_assistant':        { character_type: 'fictional', represents: 'Administrative staff working under Daniel Burnham at the World\'s Columbian Exposition, Chicago, 1893', historical_record_note: '' },
  'watchman_murphy':           { character_type: 'fictional', represents: 'Night watchmen and security personnel employed at the World\'s Columbian Exposition, Chicago, 1893', historical_record_note: '' },

  // Sargasso / Cuban Missile Crisis
  'role_arkhipov':             { character_type: 'real', represents: null, historical_record_note: 'Vasili Arkhipov, Flotilla Chief of Staff aboard B-59. His refusal to authorize a nuclear torpedo launch on October 27, 1962 is credited by historians including Thomas Blanton of the National Security Archive as preventing nuclear war.' },
  'role_sonar_analyst':        { character_type: 'fictional', represents: 'Soviet hydroacoustic officers aboard Foxtrot-class submarines during the naval quarantine of Cuba, October 1962', historical_record_note: '' },
  'role_cony_captain':         { character_type: 'fictional', represents: 'US Navy destroyer captains participating in the naval quarantine of Cuba, October 1962', historical_record_note: '' },

  // Titanic
  'senior_wireless_operator':  { character_type: 'real', represents: null, historical_record_note: 'Jack Phillips, Senior Wireless Operator aboard RMS Titanic. Remained at his post transmitting CQD and SOS distress calls after Captain Smith released him from duty. Died in the sinking. Body never recovered.' },
  'second_engineer':           { character_type: 'fictional', represents: 'Engineering officers of RMS Titanic who maintained power at their stations during the sinking on April 14-15, 1912', historical_record_note: '' },
  'first_class_steward':       { character_type: 'fictional', represents: 'First class stewards aboard RMS Titanic on the night of April 14-15, 1912', historical_record_note: '' },

  // Lightning and the Midnight Coach
  'role_conductor':            { character_type: 'fictional', represents: 'Underground Railroad conductors operating in the Ohio corridor in the 1850s', historical_record_note: '' },
  'role_lightning_flinger':    { character_type: 'fictional', represents: 'Telegraph operators who used their wire access to support Underground Railroad networks in Ohio during the 1850s', historical_record_note: '' },
  'role_stationmaster':        { character_type: 'fictional', represents: 'Women who served as Underground Railroad station keepers in northern Ohio during the 1850s', historical_record_note: '' },

  // Boston Tea Party v1
  'role_merchant_observer':    { character_type: 'fictional', represents: 'Boston merchants sympathetic to the patriot cause who were present at or near the waterfront on the night of December 16, 1773', historical_record_note: '' },

  // Boston Tea Party v2
  'role_dockworker':           { character_type: 'fictional', represents: 'Dockworkers and laborers recruited by the Sons of Liberty who participated in the Boston Tea Party on December 16, 1773', historical_record_note: '' },
  'role_patriot_organizer':    { character_type: 'fictional', represents: 'Inner-circle lieutenants of Samuel Adams and the Sons of Liberty who organized and executed the Boston Tea Party on December 16, 1773', historical_record_note: '' },
  'role_tavern_spy':           { character_type: 'fictional', represents: 'Informants and message carriers working for the Sons of Liberty in Boston in 1773', historical_record_note: '' },

  // Midnight Errand Boston
  'dorothy_gill_role':         { character_type: 'fictional', represents: 'Women who maintained patriot networks in colonial Boston, 1774-1776', historical_record_note: '' },
  'margaret_vane_role':        { character_type: 'fictional', represents: 'Couriers and message carriers in the Sons of Liberty network, 1774-1776', historical_record_note: '' },
  'nathaniel_gill_role':       { character_type: 'fictional', represents: 'Young men who carried dispatches through occupied Boston on the night of April 18-19, 1775', historical_record_note: '' },

  // Singing Wires
  'elias_cole_conductor':      { character_type: 'fictional', represents: 'Underground Railroad conductors operating in the Ohio corridor, 1850-1860', historical_record_note: '' },
  'mercy_voss_stationmaster':  { character_type: 'fictional', represents: 'Station masters who ran safe houses along the Underground Railroad\'s northern Ohio network', historical_record_note: '' },
  'thomas_cole_operator':      { character_type: 'fictional', represents: 'Telegraph operators who used their access to the wire to assist the Underground Railroad', historical_record_note: '' },

  // Dog Green Sector
  'role_battalion_medic':      { character_type: 'fictional', represents: 'Battalion aid men of the 116th Infantry Regiment at Omaha Beach on June 6, 1944', historical_record_note: '' },
  'role_coxswain':             { character_type: 'fictional', represents: 'Coast Guard and Navy coxswains who piloted landing craft at Omaha Beach on June 6, 1944', historical_record_note: '' },
  'role_ranger_sergeant':      { character_type: 'fictional', represents: 'Sergeants of the 2nd Ranger Battalion at Dog Green Sector on June 6, 1944', historical_record_note: '' },

  // Greensboro Four
  'point_man_ezell':           { character_type: 'real', represents: null, historical_record_note: 'Ezell Blair Jr. (later Jibreel Khazan). Spoke the words that initiated the sit-in. Co-founded the student chapter of NAACP at NC A&T. The movement spread to 54 cities within two months.' },
  'logistics_coordinator_franklin': { character_type: 'real', represents: null, historical_record_note: 'Franklin McCain. One of the four A&T freshmen who initiated the Greensboro sit-in on February 1, 1960. Continued civil rights activism throughout his life. Died 2014.' },
  'communications_conduit_joseph': { character_type: 'real', represents: null, historical_record_note: 'Joseph McNeil. His experience being refused service at a Greensboro bus terminal lunch counter in January 1960 was the immediate catalyst for the sit-in. Later became a USAF Brigadier General.' },

  // Zero Hour Cantigny
  'role_doughboy':             { character_type: 'fictional', represents: 'Enlisted men of the 28th Infantry Regiment, 1st Division, United States Army, who assaulted Cantigny on May 28, 1918', historical_record_note: '' },
  'role_signaler':             { character_type: 'fictional', represents: 'Signal Corps linemen of the 1st Division who advanced behind the assault infantry at Cantigny on May 28, 1918', historical_record_note: '' },
  'role_artillery_commander':  { character_type: 'fictional', represents: 'Artillery officers of the 5th Field Artillery, 1st Division, who directed the rolling barrage at Cantigny on May 28, 1918', historical_record_note: '' },
};

// ── NPC Character Assignments ─────────────────────────────────────────────────

const NPC_DATA = {
  // Bornholmer
  'char_jaeger':               { character_type: 'real', represents: null },
  'char_protester':            { character_type: 'fictional', represents: 'East Berlin civilians who pressed against the Bornholmer Straße checkpoint on the night of November 9, 1989 — specifically those with family members stranded on the other side' },
  'char_journalist':           { character_type: 'fictional', represents: 'West German ARD television camera operators covering the Bornholmer Straße opening on November 9, 1989' },
  'char_brenner':              { character_type: 'fictional', represents: 'Grenztruppen enlisted personnel stationed at Bornholmer Straße on November 9, 1989' },
  'char_mueller':              { character_type: 'fictional', represents: 'Grenztruppen Gefreiter conscripts present when Jäger ordered the gate opened on November 9, 1989' },
  'char_oberst_mielke':        { character_type: 'fictional', represents: 'Stasi district command officers contacted by Jäger during the night of November 9, 1989 who failed to issue orders' },
  'char_westberlin_producer':  { character_type: 'fictional', represents: 'ARD field producers coordinating coverage from the western side of the Bornholmer bridge on November 9, 1989' },

  // Apollo 13
  'char_jim_lovell':           { character_type: 'real', represents: null },
  'char_jack_swigert':         { character_type: 'real', represents: null },
  'char_fred_haise':           { character_type: 'real', represents: null },
  'char_gene_kranz':           { character_type: 'real', represents: null },
  'char_sy_liebergot':         { character_type: 'real', represents: null },
  'char_glynn_lunney':         { character_type: 'real', represents: null },
  'char_john_aaron':           { character_type: 'real', represents: null },

  // Sargasso / Cuban Missile Crisis
  'char_savitsky':             { character_type: 'real', represents: null },
  'char_arkhipov':             { character_type: 'real', represents: null },
  'char_maslennikov':          { character_type: 'fictional', represents: 'Zampolit (political officers) aboard Soviet Foxtrot-class submarines during the Cuban Missile Crisis, October 1962' },
  'char_chief_petty_officer_kozlov': { character_type: 'fictional', represents: 'Chief petty officers aboard Soviet Foxtrot-class submarines during the Cuban Missile Crisis, October 1962' },
  'char_captain_estocin':      { character_type: 'fictional', represents: 'US Navy destroyer captains participating in the naval quarantine of Cuba, October 1962' },
  'char_lt_commander_hayes':   { character_type: 'fictional', represents: 'US Navy executive officers aboard destroyers participating in the naval quarantine of Cuba, October 1962' },
  'char_sonar_analyst':        { character_type: 'fictional', represents: 'Soviet hydroacoustic officers aboard Foxtrot-class submarines during the Cuban Missile Crisis, October 1962' },

  // Dog Green Sector
  'char_cpl_drennan':          { character_type: 'fictional', represents: 'Non-commissioned officers of the 116th Infantry Regiment at Omaha Beach on June 6, 1944' },
  'char_feldwebel_brandt':     { character_type: 'fictional', represents: 'German Feldwebel commanding beach defense positions at Omaha Beach on June 6, 1944' },
  'char_lt_hargrove':          { character_type: 'fictional', represents: 'Platoon commanders of the 116th Infantry Regiment leading assault sections at Dog Green Sector on June 6, 1944' },
  'char_petty_officer_reed':   { character_type: 'fictional', represents: 'Coast Guard and Navy petty officers operating landing craft at Omaha Beach on June 6, 1944' },
  'char_pvt_szymanski':        { character_type: 'fictional', represents: 'Enlisted men of the 116th Infantry Regiment who landed at Dog Green Sector on June 6, 1944' },
  'char_medic_calloway':       { character_type: 'fictional', represents: 'Medical corpsmen of the 1st Division providing aid under fire at Omaha Beach on June 6, 1944' },

  // Zero Hour Cantigny
  'char_sgt_kowalski':         { character_type: 'fictional', represents: 'Non-commissioned officers of the 28th Infantry Regiment, 1st Division, who participated in the assault on Cantigny on May 28, 1918' },
  'char_renard':               { character_type: 'fictional', represents: 'French army liaison officers attached to American units during the Battle of Cantigny, May 1918' },
  'char_ely':                  { character_type: 'real', represents: null },
  'char_mccormick':            { character_type: 'fictional', represents: 'Artillery officers of the 5th Field Artillery, 1st Division, who coordinated fire support at Cantigny on May 28, 1918' },
  'char_beaumont':             { character_type: 'fictional', represents: 'Signal Corps corporals of the 1st Division who operated communications during the Battle of Cantigny, May 1918' },
  'char_farrow':               { character_type: 'fictional', represents: 'Lieutenants of the 28th Infantry Regiment who were present during the artillery coordination phase at Cantigny on May 28, 1918' },
  'char_kowalski':             { character_type: 'fictional', represents: 'Enlisted Signal Corps personnel of the 1st Division who advanced with the wire teams at Cantigny on May 28, 1918' },
  'char_voss':                 { character_type: 'fictional', represents: 'Sergeants of the 28th Infantry Regiment who led squads at the assault on Cantigny on May 28, 1918' },

  // Greensboro Four
  'david_richmond':            { character_type: 'real', represents: null },
  'harris_mackintosh':         { character_type: 'fictional', represents: 'F.W. Woolworth store managers in the American South who confronted sit-in protesters at segregated lunch counters in 1960' },
  'james_caldwell':            { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from the Greensboro sit-in, February 1960' },
  'patsy_howell':              { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from the Greensboro sit-in, February 1960' },
  'ruth_carver':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from the Greensboro sit-in, February 1960' },
  'sergeant_dale_pruitt':      { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from the Greensboro sit-in, February 1960' },

  // Titanic
  'jack_phillips':             { character_type: 'real', represents: null },
  'harold_bride':              { character_type: 'real', represents: null },
  'margaret_brown':            { character_type: 'real', represents: null },
  'charles_lightoller':        { character_type: 'real', represents: null },
  'thomas_andrews':            { character_type: 'real', represents: null },

  // Colonial Boston
  'samuel_adams':              { character_type: 'real', represents: null },
  'paul_revere':               { character_type: 'real', represents: null },
  'dr_joseph_warren':          { character_type: 'real', represents: null },
  'captain_john_rotch':        { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify relationship to Francis Rotch (documented owner of the Dartmouth tea ship)' },
  'reverend_ezra_willard':     { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from colonial Boston, 1773-1775' },
  'thomas_greenleaf':          { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from colonial Boston, 1773-1775' },
  'agent_silas_dawes':         { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from the Sons of Liberty intelligence network, 1773-1775' },
  'thomas_dillworth':          { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented historical individual from colonial Boston, 1773-1775' },

  // Chicago 1893
  'daniel_burnham':            { character_type: 'real', represents: null },
  'patrick_hanrahan':          { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the World\'s Columbian Exposition, Chicago, 1893' },
  'emile_mercier':             { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the World\'s Columbian Exposition, Chicago, 1893' },
  'clara_hale':                { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the World\'s Columbian Exposition, Chicago, 1893' },
  'captain_odonnell':          { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the World\'s Columbian Exposition, Chicago, 1893' },
  'crazy_benny':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the World\'s Columbian Exposition, Chicago, 1893' },

  // Underground Railroad / Ohio corridor
  'elias_cole':                { character_type: 'fictional', represents: 'Underground Railroad conductors operating in the Ohio corridor, 1850-1860' },
  'mercy_voss':                { character_type: 'fictional', represents: 'Station masters who ran safe houses along the Underground Railroad\'s northern Ohio network, 1850-1860' },
  'thomas_cole':               { character_type: 'fictional', represents: 'Telegraph operators who used their access to the wire to assist the Underground Railroad, 1850-1860' },
  'elias_cutter':              { character_type: 'fictional', represents: 'Underground Railroad conductors operating in the Ohio corridor during the 1850s' },
  'caleb_morse':               { character_type: 'fictional', represents: 'Telegraph operators who used their wire access to support Underground Railroad networks in Ohio during the 1850s' },
  'marshal_crane':             { character_type: 'fictional', represents: 'Federal marshals and law enforcement officers enforcing the Fugitive Slave Act in Ohio during the 1850s' },
  'harriet_voss':              { character_type: 'fictional', represents: 'Women who served as Underground Railroad station keepers in northern Ohio during the 1850s' },
  'margaret_cole':             { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the Underground Railroad network' },
  'elias_croft':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the Underground Railroad network' },
  'hannah_cross':              { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from the Underground Railroad network' },
  'prentiss_hoyle':            { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'aldous_greer':              { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'wickes_huron':              { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'jerome_lattimore':          { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'silas_pratt':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'deputy_crane':              { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'silas_murch':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'thomas_wren':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'joseph_bell':               { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'owen_pryce':                { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },
  'captain_aldrich':           { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify the historical role of this character in the scenario' },

  // Midnight Errand Boston
  'dorothy_gill':              { character_type: 'fictional', represents: 'Women who maintained patriot networks in colonial Boston, 1774-1776' },
  'arden_gill':                { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from colonial Boston, 1774-1776' },
  'benjamin_gill':             { character_type: 'fictional', represents: 'REQUIRES FACT-CHECK — verify whether this is a documented individual from colonial Boston, 1774-1776' },
};

// ── Seed Functions ────────────────────────────────────────────────────────────

async function seedPlayerRoles() {
  const files = await readdir(PLAYER_ROLES_DIR);
  let updated = 0, skipped = 0;

  for (const file of files.filter(f => f.endsWith('.json'))) {
    const filePath = path.join(PLAYER_ROLES_DIR, file);
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const mapping = PLAYER_ROLE_DATA[data.id];

    if (!mapping) {
      console.log(`[SKIP] No mapping for player role: ${data.id}`);
      skipped++;
      continue;
    }

    // Add fields (do not overwrite if already set)
    if (data.character_type) {
      console.log(`[SKIP] Already has character_type: ${data.id}`);
      skipped++;
      continue;
    }

    data.character_type = mapping.character_type;
    if (mapping.represents !== null) {
      data.represents = mapping.represents;
    }
    if (mapping.historical_record_note) {
      data.historical_record_note = mapping.historical_record_note;
    }
    data.fact_checked = false;

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[OK] ${data.id} → ${mapping.character_type}`);
    updated++;
  }

  console.log(`\nPlayer roles: ${updated} updated, ${skipped} skipped`);
}

async function seedNPCCharacters() {
  const files = await readdir(CHARACTERS_DIR);
  let updated = 0, skipped = 0, noMapping = 0;

  for (const file of files.filter(f => f.endsWith('.json'))) {
    const filePath = path.join(CHARACTERS_DIR, file);
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const mapping = NPC_DATA[data.id];

    if (!mapping) {
      console.log(`[NO MAPPING] ${data.id} — marking fictional/REQUIRES FACT-CHECK`);
      if (!data.character_type) {
        data.character_type = 'fictional';
        data.represents = 'REQUIRES FACT-CHECK — no mapping defined for this character';
        data.fact_checked = false;
        await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        noMapping++;
      }
      continue;
    }

    if (data.character_type) {
      console.log(`[SKIP] Already has character_type: ${data.id}`);
      skipped++;
      continue;
    }

    data.character_type = mapping.character_type;
    if (mapping.represents !== null) {
      data.represents = mapping.represents;
    }
    data.fact_checked = false;

    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[OK] ${data.id} → ${mapping.character_type}`);
    updated++;
  }

  console.log(`\nNPC characters: ${updated} updated, ${skipped} skipped, ${noMapping} fell back to REQUIRES FACT-CHECK`);
}

async function main() {
  console.log('=== Seeding character_type fields ===\n');
  console.log('--- Player Roles ---');
  await seedPlayerRoles();
  console.log('\n--- NPC Characters ---');
  await seedNPCCharacters();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
