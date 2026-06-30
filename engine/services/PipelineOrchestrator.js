import VersionController from './VersionController.js';
import GeminiClient from './GeminiClient.js';
import OpenAIClient from './OpenAIClient.js';
import ClaudeScenarioClient from './ClaudeScenarioClient.js';

const PIPELINE_STEPS = [
  'synopsis',
  'generated',
  'epilogue_reviewed',
  'scenario_reviewed',
  'gpt_reviewed',
  'ending_notes',
  'schema_fill',
  'published'
];

class PipelineOrchestrator {

  constructor() {
    this.activePipelines = new Map();
  }

  async startPipeline(scenarioId, storyIdea, sessionLength = 30) {
    const state = {
      scenarioId,
      storyIdea,
      sessionLength,
      status: 'running',
      currentStep: 'synopsis',
      steps: {},
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null
    };
    this.activePipelines.set(scenarioId, state);
    this._runPipeline(scenarioId, storyIdea, sessionLength).catch(err => {
      const s = this.activePipelines.get(scenarioId);
      if (s) {
        s.status = 'failed';
        s.error = err.message;
      }
    });
    return state;
  }

  async _runPipeline(scenarioId, storyIdea, sessionLength) {
    const state = this.activePipelines.get(scenarioId);

    try {
      // Step 1 — Gemini generates synopsis
      this._setStep(state, 'synopsis', 'running');
      const synopsis = await GeminiClient.generateSynopsis(storyIdea, sessionLength);
      this._setStep(state, 'synopsis', 'awaiting_approval', { synopsis });

      // Pipeline pauses — user reviews and approves Gemini synopsis before Claude generates
      await this._waitForApproval(scenarioId, 'synopsis');
      const approvedSynopsis = state.steps['synopsis'].approvedSynopsis || synopsis;

      // Step 2 — Claude generates full scenario using approved synopsis
      this._setStep(state, 'generated', 'running');
      const scenario = await this._generateScenario(scenarioId, approvedSynopsis, sessionLength);
      await VersionController.saveVersion(scenarioId, scenario, {
        label: 'generated',
        pipeline_step: 'generated'
      });
      this._setStep(state, 'generated', 'complete', { scenario });

      // Step 3 — Gemini fact-checks epilogue
      this._setStep(state, 'epilogue_reviewed', 'running');
      const epilogueText = JSON.stringify(scenario.epilogue || {}, null, 2);
      const epilogueCorrections = await GeminiClient.factCheckEpilogue(
        epilogueText,
        scenario.title || scenarioId
      );
      await VersionController.saveVersion(scenarioId, scenario, {
        label: 'epilogue_pending_review',
        pipeline_step: 'epilogue_reviewed'
      });
      this._setStep(state, 'epilogue_reviewed', 'awaiting_approval', {
        corrections: epilogueCorrections
      });

      // Pipeline pauses here — waits for user to approve/reject corrections
      await this._waitForApproval(scenarioId, 'epilogue_reviewed');
      const epilogueApproved = state.steps['epilogue_reviewed'].approvedScenario;

      // Step 4 — Gemini reviews full scenario
      this._setStep(state, 'scenario_reviewed', 'running');
      const scenarioText = JSON.stringify(epilogueApproved, null, 2);
      const scenarioCorrections = await GeminiClient.reviewFullScenario(
        scenarioText,
        epilogueApproved.title || scenarioId
      );
      await VersionController.saveVersion(scenarioId, epilogueApproved, {
        label: 'scenario_pending_review',
        pipeline_step: 'scenario_reviewed'
      });
      this._setStep(state, 'scenario_reviewed', 'awaiting_approval', {
        corrections: scenarioCorrections
      });

      // Pipeline pauses — waits for user approval
      await this._waitForApproval(scenarioId, 'scenario_reviewed');
      const scenarioApproved = state.steps['scenario_reviewed'].approvedScenario;

      // Step 5 — ChatGPT cross-reviews full scenario
      this._setStep(state, 'gpt_reviewed', 'running');
      const gptText = JSON.stringify(scenarioApproved, null, 2);
      const gptCorrections = await OpenAIClient.reviewFullScenario(
        gptText,
        scenarioApproved.title || scenarioId
      );
      await VersionController.saveVersion(scenarioId, scenarioApproved, {
        label: 'gpt_pending_review',
        pipeline_step: 'gpt_reviewed'
      });
      this._setStep(state, 'gpt_reviewed', 'awaiting_approval', {
        corrections: gptCorrections
      });

      // Pipeline pauses — waits for user approval
      await this._waitForApproval(scenarioId, 'gpt_reviewed');
      const gptApproved = state.steps['gpt_reviewed'].approvedScenario;

      // Step 6 — Claude/Opus generates ending notes (Gemini generator left in place, unwired)
      this._setStep(state, 'ending_notes', 'running');
      const playerRoles = gptApproved.player_roles || [];
      const endingNotes = await ClaudeScenarioClient.generateEndingNotes(
        gptApproved,
        playerRoles
      );

      // Survivor-safety guard — gptApproved carries embedded player_roles, so anchor
      // matching works here directly. Shared with the regenerate-endings path.
      this._applySurvivorGuard(scenarioId, gptApproved, endingNotes);

      const withEndingNotes = this._injectEndingNotes(gptApproved, endingNotes);
      await VersionController.saveVersion(scenarioId, withEndingNotes, {
        label: 'ending_notes',
        pipeline_step: 'ending_notes'
      });
      this._setStep(state, 'ending_notes', 'awaiting_approval', {
        endingNotes,
        scenario: withEndingNotes
      });

      // Pipeline pauses — waits for user approval of ending notes
      await this._waitForApproval(scenarioId, 'ending_notes');
      const endingApproved = state.steps['ending_notes'].approvedScenario;

      // Step 7 — Claude fills missing schema fields
      this._setStep(state, 'schema_fill', 'running');
      const filled = await ClaudeScenarioClient.fillMissingFields(endingApproved);
      await VersionController.saveVersion(scenarioId, filled, {
        label: 'schema_filled',
        pipeline_step: 'schema_fill'
      });
      this._setStep(state, 'schema_fill', 'complete', { scenario: filled });

      // Step 8 — Build bibliography and publish
      this._setStep(state, 'published', 'running');
      const final = this._buildBibliography(filled);
      await VersionController.publish(scenarioId, await this._getLatestVersionNumber(scenarioId));
      this._setStep(state, 'published', 'complete', { scenario: final });

      state.status = 'complete';
      state.completedAt = new Date().toISOString();

    } catch (err) {
      state.status = 'failed';
      state.error = err.message;
      throw err;
    }
  }

