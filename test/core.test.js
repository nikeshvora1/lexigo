// Zero-dependency unit tests for the pure game logic in core.js.
// Run with:  node --test
// No browser, no npm, no node_modules — just Node's built-in test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SEED_MAX, MIN_VOWELS, MAX_VOWELS, DAILY_MIN_WORDS, DAILY_EPOCH,
  encodeSeed, decodeCode, mulberry32,
  dayKey, previousDayKey, dailyPuzzleNumber, dailySeed, dailyGameSeed,
  formatCountdown, msToNextLocalMidnight,
  streakIfAlive, nextStreak,
  generateBoard, isVowelTile, isAdjacent, tileCenter,
  scoreForWord, findAllBoardWords,
} from '../core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Load the real dictionary once for the integration-flavoured tests.
const WORDS = new Set(
  readFileSync(join(HERE, '..', 'words.txt'), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean),
);

// ---------- scoring ----------
test('scoreForWord: escalating table + 8+ tail', () => {
  assert.equal(scoreForWord('ab'), 0);       // < 3 letters never scores
  assert.equal(scoreForWord('cat'), 1);      // 3
  assert.equal(scoreForWord('cats'), 2);     // 4
  assert.equal(scoreForWord('catty'), 4);    // 5
  assert.equal(scoreForWord('catnip'), 7);   // 6
  assert.equal(scoreForWord('catnaps'), 11); // 7
  assert.equal(scoreForWord('a'.repeat(8)), 16);
  assert.equal(scoreForWord('a'.repeat(9)), 21);  // +5 per letter past 8
  assert.equal(scoreForWord('a'.repeat(12)), 36);
});

// ---------- seed encode / decode ----------
test('encodeSeed pads to a 6-digit code', () => {
  assert.equal(encodeSeed(0), '000000');
  assert.equal(encodeSeed(42), '000042');
  assert.equal(encodeSeed(999999), '999999');
});

test('decodeCode round-trips numeric codes', () => {
  for (const seed of [0, 1, 42, 100000, 999999]) {
    assert.equal(decodeCode(encodeSeed(seed)), seed);
  }
});

test('decodeCode normalizes whitespace/case and rejects junk', () => {
  assert.equal(decodeCode('  042 '), 42);
  assert.equal(decodeCode(''), null);
  assert.equal(decodeCode(null), null);
  assert.equal(decodeCode('!!'), null);
  assert.equal(decodeCode(String(SEED_MAX)), null);       // out of range (>= 1e6)
  assert.equal(decodeCode('9999999'), null);              // 7 digits, too long
});

test('decodeCode still resolves legacy base-36 links', () => {
  // Old 6-char codes could contain letters; they must map to the same seed.
  assert.equal(decodeCode('000Z'), 35);                    // Z = 35 in base-36
  assert.ok(Number.isInteger(decodeCode('ABC1')));
});

