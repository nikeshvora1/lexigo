// Curates the practice-mode seed manifest (../seeds.js).
//
//   node scripts/generate-seeds.mjs [--count 500] [--scan 40000]
//
// Difficulty here is "how many findable words does this board have". A 60-second
// round on a 50-word board is a genuinely different game from one on a 160-word
// board, and the count is a good proxy for the player's experience: across a
// 600-board sample, total word count correlates 0.95 with the count of <=4
// letter words, which is what people actually find under time pressure.
//
// Boards are scored with core.js's own findAllBoardWords / generateBoard, so the
// manifest can never disagree with the game about what a seed produces. That
// also makes this slow (~7ms/board — the dictionary is 170k words); a full run
// is a couple of minutes. It's an offline tool, run rarely.
//
// Anything that changes DICE, the vowel bounds, or words.txt invalidates the
// manifest. `node --test` re-verifies a sample of it against live core.js, so
// drift fails the commit gate rather than silently shipping mislabelled boards.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DIFFICULTIES, SEED_MAX, generateBoard, findAllBoardWords } from '../core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const PER_MODE = arg('count', 500);
const MAX_SCAN = arg('scan', 40000);

// A board needs at least one long word to be worth chasing — the escalating
// score curve means a 6+ letter find is the play that decides a round. Boards
// without one are technically in-band but flat to play.
const MIN_LONGEST = 6;

// Walk the seed space with a full-period stride instead of counting 0,1,2,…, so
// the curated codes are spread across all six digits rather than clustered in
// 000xxx. 104729 is prime and therefore coprime with SEED_MAX, which makes
// seed(i) hit every value exactly once over SEED_MAX steps.
const STRIDE = 104729;

const WORDS = new Set(
  readFileSync(join(ROOT, 'words.txt'), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean),
);

// Two boards with the same letters in a different arrangement play almost
// identically. Keyed on the sorted letter multiset, we keep only the first.
const letterKey = (letters) => letters.slice().sort().join('');

const picks = Object.fromEntries(Object.keys(DIFFICULTIES).map((k) => [k, []]));
const seenLetters = new Set();
const full = () => Object.values(picks).every((list) => list.length >= PER_MODE);

const started = Date.now();
let scanned = 0;
for (let i = 0; i < MAX_SCAN && !full(); i++) {
  const seed = (i * STRIDE) % SEED_MAX;
  scanned++;

  const letters = generateBoard(seed);
  const key = letterKey(letters);
  if (seenLetters.has(key)) continue;

  const found = findAllBoardWords(letters, WORDS);
  const total = found.size;

  const band = Object.entries(DIFFICULTIES)
    .find(([, b]) => total >= b.min && total <= b.max);
  if (!band) continue;
  const [name, ] = band;
  if (picks[name].length >= PER_MODE) continue;

  let longest = 0;
  for (const w of found) if (w.length > longest) longest = w.length;
  if (longest < MIN_LONGEST) continue;

  seenLetters.add(key);
  picks[name].push([seed, total]);

  if (scanned % 2000 === 0) {
    const counts = Object.entries(picks).map(([k, v]) => `${k} ${v.length}`).join('  ');
    process.stderr.write(`scanned ${scanned}  ${counts}  ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  }
}

// Sorting by seed keeps the diff of a regenerated manifest readable; the app
// picks from the list at random, so order carries no meaning in the game.
for (const list of Object.values(picks)) list.sort((a, b) => a[0] - b[0]);

const short = Object.entries(picks).filter(([, v]) => v.length < PER_MODE);
if (short.length) {
  process.stderr.write(
    `\nWARNING: under target after ${scanned} seeds — ` +
    short.map(([k, v]) => `${k} ${v.length}/${PER_MODE}`).join(', ') +
    `\nRe-run with a larger --scan.\n`,
  );
}

// Wrap the pair list so the generated file stays scannable by eye.
function formatPairs(pairs) {
  const cells = pairs.map(([s, n]) => `[${s},${n}]`);
  const lines = [];
  for (let i = 0; i < cells.length; i += 6) lines.push('    ' + cells.slice(i, i + 6).join(', ') + ',');
  return lines.join('\n');
}

const summary = Object.entries(picks).map(([name, list]) => {
  const counts = list.map(([, n]) => n);
  const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
  const band = DIFFICULTIES[name];
  const range = band.max === Infinity ? `${band.min}+` : `${band.min}-${band.max}`;
  return `//   ${name.padEnd(6)} ${String(list.length).padStart(4)} boards  band ${range.padEnd(7)} ` +
    `words ${Math.min(...counts)}-${Math.max(...counts)} (avg ${avg.toFixed(0)})`;
}).join('\n');

const body = `// GENERATED FILE — do not edit by hand.
// Regenerate with:  node scripts/generate-seeds.mjs
//
// Curated practice boards, one list per difficulty. Each entry is
// [seed, findableWordCount] — the count is what core.js's findAllBoardWords
// returns for that board against words.txt, and it drives both the difficulty
// band and the "you found N of M" line on the summary screen.
//
// Generated ${new Date().toISOString().slice(0, 10)} from ${scanned.toLocaleString('en-US')} scanned seeds.
${summary}
//
// The bands themselves live in core.js (DIFFICULTIES) — this file only records
// which seeds fell in them.

export const PRACTICE_SEEDS = {
${Object.entries(picks).map(([name, list]) => `  ${name}: [\n${formatPairs(list)}\n  ],`).join('\n')}
};
`;

mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, 'seeds.js'), body);

process.stderr.write(`\nWrote seeds.js — ${scanned.toLocaleString('en-US')} seeds scanned in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
process.stderr.write(summary.replace(/\/\/ {3}/g, '  ') + '\n');
