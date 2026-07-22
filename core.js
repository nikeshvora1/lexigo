// ---------- core game logic ----------
// Pure, DOM-free logic shared by the app (app.js) and the test suite
// (test/core.test.js). Nothing in here may touch document / window /
// localStorage / fetch — that keeps it runnable under `node --test` with no
// browser and no dependencies. Anything that needs the dictionary takes the
// word Set as an argument instead of reaching for a module-level global.

// ---------- constants ----------
export const GAME_SECONDS = 60;
export const SEED_MAX = 1000000; // 6-digit numeric codes: 000000–999999 (1,000,000 boards)
export const MIN_VOWELS = 4; // guaranteed vowels per board
export const MAX_VOWELS = 8; // avoid vowel-flooded, low-scoring boards too
export const DAILY_MIN_WORDS = 100; // the daily board should feel full; practice/shared boards aren't held to this
// Daily puzzle #1 is 2026-07-21 in the player's LOCAL time (month is 0-indexed).
export const DAILY_EPOCH = new Date(2026, 6, 21);

// 4x4 word-dice (16 six-sided dice). Single-letter faces only — the classic
// "Qu" face is replaced with R so no tile ever shows two letters.
export const DICE = [
  ['A', 'A', 'E', 'E', 'G', 'N'],
  ['E', 'L', 'R', 'T', 'T', 'Y'],
  ['A', 'O', 'O', 'T', 'T', 'W'],
  ['A', 'B', 'B', 'J', 'O', 'O'],
  ['E', 'H', 'R', 'T', 'V', 'W'],
  ['C', 'I', 'M', 'O', 'T', 'U'],
  ['D', 'I', 'S', 'T', 'T', 'Y'],
  ['E', 'I', 'O', 'S', 'S', 'T'],
  ['D', 'E', 'L', 'R', 'V', 'Y'],
  ['A', 'C', 'H', 'O', 'P', 'S'],
  ['H', 'I', 'M', 'N', 'R', 'U'],
  ['E', 'E', 'I', 'N', 'S', 'U'],
  ['E', 'E', 'G', 'H', 'N', 'W'],
  ['A', 'F', 'F', 'K', 'P', 'S'],
  ['H', 'L', 'N', 'N', 'R', 'Z'],
  ['D', 'E', 'I', 'L', 'R', 'X'],
];

// ---------- seeded rng ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * SEED_MAX);
}

export function encodeSeed(seed) {
  return String(seed).padStart(6, '0'); // 6-digit numeric code
}

export function decodeCode(code) {
  const c = (code || '').trim().toUpperCase();
  // New canonical form: a 6-digit number.
  if (/^[0-9]{1,6}$/.test(c)) {
    const seed = parseInt(c, 10);
    return seed >= 0 && seed < SEED_MAX ? seed : null;
  }
  // Backward-compatible: old 6-char base-36 links (which contained letters)
  // still resolve to the exact board they always did.
  if (/^[0-9A-Z]{1,6}$/.test(c)) {
    const seed = parseInt(c, 36);
    return Number.isFinite(seed) && seed >= 0 ? seed : null;
  }
  return null;
}

// ---------- daily puzzle (local date) ----------
export function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function previousDayKey(date = new Date()) {
  const d = startOfLocalDay(date);
  d.setDate(d.getDate() - 1); // handles month/year/DST via the calendar API
  return dayKey(d);
}

export function dailyPuzzleNumber(date = new Date()) {
  const days = Math.round((startOfLocalDay(date) - DAILY_EPOCH) / 86400000);
  return days + 1; // epoch day is #1
}

// Deterministic seed from the local date, well-mixed so consecutive days are
// unrelated boards. Everyone on the same local calendar day gets this board.
export function dailySeed(date = new Date()) {
  const key = dayKey(date);
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) % SEED_MAX;
}

// The daily's seed nudged forward, still deterministically, until it lands
// on a board with at least DAILY_MIN_WORDS findable words. Practice/shared
// boards skip this — they use the raw seed straight into generateBoard.
// `words` is the dictionary Set; without it we can't count findable words, so
// we fall back to the raw daily seed (matches the app before the dict loads).
export function dailyGameSeed(words, date = new Date()) {
  let seed = dailySeed(date);
  if (!words || words.size === 0) return seed;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (findAllBoardWords(generateBoard(seed), words).size >= DAILY_MIN_WORDS) return seed;
    seed = (seed + 1) % SEED_MAX;
  }
  return seed;
}