// ---------- rng determinism ----------
test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(123), b = mulberry32(123);
  for (let i = 0; i < 5; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

// ---------- board generation ----------
test('generateBoard is deterministic for a given seed', () => {
  for (const seed of [0, 7, 42, 999999]) {
    assert.deepEqual(generateBoard(seed), generateBoard(seed));
  }
});

test('generateBoard yields 16 single-letter tiles within the vowel range', () => {
  for (const seed of [0, 1, 2, 3, 100, 12345, 999999]) {
    const board = generateBoard(seed);
    assert.equal(board.length, 16);
    assert.ok(board.every((t) => typeof t === 'string' && t.length === 1));
    const vowels = board.filter(isVowelTile).length;
    assert.ok(vowels >= MIN_VOWELS && vowels <= MAX_VOWELS, `seed ${seed} had ${vowels} vowels`);
  }
});

// ---------- geometry ----------
test('isAdjacent matches 4x4 neighbours', () => {
  assert.equal(isAdjacent(0, 0), false);   // self is never adjacent
  assert.equal(isAdjacent(0, 1), true);    // right
  assert.equal(isAdjacent(0, 4), true);    // down
  assert.equal(isAdjacent(0, 5), true);    // diagonal
  assert.equal(isAdjacent(0, 2), false);   // two columns over
  assert.equal(isAdjacent(3, 4), false);   // row wrap (col 3 -> col 0) must not count
});

test('tileCenter geometry is on the grid', () => {
  assert.deepEqual(tileCenter(0), { x: 37, y: 37 });
  assert.deepEqual(tileCenter(5), { x: 119, y: 119 });
});

// ---------- daily / date logic ----------
test('dayKey and previousDayKey handle month boundaries', () => {
  assert.equal(dayKey(new Date(2026, 6, 1)), '2026-7-1');
  assert.equal(previousDayKey(new Date(2026, 6, 1)), '2026-6-30'); // crosses into June
  assert.equal(previousDayKey(new Date(2026, 0, 1)), '2025-12-31'); // crosses year
});

test('dailyPuzzleNumber counts from the epoch (day 1)', () => {
  assert.equal(dailyPuzzleNumber(DAILY_EPOCH), 1);
  assert.equal(dailyPuzzleNumber(new Date(2026, 6, 22)), 2);
});

test('dailySeed is deterministic per date and spreads across days', () => {
  const d = new Date(2026, 6, 21);
  assert.equal(dailySeed(d), dailySeed(new Date(2026, 6, 21)));
  const seeds = new Set();
  for (let i = 0; i < 30; i++) seeds.add(dailySeed(new Date(2026, 6, 21 + i)));
  assert.ok(seeds.size >= 28, `expected ~distinct seeds, got ${seeds.size}`); // barely any collisions
  for (const s of seeds) assert.ok(s >= 0 && s < SEED_MAX);
});

test('dailyGameSeed falls back to raw dailySeed without a dictionary', () => {
  const d = new Date(2026, 6, 21);
  assert.equal(dailyGameSeed(null, d), dailySeed(d));
  assert.equal(dailyGameSeed(new Set(), d), dailySeed(d));
});

test('dailyGameSeed picks a board meeting the daily word floor', () => {
  const d = new Date(2026, 6, 21);
  const seed = dailyGameSeed(WORDS, d);
  assert.ok(findAllBoardWords(generateBoard(seed), WORDS).size >= DAILY_MIN_WORDS);
});

// ---------- countdown ----------
test('formatCountdown renders hh:mm:ss and clamps negatives', () => {
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(-5000), '00:00:00');
  assert.equal(formatCountdown((3 * 3600 + 4 * 60 + 5) * 1000), '03:04:05');
});

test('msToNextLocalMidnight is positive and under a day', () => {
  const ms = msToNextLocalMidnight(new Date(2026, 6, 21, 23, 0, 0));
  assert.equal(ms, 60 * 60 * 1000); // 23:00 -> midnight is exactly 1h
});

// ---------- streak logic ----------
test('streakIfAlive keeps a streak alive only through yesterday', () => {
  const today = '2026-7-21', prev = '2026-7-20';
  assert.equal(streakIfAlive(null, today, prev), 0);
  assert.equal(streakIfAlive({ day: today, streak: 5 }, today, prev), 5);
  assert.equal(streakIfAlive({ day: prev, streak: 5 }, today, prev), 5);
  assert.equal(streakIfAlive({ day: '2026-7-19', streak: 5 }, today, prev), 0); // missed a day
  assert.equal(streakIfAlive({ day: prev, streak: 0 }, today, prev), 0);
});

test('nextStreak increments off yesterday, else resets to 1', () => {
  const today = '2026-7-21', prev = '2026-7-20';
  assert.equal(nextStreak(null, today, prev), 1);
  assert.equal(nextStreak({ day: prev, streak: 3 }, today, prev), 4);   // continued
  assert.equal(nextStreak({ day: '2026-7-18', streak: 3 }, today, prev), 1); // broken -> reset
});

// ---------- board word search ----------
test('findAllBoardWords needs a dictionary', () => {
  assert.equal(findAllBoardWords(['A'.repeat(1)].concat(Array(15).fill('A')), null).size, 0);
});

test('findAllBoardWords traces adjacent paths and enforces 3+ length', () => {
  // C A T along the top row (indices 0,1,2), rest filler that spells nothing.
  const board = ['C', 'A', 'T', 'S', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z'];
  const dict = new Set(['ca', 'cat', 'cats', 'cac']); // 'ca' too short, 'cac' needs the lone C twice
  const found = findAllBoardWords(board, dict);
  assert.ok(found.has('cat'));
  assert.ok(found.has('cats')); // 0->1->2->3 all adjacent
  assert.ok(!found.has('ca'));  // under 3 letters, never returned
  assert.ok(!found.has('cac')); // the single C tile can't be reused
});

test('findAllBoardWords rejects non-adjacent letter placements', () => {
  // C at corner 0, A at opposite corner 15 — 'cat' cannot be traced.
  const board = ['C', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'Z', 'T', 'Z', 'Z', 'Z', 'A'];
  const found = findAllBoardWords(board, new Set(['cat']));
  assert.ok(!found.has('cat'));
});