  async approveStep(scenarioId, stepName, approvedScenario) {
    const state = this.activePipelines.get(scenarioId);
    if (!state) throw new Error('No active pipeline for ' + scenarioId);
    const step = state.steps[stepName];
    if (!step) throw new Error('Step ' + stepName + ' not found');
    step.approvedScenario = approvedScenario;
    step.approvedAt = new Date().toISOString();
    step.status = 'approved';
    await VersionController.saveVersion(scenarioId, approvedScenario, {
      label: stepName + '_approved',
      pipeline_step: stepName,
      changes_applied: step.changes_applied || 0,
      changes_rejected: step.changes_rejected || 0,
      manually_edited: step.manually_edited || false
    });
  }

  getStatus(scenarioId) {
    return this.activePipelines.get(scenarioId) || null;
  }

  // Deterministic, structured-field-only survivor-safety guard. Shared by the full
  // pipeline (Step 6) and the per-role regenerate path so the logic cannot drift.
  // A documented survivor must not be killed in-event in any branch: a 'died' branch
  // is a hard block (the role's fate is dropped here so it is never injected/persisted
  // and surfaced loudly at the gate); 'unresolved'/missing is a soft warning. The
  // scenarioForAnchor MUST carry player_roles (with character_id) for anchor matching.
  _applySurvivorGuard(scenarioId, scenarioForAnchor, endingNotes) {
    const guard = ClaudeScenarioClient.assertSurvivorSafety(scenarioForAnchor, endingNotes);
    const blockedRoles = new Set(guard.blocked.map(v => v.role));
    for (const v of guard.blocked) {
      console.error(`[FATE-GUARD] BLOCKED survivor death: ${scenarioId}/${v.role}/${v.branch}`);
    }
    for (const v of guard.warnings) {
      console.warn(`[FATE-GUARD] WARN survivor unresolved: ${scenarioId}/${v.role}/${v.branch}`);
    }
    if (blockedRoles.size) {
      endingNotes.ending_notes = endingNotes.ending_notes.filter(n => !blockedRoles.has(n.role_name));
    }
    endingNotes.violations = [...guard.blocked, ...guard.warnings];
    return guard;
  }

