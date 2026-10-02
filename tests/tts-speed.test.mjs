#!/usr/bin/env node
// /tts narration speed: the speed the request asks for reaches ElevenLabs on EVERY request —
// a lone narration segment (a plain turn, the closing narration, the historical intro) as well
// as one behind a confirmation / bridge / sensory line — and an out-of-range stored speed
// (tts_narration_speed: 0) falls back to the voice default instead of failing the request.
// The lead segments keep their own slower pacing (confirmation 0.85, bridge and sensory 0.88).
//
// No ElevenLabs calls: api.elevenlabs.io is scripted, and each request's voice_settings recorded.
import express from 'express';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).href;
const { createGameRouter } = await import(`${ROOT}/engine/server/gameRouter.js`);

let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  — ${detail}` : ''}`); };

const app = express();
app.use(express.json());
app.use('/game/api', createGameRouter({}, { anthropicApiKey: 'tts-speed-test', elevenLabsApiKey: 'tts-speed-test', elevenLabsVoiceId: 'voice' }));
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Script ElevenLabs: record each call's text + voice_settings, answer with a few bytes of "audio".
const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.elevenlabs.io/')) {
    const body = JSON.parse(opts.body);
    calls.push({ text: body.text, speed: body.voice_settings?.speed });
    return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }
  return realFetch(url, opts);
};
async function tts(body) {
  calls = [];
  const r = await realFetch(`${BASE}/game/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await r.arrayBuffer();
  return { status: r.status, speeds: calls.map(c => c.speed) };
}

try {
  let r = await tts({ text: 'Narration only.', narrative_speed: 0.85 });
  check('single segment: narrative_speed is applied (closing narration 0.85)', r.status === 200 && r.speeds.join() === '0.85', r.speeds.join());
  r = await tts({ text: 'Narration only.', narrative_speed: 1.1 });
  check('single segment: a scenario speed (1.1) is applied — plain turn / historical intro', r.status === 200 && r.speeds.join() === '1.1', r.speeds.join());
  r = await tts({ text: 'Narration only.' });
  check('single segment, no speed sent: the voice default (0.9)', r.status === 200 && r.speeds.join() === '0.9', r.speeds.join());
  r = await tts({ text: 'Narration only.', narrative_speed: 0 });
  check('single segment, out-of-range speed 0: default 0.9, request does not fail', r.status === 200 && r.speeds.join() === '0.9', `${r.status} ${r.speeds.join()}`);

  r = await tts({ text: 'Narration.', confirmation: 'You wait.', bridge: 'Weeks pass.', sensory_opening: 'Cold stone.', narrative_speed: 1.1 });
  check('multi segment: confirmation 0.85, bridge 0.88, sensory 0.88, narration the scenario speed', r.status === 200 && r.speeds.join() === '0.85,0.88,0.88,1.1', r.speeds.join());
  r = await tts({ text: 'Narration.', sensory_opening: 'Cold stone.' });
  check('multi segment, no speed sent: sensory 0.88, narration default 0.9', r.status === 200 && r.speeds.join() === '0.88,0.9', r.speeds.join());
  r = await tts({ text: 'Narration.', sensory_opening: 'Cold stone.', narrative_speed: 0 });
  check('multi segment, out-of-range speed 0: narration default 0.9, never speed 0', r.status === 200 && r.speeds.join() === '0.88,0.9', `${r.status} ${r.speeds.join()}`);
  for (const bad of [0.5, 1.5, '1.0', null]) {
    r = await tts({ text: 'Narration only.', narrative_speed: bad });
    check(`invalid speed ${JSON.stringify(bad)}: ignored → default 0.9`, r.status === 200 && r.speeds.join() === '0.9', r.speeds.join());
  }
} finally {
  globalThis.fetch = realFetch;
  // Close the keep-alive sockets and wait: exiting while they close aborts node on Windows.
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}

console.log(fails ? `\n${fails} assertion(s) failed.` : '\nAll tts-speed assertions passed.');
process.exitCode = fails ? 1 : 0;   // let node drain and exit on its own — process.exit() here aborts on Windows (libuv async handle)
