export class SchemaValidator {
  constructor(repos) {
    this.repos = repos;
  }

  validateIdentityIntegrity() {
    const issues = [];
    const scenarios = this.repos.scenarios.findAll();

    for (const scenario of scenarios) {
      const roles      = this.repos.scenarios.findPlayerRoles(scenario.id);
      const characters = this.repos.characters.findAll()
        .filter(c => (c.scenarioIds || []).includes(scenario.id));

      for (const role of roles) {
        const namesToCheck = [
          role.real_name,
          role.cover_name,
          ...(role.aliases || []).map(a => a.name),
        ].filter(Boolean);

        for (const name of namesToCheck) {
          const conflict = characters.find(c =>
            c.name === name ||
            (c.display_name && c.display_name.includes(name))
          );
          if (conflict) {
            issues.push({
              severity: 'error',
              type: 'identity-conflict',
              id: `${scenario.id}/${role.id}`,
              field: 'aliases',
              note: `"${name}" is both a player alias (role: ${role.id}) and an NPC (character: ${conflict.id}) in scenario "${scenario.id}". Remove from NPC roster — this causes the identity split bug.`,
            });
          }
        }
      }
    }

    return issues;
  }

  validate() {
    const issues = [];

    const err  = (type, id, field, note = '') => issues.push({ severity: 'error', type, id, field, note });
    const warn = (type, id, field, note = '') => issues.push({ severity: 'warn',  type, id, field, note });

    // ── Characters ────────────────────────────────────────────────────────────
    const characters = this.repos.characters.findAll();
    for (const c of characters) {
      if (!c.scenarioIds?.length) continue;
      if (!c.introAnchor)         warn('character', c.id, 'introAnchor',      'first-encounter anchor missing — will fall back to publicFace');
      if (!c.voice)               warn('character', c.id, 'voice',            'NPC dialogue generation will be generic');
      if (!Array.isArray(c.knowledge)) warn('character', c.id, 'knowledge',   'should be an array');
      if (!c.aggressionProfile)   warn('character', c.id, 'aggressionProfile','escalation behavior undefined');
    }

    // ── Scenarios + Roles ─────────────────────────────────────────────────────
    const scenarios = this.repos.scenarios.findAll();
    for (const s of scenarios) {
      if (!s.setting)                      warn('scenario', s.id, 'setting',             'location header subtitle will be blank');
      if (!s.keyEvidenceClueIds?.length)   warn('scenario', s.id, 'keyEvidenceClueIds',  'strong victory condition undefined');
      if (!s.winConditions?.length)        warn('scenario', s.id, 'winConditions',        'AI has no win condition context');
      if (!s.systems?.timePerTurnDefault)  warn('scenario', s.id, 'systems.timePerTurnDefault', 'will use engine default (3 min/turn)');
      if (!s.sessionTargetMinutes)         warn('scenario', s.id, 'sessionTargetMinutes', 'will default to 15 minutes');

      const roles = this.repos.scenarios.findPlayerRoles(s.id);
      for (const r of roles) {
        if (!r.opening?.narrative)        err( 'role', r.id, 'opening.narrative', 'game cannot start — opening scene missing');
        if (!r.opening?.choices?.length)  warn('role', r.id, 'opening.choices',   'player will have no opening choices');
        if (!r.perspective)               warn('role', r.id, 'perspective',        'AI has no role perspective guidance');

        {
          const bt = !r.briefing ? '' :
            typeof r.briefing === 'string' ? r.briefing.trim() :
            typeof r.briefing === 'object' ? Object.values(r.briefing).filter(Boolean).join(' ').trim() :
            String(r.briefing).trim();
          if (bt.length === 0)  warn('role', r.id, 'briefing', 'mission briefing screen will be blank');
          else if (bt.length < 50) warn('role', r.id, 'briefing', 'briefing too short — under 50 chars');
        }
      }
    }

    // ── Clues ─────────────────────────────────────────────────────────────────
    const clues = this.repos.clues.findAll ? this.repos.clues.findAll() : [];
    for (const cl of clues) {
      if (!cl.title)                                          err( 'clue', cl.id, 'title',       'clue has no display name');
      if (!cl.description)                                    warn('clue', cl.id, 'description', 'clue has no description text');
      const hasLocation = cl.discoveryLocationId || cl.source;
      if (!hasLocation)                                       err( 'clue', cl.id, 'discoveryLocationId', 'clue can never be discovered — no location');
      const hasImplications = cl.implicatesCharacterIds?.length || cl.implicates?.length;
      if (!hasImplications)                                   warn('clue', cl.id, 'implicatesCharacterIds', 'clue does not implicate anyone');
    }

    // ── Locations ─────────────────────────────────────────────────────────────
    const locations = this.repos.locations.findAll ? this.repos.locations.findAll() : [];
    for (const l of locations) {
      if (!l.description)  warn('location', l.id, 'description', 'location has no atmospheric description');
      const hasChars = l.linkedCharacterIds?.length || l.linkedNPCs?.length;
      if (!hasChars)       warn('location', l.id, 'linkedCharacterIds', 'no NPCs linked — location may feel empty');
    }

    issues.push(...this.validateIdentityIntegrity());

    return issues;
  }

  report() {
    console.log('[SCHEMA] Validating content...');

    let issues;
    try {
      issues = this.validate();
    } catch (err) {
      console.error(`[SCHEMA] Validator threw an error: ${err.message}`);
      return;
    }

    const errors   = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warn');

    if (issues.length === 0) {
      console.log('[SCHEMA] ✓ All content valid — no issues found.');
      return;
    }

    if (errors.length) {
      console.error(`[SCHEMA] ✗ ${errors.length} error(s):`);
      for (const e of errors) {
        console.error(`  ERROR   ${e.type}/${e.id} → ${e.field}${e.note ? ` (${e.note})` : ''}`);
      }
    }

    if (warnings.length) {
      console.warn(`[SCHEMA] ⚠ ${warnings.length} warning(s):`);
      for (const w of warnings) {
        console.warn(`  WARN    ${w.type}/${w.id} → ${w.field}${w.note ? ` (${w.note})` : ''}`);
      }
    }

    const status = errors.length ? 'with errors' : 'with warnings';
    console.log(`[SCHEMA] Validation complete ${status}.`);
  }
}
