// Transcript Review Agent
// Observer only — reads transcripts, reports findings, never edits engine files
// Run manually: node engine/agents/transcriptReviewer.js <scenarioId>
// Or via npm:   npm run review <scenarioId>

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths relative to engine/agents/
const SCENARIOS_DIR  = path.join(__dirname, '../data/scenarios');
const TRANSCRIPTS_DIR = path.join(__dirname, '../data/transcripts');
const REVIEWS_DIR    = path.join(__dirname, '../../data/reviews');

async function reviewTranscript(transcriptPath, scenario) {
  let transcript;
  try {
    transcript = await fs.readFile(transcriptPath, 'utf8');
  } catch (err) {
    console.error(`[SKIP] Cannot read ${transcriptPath}: ${err.message}`);
    return null;
  }

  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a prose quality reviewer for an immersive historical fiction engine. Read this session transcript and identify two categories of issue. Respond in JSON only.

CATEGORY 1 — SENSORY ANCHOR REPETITION:
These anchors are already in the config and should appear maximum once per session:
${JSON.stringify(scenario.overused_anchors || [])}

Count how many times each appears. Also identify any NEW physical sensations, smells, sounds, or character gestures that appear more than twice and are not yet in the list.

CATEGORY 2 — GOING WIDE VIOLATIONS:
Flag any sentence that:
- Explains what a character's behavior means
- Has the player character narrate their own realization
- Describes a situation as a type or pattern
- Explains the emotional register of dialogue

Return this exact JSON structure:
{
  "anchor_violations": [
    {
      "anchor": "phrase that repeated",
      "count": 3,
      "in_config": true,
      "example_turns": ["turn number or quote"]
    }
  ],
  "new_anchor_candidates": [
    {
      "phrase": "new repeating phrase",
      "count": 3,
      "recommendation": "add to overused_anchors"
    }
  ],
  "going_wide_violations": [
    {
      "sentence": "the offending sentence",
      "type": "character narrating own realization",
      "turn": "approximate turn number"
    }
  ],
  "summary": {
    "total_anchor_violations": 0,
    "total_new_candidates": 0,
    "total_going_wide": 0,
    "priority": "low|medium|high"
  }
}

TRANSCRIPT:
${transcript}`
      }]
    });
  } catch (err) {
    console.error(`[SKIP] Anthropic API error for ${transcriptPath}: ${err.message}`);
    return null;
  }

  const text = response.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function detectCrossSessionPatterns(reviews) {
  const candidateCounts = {};

  reviews.forEach(review => {
    if (!review) return;
    review.new_anchor_candidates?.forEach(candidate => {
      const key = candidate.phrase.toLowerCase();
      candidateCounts[key] = (candidateCounts[key] || 0) + 1;
    });
  });

  const highPriority = Object.entries(candidateCounts)
    .filter(([, count]) => count >= 3)
    .map(([phrase, count]) => ({
      phrase,
      sessions: count,
      recommendation: 'HIGH PRIORITY — add to overused_anchors'
    }));

  return highPriority;
}

async function writeReviewReport(scenarioId, reviews, patterns) {
  const reportPath = path.join(REVIEWS_DIR, `${scenarioId}_review.md`);

  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  const timestamp = new Date().toISOString();
  const totalSessions = reviews.length;
  const totalViolations = reviews.reduce((sum, r) =>
    sum + (r?.summary?.total_anchor_violations || 0), 0);

  let report = `\n---\n`;
  report += `## Review Run: ${timestamp}\n`;
  report += `Sessions reviewed: ${totalSessions}\n`;
  report += `Total anchor violations: ${totalViolations}\n\n`;

  if (patterns.length > 0) {
    report += `### HIGH PRIORITY — Add to overused_anchors:\n`;
    patterns.forEach(p => {
      report += `- "${p.phrase}" — appeared in ${p.sessions} sessions\n`;
    });
    report += `\n`;
  }

  reviews.forEach((review, i) => {
    if (!review || review.summary.priority === 'low') return;
    report += `### Session ${i + 1}\n`;

    if (review.anchor_violations.length > 0) {
      report += `**Anchor violations:**\n`;
      review.anchor_violations.forEach(v => {
        report += `- "${v.anchor}" appeared ${v.count} times\n`;
      });
    }

    if (review.going_wide_violations.length > 0) {
      report += `**Going wide:**\n`;
      review.going_wide_violations.slice(0, 3).forEach(v => {
        report += `- ${v.type}: "${v.sentence.substring(0, 80)}..."\n`;
      });
    }

    report += `\n`;
  });

  await fs.appendFile(reportPath, report);
  return reportPath;
}

async function runReview(scenarioId) {
  const scenarioPath = path.join(SCENARIOS_DIR, `${scenarioId}.json`);

  let scenario;
  try {
    scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
  } catch (err) {
    console.error(`Cannot load scenario "${scenarioId}": ${err.message}`);
    process.exit(1);
  }

  let files;
  try {
    files = await fs.readdir(TRANSCRIPTS_DIR);
  } catch {
    console.log('No transcripts directory found — nothing to review.');
    return;
  }

  const scenarioTranscripts = files
    .filter(f => f.endsWith('.md'))
    .sort()
    .slice(-20);

  if (scenarioTranscripts.length === 0) {
    console.log(`No transcripts found in ${TRANSCRIPTS_DIR}`);
    return;
  }

  console.log(`Reviewing ${scenarioTranscripts.length} transcripts for ${scenarioId}`);

  const reviews = await Promise.all(
    scenarioTranscripts.map(f =>
      reviewTranscript(path.join(TRANSCRIPTS_DIR, f), scenario)
    )
  );

  const patterns = await detectCrossSessionPatterns(reviews);
  const reportPath = await writeReviewReport(scenarioId, reviews, patterns);

  console.log(`Review complete. Report written to: ${reportPath}`);

  if (patterns.length > 0) {
    console.log('\nHIGH PRIORITY ADDITIONS FOR overused_anchors:');
    patterns.forEach(p => console.log(`  - "${p.phrase}"`));
    console.log('\nAdd these to the scenario config manually after review.');
  }
}

const scenarioId = process.argv[2] || 'midnight_errand_boston';
runReview(scenarioId).catch(console.error);