export function msToNextLocalMidnight(now = new Date()) {
  const midnight = startOfLocalDay(now);
  midnight.setDate(midnight.getDate() + 1);
  return midnight - now;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

// ---------- streak logic ----------
// Pure counterparts of the localStorage-backed streak helpers in app.js. The
// app reads/writes storage; these decide the numbers, so the day-boundary rules
// can be tested without a browser. `stored` is the persisted daily record
// ({ day, streak, ... }) or null.
export function streakIfAlive(stored, today = dayKey(), prev = previousDayKey()) {
  if (!stored || !stored.streak) return 0;
  return stored.day === today || stored.day === prev ? stored.streak : 0;
}

export function nextStreak(stored, today = dayKey(), prev = previousDayKey()) {
  return stored && stored.day === prev ? (stored.streak || 0) + 1 : 1;
}

// ---------- board generation ----------
export const isVowelTile = (t) => 'AEIOU'.includes(t);

export function generateBoard(seed) {
  // Deterministic: same seed always yields the same board, so a shared code
  // reproduces it exactly. We keep drawing from the one seeded stream until a
  // board lands in the playable vowel range, re-rolling in place.
  const rand = mulberry32(seed);
  let board;
  for (let attempt = 0; attempt < 100; attempt++) {
    const order = DICE.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    board = order.map((dieIdx) => DICE[dieIdx][Math.floor(rand() * 6)]);
    const vowels = board.filter(isVowelTile).length;
    if (vowels >= MIN_VOWELS && vowels <= MAX_VOWELS) break;
  }
  return board;
}

// ---------- board geometry ----------
export const TILE = 74, GAP = 8, STEP = TILE + GAP;
export const rowOf = (i) => Math.floor(i / 4);
export const colOf = (i) => i % 4;
export const tileCenter = (i) => ({ x: colOf(i) * STEP + TILE / 2, y: rowOf(i) * STEP + TILE / 2 });
export const isAdjacent = (a, b) => {
  if (a === b) return false;
  return Math.abs(rowOf(a) - rowOf(b)) <= 1 && Math.abs(colOf(a) - colOf(b)) <= 1;
};

// ---------- scoring ----------
export function scoreForWord(word) {
  // Escalating: each extra letter is worth progressively more, so long words
  // are the exciting play in a 60-second round. 8+ keeps climbing +5/letter.
  const n = word.length;
  if (n < 3) return 0;
  if (n === 3) return 1;
  if (n === 4) return 2;
  if (n === 5) return 4;
  if (n === 6) return 7;
  if (n === 7) return 11;
  return 16 + (n - 8) * 5;
}

// Every valid word traceable on the board. A plain DFS explodes, so we first
// shrink the dictionary to words using only the board's letters, build a set
// of their prefixes, and prune any DFS path that stops being a live prefix.
// On a 4x4 board this runs in a few milliseconds. `words` is the dictionary Set.
export function findAllBoardWords(letters, words) {
  if (!words) return new Set();
  const tiles = letters.map((l) => l.toLowerCase());
  const allowed = new Set(tiles.join('').split(''));

  const wordSet = new Set();
  const prefixSet = new Set();
  for (const w of words) {
    let ok = true;
    for (let i = 0; i < w.length; i++) {
      if (!allowed.has(w[i])) { ok = false; break; }
    }
    if (!ok) continue;
    wordSet.add(w);
    for (let i = 1; i <= w.length; i++) prefixSet.add(w.slice(0, i));
  }

  const results = new Set();
  const visited = new Array(16).fill(false);
  function dfs(idx, str) {
    if (!prefixSet.has(str)) return; // dead prefix — stop
    if (str.length >= 3 && wordSet.has(str)) results.add(str);
    for (let n = 0; n < 16; n++) {
      if (visited[n] || !isAdjacent(idx, n)) continue;
      visited[n] = true;
      dfs(n, str + tiles[n]);
      visited[n] = false;
    }
  }
  for (let i = 0; i < 16; i++) {
    visited[i] = true;
    dfs(i, tiles[i]);
    visited[i] = false;
  }
  return results;
}