  // Regenerate ONE role's fate endings on an existing, already-built scenario.
  // Non-destructive: generates only the target role, runs the shared guard, and lands
  // at the existing ending_notes review gate. Persistence (on approval) is a MERGE that
  // writes only this role's file — other roles are never touched. repos is passed in by
  // the route (the orchestrator has no repository handle of its own).
  async regenerateEndingNotes(scenarioId, roleId, repos) {
    const scenario = await repos.scenarios.findById(scenarioId);
    if (!scenario) return { ok: false, error: `Scenario not found: ${scenarioId}` };

    const roles = repos.scenarios.findPlayerRoles(scenarioId);
    const targetRole = roles.find(r => r.id === roleId);
    if (!targetRole) return { ok: false, error: `Role not found: ${roleId} (scenario ${scenarioId})` };

    // Hard-refuse: the Opus generator requires a declared fate_mode. Do NOT default it
    // (that is a separate authorial decision) and do NOT generate-and-skip silently.
    const VALID_FATE_MODES = new Set(['committed', 'suspended', 'anchored']);
    if (!VALID_FATE_MODES.has(targetRole.fate_mode)) {
      return { ok: false, refused: true,
        error: `role ${roleId} has no fate_mode — set it before regenerating` };
    }

    // MANDATORY: persisted scenarios use playerRoleIds with no embedded player_roles, so
    // the guard's anchor lookup (scenario.player_roles) would otherwise be empty and
    // SILENTLY pass a survivor death. Attach the loaded roles (they carry character_id).
    scenario.player_roles = roles;

    const endingNotes = await ClaudeScenarioClient.generateEndingNotes(scenario, [targetRole]);

    // Empty/skip check — never silently succeed. Detect before the guard so a generation
    // skip (no fate output) is distinct from a guard block (generated but killed survivor).
    const generated = (endingNotes.ending_notes || []).find(n => n.role_name === targetRole.name);
    if (!generated) {
      const skip = (endingNotes.skipped || []).find(s => s.role_name === targetRole.name);
      return { ok: false, skipped: true,
        error: `nothing generated for ${roleId}${skip ? ` — ${skip.reason}` : ''}` };
    }

    // Shared guard. scenario now carries player_roles, so anchor matching works.
    this._applySurvivorGuard(scenarioId, scenario, endingNotes);

    // Stand up a fresh single-step pipeline state at the existing review gate. The
    // regenerateEndings flag routes approval through the merge-persist path.
    const state = {
      scenarioId,
      status: 'running',
      currentStep: 'ending_notes',
      steps: {},
      startedAt: new Date().toISOString(),
      regenerateEndings: true,
      regenerateRoleId: roleId
    };
    this.activePipelines.set(scenarioId, state);
    this._setStep(state, 'ending_notes', 'awaiting_approval', { endingNotes, scenario });

    const blocked = (endingNotes.violations || []).filter(
      v => v.type === 'survivor_died' && v.role === targetRole.name
    );
    return { ok: true, blocked, violations: endingNotes.violations || [], state };
  }

  _setStep(state, stepName, status, data = {}) {
    state.currentStep = stepName;
    state.steps[stepName] = {
      ...state.steps[stepName],
      status,
      updatedAt: new Date().toISOString(),
      ...data
    };
  }

