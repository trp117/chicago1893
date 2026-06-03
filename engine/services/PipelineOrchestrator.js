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

      // Step 6 — Gemini generates ending notes
      this._setStep(state, 'ending_notes', 'running');
      const playerRoles = gptApproved.player_roles || [];
      const endingNotes = await GeminiClient.generateEndingNotes(
        JSON.stringify(gptApproved, null, 2),
        gptApproved.title || scenarioId,
        playerRoles
      );
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
        if (note.partial) role.partial = note.partial;
        if (note.failure) role.failure = note.failure;
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