  async _waitForApproval(scenarioId, stepName) {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const state = this.activePipelines.get(scenarioId);
        if (!state) { clearInterval(interval); resolve(); return; }
        const step = state.steps[stepName];
        if (step && step.status === 'approved') {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
  }

  async _generateScenario(scenarioId, synopsis, sessionLength) {
    const PORT = process.env.PORT || process.env.ENGINE_PORT || 3002;

    const lines = [synopsis.working_title || scenarioId, ''];
    const anchor = synopsis.historical_anchor || {};
    if (anchor.location || anchor.date_time)
      lines.push(`HISTORICAL SETTING: ${[anchor.location, anchor.date_time].filter(Boolean).join(', ')}`);
    if (anchor.fixed_outcome)
      lines.push(`FIXED OUTCOME: ${anchor.fixed_outcome}`);
    if (synopsis.tone)
      lines.push(`TONE: ${synopsis.tone}`);
    const facts = synopsis.shared_fact_ledger || [];
    if (facts.length) {
      lines.push('', 'KEY FACTS:');
      for (const f of facts) lines.push(`- ${f.name}: ${f.description}`);
    }
    const perspectives = synopsis.perspectives || [];
    if (perspectives.length) {
      lines.push('', 'PLAYER PERSPECTIVES:');
      for (const p of perspectives) {
        lines.push(`- ${p.role_name} (${p.identity}): ${p.tension}`);
        if (p.decision_point) lines.push(`  Decision Point: ${p.decision_point}`);
      }
    }
    const vocab = synopsis.period_vocabulary || [];
    if (vocab.length) {
      lines.push('', 'PERIOD VOCABULARY:');
      for (const v of vocab) lines.push(`- ${v.term}: ${v.meaning}`);
    }
    const description = lines.join('\n');

    const response = await fetch(`http://localhost:${PORT}/admin/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, playTimeMinutes: sessionLength }),
      signal: AbortSignal.timeout(660_000)
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Generate endpoint error ${response.status}: ${err}`);
    }

    const genReader  = response.body.getReader();
    const genDecoder = new TextDecoder();
    let genBuffer = '';
    let data      = null;

    genOuter:
    while (true) {
      const { done, value } = await genReader.read();
      if (done) break;
      genBuffer += genDecoder.decode(value, { stream: true });
      const lines = genBuffer.split('\n');
      genBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.type === 'result') { data = evt.data; break genOuter; }
        if (evt.type === 'error')  throw new Error(`Generate endpoint error: ${evt.error}`);
      }
    }

    if (!data) throw new Error('Generate endpoint closed without result');
    if (!data.scenario) throw new Error('Generation returned no scenario data');
    const merged = {
      ...data.scenario,
      storyArc: data.storyArc,
      characters: data.characters,
      locations: data.locations,
      clues: data.clues,
      playerRoles: data.playerRoles,
      id: scenarioId,
      createdAt: new Date().toISOString()
    };
    return merged;
  }

  _injectEndingNotes(scenario, endingNotes) {
    const updated = JSON.parse(JSON.stringify(scenario));
    const notes = endingNotes.ending_notes || [];
    const playerRoles = updated.playerRoles || updated.player_roles || [];

    for (const note of notes) {
      const role = playerRoles.find(r => r.name === note.role_name);
      if (role) {
        // Write the nested ending_notes path the renderer reads (gameRouter.js:1248-1266).
        if (note.success || note.partial || note.failure) {
          role.ending_notes = role.ending_notes || {};
          if (note.success) role.ending_notes.success = note.success;
          if (note.partial) role.ending_notes.partial = note.partial;
          if (note.failure) role.ending_notes.failure = note.failure;
        }
        if (note.briefing) role.briefing = note.briefing;
        if (note.starting_knowledge) role.startingKnowledge = note.starting_knowledge;
        if (note.hook_1) role.hook1 = note.hook_1;
        if (note.hook_2) role.hook2 = note.hook_2;
        if (note.hook_3) role.hook3 = note.hook_3;
        if (note.suggested_secret) role.suggestedSecret = note.suggested_secret;
        if (note.access_level) role.accessLevel = note.access_level;
        if (note.perspective) role.perspective = note.perspective;
        if (note.description) role.description = note.description;
      }
    }

    if (updated.playerRoles) updated.playerRoles = playerRoles;
    if (updated.player_roles) updated.player_roles = playerRoles;

    return updated;
  }

  _buildBibliography(scenario) {
    const updated = JSON.parse(JSON.stringify(scenario));
    const sources = new Set();
    const collectSources = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.source) sources.add(obj.source);
      if (obj.citation) sources.add(obj.citation);
      for (const val of Object.values(obj)) {
        if (typeof val === 'object') collectSources(val);
      }
    };
    collectSources(scenario);
    updated.bibliography = [...sources].sort().map((s, i) => ({
      index: i + 1,
      citation: s
    }));
    return updated;
  }

  async _getLatestVersionNumber(scenarioId) {
    const history = await VersionController.getHistory(scenarioId);
    return history.length;
  }
}

export default new PipelineOrchestrator();
