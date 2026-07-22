(() => {
  'use strict';

  // ---------- constants ----------
  const GAME_SECONDS = 60;
  const SEED_MAX = 1000000; // 6-digit numeric codes: 000000–999999 (1,000,000 boards)
  const BEST_SCORE_KEY = 'lexigo:best-score';
  const MIN_VOWELS = 4; // guaranteed vowels per board
  const MAX_VOWELS = 8; // avoid vowel-flooded, low-scoring boards too
  const DAILY_MIN_WORDS = 100; // the daily board should feel full; practice/shared boards aren't held to this
  // Daily puzzle #1 is 2026-07-21 in the player's LOCAL time (month is 0-indexed).
  const DAILY_EPOCH = new Date(2026, 6, 21);

  // 4x4 word-dice (16 six-sided dice). Single-letter faces only — the classic
  // "Qu" face is replaced with R so no tile ever shows two letters.
  const DICE = [
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
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    return Math.floor(Math.random() * SEED_MAX);
  }

  function encodeSeed(seed) {
    return String(seed).padStart(6, '0'); // 6-digit numeric code
  }

  function decodeCode(code) {
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
  const DAILY_KEY = 'lexigo:daily';

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function previousDayKey(date = new Date()) {
    const d = startOfLocalDay(date);
    d.setDate(d.getDate() - 1); // handles month/year/DST via the calendar API
    return dayKey(d);
  }

  function dailyPuzzleNumber(date = new Date()) {
    const days = Math.round((startOfLocalDay(date) - DAILY_EPOCH) / 86400000);
    return days + 1; // epoch day is #1
  }

  // Deterministic seed from the local date, well-mixed so consecutive days are
  // unrelated boards. Everyone on the same local calendar day gets this board.
  function dailySeed(date = new Date()) {
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
  function dailyGameSeed(date = new Date()) {
    let seed = dailySeed(date);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (findAllBoardWords(generateBoard(seed)).size >= DAILY_MIN_WORDS) return seed;
      seed = (seed + 1) % SEED_MAX;
    }
    return seed;
  }

  // Per-device daily record: { day, score, words, puzzle, streak }.
  function loadDaily() {
    try { return JSON.parse(localStorage.getItem(DAILY_KEY)) || null; } catch (_) { return null; }
  }
  function saveDaily(obj) {
    try { localStorage.setItem(DAILY_KEY, JSON.stringify(obj)); } catch (_) { /* ignore */ }
  }
  function playedTodaysDaily() {
    const d = loadDaily();
    return !!(d && d.day === dayKey());
  }
  // Streak only counts if still alive — the last recorded day is today or
  // yesterday. Otherwise a day was missed and the streak is broken.
  function activeStreak() {
    const d = loadDaily();
    if (!d || !d.streak) return 0;
    return d.day === dayKey() || d.day === previousDayKey() ? d.streak : 0;
  }
  // Record today's daily result once; keep the first attempt if replayed.
  function recordDailyResult(score, words, puzzle) {
    const today = dayKey();
    const stored = loadDaily();
    if (stored && stored.day === today) return; // already recorded today
    const streak = stored && stored.day === previousDayKey() ? (stored.streak || 0) + 1 : 1;
    saveDaily({ day: today, score, words, puzzle, streak });
  }

  function msToNextLocalMidnight() {
    const now = new Date();
    const midnight = startOfLocalDay(now);
    midnight.setDate(midnight.getDate() + 1);
    return midnight - now;
  }
  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  const isVowelTile = (t) => 'AEIOU'.includes(t);

  function generateBoard(seed) {
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
  const TILE = 74, GAP = 8, STEP = TILE + GAP;
  const rowOf = (i) => Math.floor(i / 4);
  const colOf = (i) => i % 4;
  const tileCenter = (i) => ({ x: colOf(i) * STEP + TILE / 2, y: rowOf(i) * STEP + TILE / 2 });
  const isAdjacent = (a, b) => {
    if (a === b) return false;
    return Math.abs(rowOf(a) - rowOf(b)) <= 1 && Math.abs(colOf(a) - colOf(b)) <= 1;
  };

  function scoreForWord(word) {
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
  // On a 4x4 board this runs in a few milliseconds.
  function findAllBoardWords(letters) {
    if (!WORDS) return new Set();
    const tiles = letters.map((l) => l.toLowerCase());
    const allowed = new Set(tiles.join('').split(''));

    const wordSet = new Set();
    const prefixSet = new Set();
    for (const w of WORDS) {
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

  // ---------- dictionary ----------
  let WORDS = null;
  const dictReady = fetch('words.txt')
    .then((r) => r.text())
    .then((text) => {
      WORDS = new Set(text.split('\n').map((w) => w.trim()).filter(Boolean));
    })
    .catch(() => {
      WORDS = new Set();
      showToast("Couldn't load the dictionary — words.txt missing?");
    });

  // ---------- dom refs ----------
  const $ = (id) => document.getElementById(id);
  const screens = {
    start: $('screen-start'),
    play: $('screen-play'),
    summary: $('screen-summary'),
  };
  const boardEl = $('board');
  const boardWrap = document.querySelector('.board-wrap');
  const toastEl = $('toast');

  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  }

  function showToast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ---------- game state ----------
  let state = null;

  function newState(seed, mode) {
    return {
      seed,
      code: encodeSeed(seed),
      mode, // 'daily' | 'practice' | 'shared'
      puzzleNumber: mode === 'daily' ? dailyPuzzleNumber() : null,
      letters: generateBoard(seed),
      score: 0,
      foundSet: new Set(),
      foundList: [],
      timeLeft: GAME_SECONDS,
      timerHandle: null,
      paused: false,
      path: [],
    };
  }

  // How this game is labelled in the play header and summary sub-line.
  function gameLabel() {
    return state.mode === 'daily'
      ? "Today's Lexigo"
      : `Game ${state.code}`;
  }

  function bestScore() {
    return Number(localStorage.getItem(BEST_SCORE_KEY) || 0);
  }
  function maybeSaveBestScore(score) {
    if (score > bestScore()) localStorage.setItem(BEST_SCORE_KEY, String(score));
  }

  // ---------- rendering: board ----------
  function renderBoard() {
    boardEl.innerHTML = '';
    state.letters.forEach((letter, idx) => {
      const div = document.createElement('div');
      div.className = 'tile';
      div.textContent = letter;
      div.dataset.idx = String(idx);
      boardEl.appendChild(div);
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'trace');
    svg.setAttribute('viewBox', '0 0 320 320');
    svg.id = 'trace-svg';
    boardEl.appendChild(svg);
  }

  function updateTileClasses() {
    boardEl.querySelectorAll('.tile').forEach((el) => {
      const idx = Number(el.dataset.idx);
      el.classList.toggle('active', state.path.includes(idx));
    });
  }

  function updateTraceSVG() {
    const svg = $('trace-svg');
    svg.innerHTML = '';
    if (state.path.length === 0) return;
    const pts = state.path.map((i) => tileCenter(i));
    if (pts.length > 1) {
      const poly = document.createElementNS(svg.namespaceURI, 'polyline');
      poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', 'var(--color-accent-600)');
      poly.setAttribute('stroke-width', '13');
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.setAttribute('opacity', '0.6');
      svg.appendChild(poly);
    }
    const start = pts[0];
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    circle.setAttribute('cx', String(start.x));
    circle.setAttribute('cy', String(start.y));
    circle.setAttribute('r', '9');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '3');
    svg.appendChild(circle);
  }

  // ---------- word banner ----------
  const banner = $('word-banner'), wbWord = $('wb-word'), wbPts = $('wb-pts');
  function flashBanner(text, pts, kind) {
    wbWord.textContent = text;
    wbPts.textContent = pts != null ? `+${pts}` : '';
    banner.classList.toggle('invalid', kind !== 'valid');
    banner.classList.add('show');
    clearTimeout(flashBanner._t);
    flashBanner._t = setTimeout(() => banner.classList.remove('show'), 1100);
  }

  // ---------- found list ----------
  function renderFoundList() {
    $('found-count').textContent = `Found · ${state.foundList.length}`;
    const list = $('found-list');
    list.innerHTML = '';
    state.foundList.forEach(({ word, pts }) => {
      const span = document.createElement('span');
      span.className = 'wtag';
      span.innerHTML = `${word} <i>${pts}</i>`;
      list.appendChild(span);
    });
    list.scrollTop = list.scrollHeight;
  }

  function updateScoreHud() {
    $('hud-score').textContent = String(state.score).padStart(3, '0');
  }

  // ---------- pointer path tracing ----------
  let pointerActive = false;

  // Only count a tile when the pointer is near its centre, not anywhere inside
  // it. A diagonal swipe grazes the edge of the orthogonal tile it passes; the
  // centre check keeps that graze from being registered as an extra step.
  const HIT_RADIUS_RATIO = 0.40;

  function tileFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const tile = el.closest('.tile');
    if (!tile || !boardEl.contains(tile)) return null;
    const r = tile.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const radius = r.width * HIT_RADIUS_RATIO;
    if (dx * dx + dy * dy > radius * radius) return null;
    return Number(tile.dataset.idx);
  }

  function onPointerDown(e) {
    if (!state || state.paused || screens.play.classList.contains('hidden')) return;
    const idx = tileFromPoint(e.clientX, e.clientY);
    if (idx == null) return;
    e.preventDefault();
    pointerActive = true;
    state.path = [idx];
    updateTileClasses();
    updateTraceSVG();
  }

  function onPointerMove(e) {
    if (!pointerActive || !state) return;
    const idx = tileFromPoint(e.clientX, e.clientY);
    if (idx == null) return;
    const path = state.path;
    if (path.length >= 2 && idx === path[path.length - 2]) {
      path.pop();
      updateTileClasses();
      updateTraceSVG();
    } else if (!path.includes(idx) && isAdjacent(path[path.length - 1], idx)) {
      path.push(idx);
      updateTileClasses();
      updateTraceSVG();
    }
  }

  function onPointerUp() {
    if (!pointerActive || !state) return;
    pointerActive = false;
    submitPath();
  }

  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);

  function submitPath() {
    const path = state.path;
    state.path = [];
    if (path.length < 3) {
      updateTileClasses();
      updateTraceSVG();
      return;
    }
    const word = path.map((i) => state.letters[i].toLowerCase()).join('');
    updateTileClasses();
    updateTraceSVG();

    if (state.foundSet.has(word)) {
      flashBanner(word.toUpperCase(), null, 'dup');
      return;
    }
    if (!WORDS || !WORDS.has(word)) {
      flashBanner(word.toUpperCase(), null, 'invalid');
      return;
    }
    const pts = scoreForWord(word);
    state.foundSet.add(word);
    state.foundList.push({ word: word.toUpperCase(), pts });
    state.score += pts;
    updateScoreHud();
    renderFoundList();
    flashBanner(word.toUpperCase(), pts, 'valid');
  }

  // ---------- timer ----------
  function formatTime(s) {
    s = Math.max(0, s); // never render a negative clock
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function updateTimerHud() {
    const el = $('hud-time');
    el.textContent = formatTime(state.timeLeft);
    el.classList.toggle('warn', state.timeLeft <= 10 && state.timeLeft > 0);
  }

  function startTimer() {
    stopTimer();
    state.timerHandle = setInterval(() => {
      state.timeLeft -= 1;
      if (state.timeLeft <= 0) {
        // Stop the clock BEFORE ending the game: if endGame ever throws, the
        // interval is already cleared so it can't run on into negative time.
        state.timeLeft = 0;
        stopTimer();
        updateTimerHud();
        endGame();
        return;
      }
      updateTimerHud();
    }, 1000);
  }
  function stopTimer() {
    if (state.timerHandle) clearInterval(state.timerHandle);
    state.timerHandle = null;
  }

  // ---------- pause ----------
  function setPaused(paused) {
    state.paused = paused;
    $('pause-overlay').classList.toggle('hidden', !paused);
    boardWrap.classList.toggle('paused', paused);
    $('icon-pause').classList.toggle('hidden', paused);
    $('icon-play').classList.toggle('hidden', !paused);
    if (paused) stopTimer(); else startTimer();
  }

  // ---------- game flow ----------
  function shareUrl(code) {
    return `${location.origin}${location.pathname}?g=${code}`;
  }

  function startGame(seed, mode = 'practice') {
    if (state) stopTimer(); // clear a prior game's timer before we replace state
    state = newState(seed, mode);
    history.replaceState(null, '', `?g=${state.code}`);
    $('game-code-tag').textContent = state.mode === 'daily'
      ? "TODAY'S LEXIGO"
      : `GAME ${state.code}`;
    renderBoard();
    updateScoreHud();
    updateTimerHud();
    renderFoundList();
    banner.classList.remove('show');
    setPaused(false); // also (re)starts the timer
    showScreen('play');
  }

  function renderChips(container, items, extraClass) {
    const frag = document.createDocumentFragment();
    items.forEach(({ word, pts }) => {
      const span = document.createElement('span');
      span.className = extraClass ? `wtag ${extraClass}` : 'wtag';
      span.innerHTML = `${word} <i>${pts}</i>`;
      frag.appendChild(span);
    });
    container.innerHTML = '';
    container.appendChild(frag);
  }

  function endGame() {
    stopTimer();
    maybeSaveBestScore(state.score);
    if (state.mode === 'daily') {
      recordDailyResult(state.score, state.foundList.length, state.puzzleNumber);
    }
    const { score, foundList, foundSet } = state;
    $('summary-sub').textContent = `Time's up · ${gameLabel()}`;
    $('summary-score').textContent = String(score);
    $('summary-words').textContent = String(foundList.length);
    const best = foundList.reduce((a, b) => {
      if (!a) return b;
      if (b.pts !== a.pts) return b.pts > a.pts ? b : a;
      return b.word.length > a.word.length ? b : a;
    }, null);
    $('summary-best-word').textContent = best ? best.word : '—';

    renderChips($('summary-list'), foundList);
    showScreen('summary');

    // Missed words: every valid board word the player didn't find, best first.
    // Deferred a tick so the summary paints immediately, then fills in.
    $('found-label').textContent = `Your words · ${foundList.length}`;
    $('missed-label').textContent = 'Finding every word…';
    $('missed-list').innerHTML = '';
    const boardLetters = state.letters.slice();
    setTimeout(() => {
      const all = findAllBoardWords(boardLetters);
      const missed = [];
      all.forEach((w) => {
        if (!foundSet.has(w)) missed.push({ word: w.toUpperCase(), pts: scoreForWord(w) });
      });
      missed.sort((a, b) => b.word.length - a.word.length || (a.word < b.word ? -1 : 1));
      $('found-label').textContent = all.size
        ? `Your words · ${foundList.length} of ${all.size}`
        : `Your words · ${foundList.length}`;
      if (!all.size) {
        $('missed-label').classList.add('hidden');
      } else if (missed.length === 0) {
        $('missed-label').classList.remove('hidden');
        $('missed-label').textContent = 'You found every word — perfect!';
      } else {
        $('missed-label').classList.remove('hidden');
        $('missed-label').textContent = `Missed · ${missed.length}`;
        renderChips($('missed-list'), missed, 'missed');
      }
    }, 0);
  }

  // ---------- start screen ----------
  // A shared URL lands here (not straight in the game) so first-timers see the
  // rules. pendingSeed holds the invited board until they press play.
  let pendingSeed = null;
  let countdownHandle = null;

  function stopCountdown() {
    if (countdownHandle) clearInterval(countdownHandle);
    countdownHandle = null;
  }
  function startCountdown() {
    stopCountdown();
    const tick = () => {
      const ms = msToNextLocalMidnight();
      $('daily-countdown').textContent = formatCountdown(ms);
      if (ms <= 0) renderDailyLanding(); // rolled into a new day → show the new puzzle
    };
    tick();
    countdownHandle = setInterval(tick, 1000);
  }

  // The daily area is either "Play Today's Lexigo" or, once played today, a done
  // card with your result + a countdown to the next puzzle (the once/day lock).
  function renderDailyLanding() {
    const done = playedTodaysDaily();
    $('btn-daily').classList.toggle('hidden', done);
    $('daily-done').classList.toggle('hidden', !done);
    // With the daily locked, promote Practice to the primary action.
    $('btn-practice').classList.toggle('btn-primary', done);
    $('btn-practice').classList.toggle('btn-secondary', !done);

    if (done) {
      const d = loadDaily();
      $('daily-done-title').textContent = "Today's Lexigo — done";
      $('daily-done-score').textContent =
        `You scored ${d.score} · ${d.words} ${d.words === 1 ? 'word' : 'words'}`;
      startCountdown();
    } else {
      $('btn-daily').textContent = "Play Today's Lexigo";
      stopCountdown();
    }
    renderStreakFooter();
  }

  function renderStreakFooter() {
    const streak = activeStreak();
    const best = bestScore();
    $('streak-val').textContent = String(streak);
    $('best-score').textContent = String(best);
    $('streak-stat').classList.toggle('hidden', streak <= 0);
    $('best-stat').classList.toggle('hidden', best <= 0);
    $('start-foot').classList.toggle('hidden', streak <= 0 && best <= 0);
  }

  function enterInviteMode(seed) {
    // Arrived via a shared ?g= link: primary CTA becomes that board.
    pendingSeed = seed;
    const code = encodeSeed(seed);
    $('invite-code').textContent = `GAME ${code}`;
    $('invite').classList.remove('hidden');
    $('btn-daily').textContent = `Play game ${code}`;
  }

  $('btn-daily').addEventListener('click', () => {
    if (pendingSeed != null) startGame(pendingSeed, 'shared');
    else startGame(dailyGameSeed(), 'daily');
  });
  $('btn-practice').addEventListener('click', () => startGame(randomSeed(), 'practice'));

  // ---------- viewport tracking (keyboard-aware sheet positioning) ----------
  // On mobile the on-screen keyboard shrinks the *visual* viewport without
  // resizing .app, so anything pinned via `inset:0` (like the shared-game
  // sheet) can end up hidden behind the keyboard. Mirror the live visual
  // viewport into CSS vars so mobile styles can size against it instead.
  function syncViewportVars() {
    const vv = window.visualViewport;
    const root = document.documentElement.style;
    root.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`);
    root.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportVars);
    window.visualViewport.addEventListener('scroll', syncViewportVars);
  } else {
    window.addEventListener('resize', syncViewportVars);
  }
  syncViewportVars();

  // ---------- shared-game sheet (segmented 6-digit code entry) ----------
  const sharedSheet = $('shared-sheet');
  const codeBoxes = Array.from(document.querySelectorAll('#code-boxes .code-box'));
  const codeValue = () => codeBoxes.map((b) => b.value).join('');

  function updatePlayShared() {
    $('btn-play-shared').disabled = codeValue().length !== 6;
  }
  // preventScroll keeps focusing a box from nudging the framed page behind the
  // sheet (an overflow:hidden container can still be scroll-jumped by focus).
  const focusBox = (el) => el.focus({ preventScroll: true });

  function openSharedSheet() {
    codeBoxes.forEach((b) => { b.value = ''; });
    $('code-err').textContent = '';
    updatePlayShared();
    sharedSheet.classList.remove('hidden');
    focusBox(codeBoxes[0]);
  }
  function closeSharedSheet() {
    sharedSheet.classList.add('hidden');
  }

  codeBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1); // keep last digit typed
      $('code-err').textContent = '';
      if (box.value && i < codeBoxes.length - 1) focusBox(codeBoxes[i + 1]);
      updatePlayShared();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        e.preventDefault();
        codeBoxes[i - 1].value = '';
        focusBox(codeBoxes[i - 1]);
        updatePlayShared();
      } else if (e.key === 'ArrowLeft' && i > 0) {
        e.preventDefault(); focusBox(codeBoxes[i - 1]);
      } else if (e.key === 'ArrowRight' && i < codeBoxes.length - 1) {
        e.preventDefault(); focusBox(codeBoxes[i + 1]);
      } else if (e.key === 'Enter' && !$('btn-play-shared').disabled) {
        $('btn-play-shared').click();
      }
    });
    box.addEventListener('focus', () => box.select());
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6).split('');
      let idx = i;
      digits.forEach((d) => { if (idx <= codeBoxes.length - 1) codeBoxes[idx++].value = d; });
      focusBox(codeBoxes[Math.min(idx, codeBoxes.length - 1)]);
      updatePlayShared();
    });
  });

  $('btn-shared-open').addEventListener('click', openSharedSheet);
  $('btn-sheet-close').addEventListener('click', closeSharedSheet);
  sharedSheet.addEventListener('click', (e) => { if (e.target === sharedSheet) closeSharedSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sharedSheet.classList.contains('hidden')) closeSharedSheet();
  });
  $('btn-play-shared').addEventListener('click', () => {
    const seed = decodeCode(codeValue());
    if (seed == null) {
      $('code-err').textContent = 'Enter a valid 6-digit code.';
      return;
    }
    closeSharedSheet();
    startGame(seed, 'shared');
  });

  // ---------- play screen actions ----------
  $('btn-pause').addEventListener('click', () => setPaused(!state.paused));
  $('btn-resume').addEventListener('click', () => setPaused(false));

  const shuffleDialog = $('shuffle-dialog');
  let wasPausedBeforeDialog = false;
  $('btn-shuffle').addEventListener('click', () => {
    wasPausedBeforeDialog = state.paused;
    stopTimer();
    shuffleDialog.classList.remove('hidden');
  });
  $('btn-shuffle-cancel').addEventListener('click', () => {
    shuffleDialog.classList.add('hidden');
    if (!wasPausedBeforeDialog) startTimer();
  });
  $('btn-shuffle-confirm').addEventListener('click', () => {
    shuffleDialog.classList.add('hidden');
    startGame(randomSeed(), 'practice');
  });

  // ---------- summary screen actions ----------
  $('btn-replay').addEventListener('click', () => startGame(randomSeed(), 'practice'));

  function shareMessage() {
    const pts = state.score;
    const words = state.foundList.length;
    const ptLabel = pts === 1 ? 'point' : 'points';
    const wordLabel = words === 1 ? 'word' : 'words';
    const title = state.mode === 'daily' ? "Today's Lexigo" : 'Lexigo';
    return `🔤 ${title} — ${pts} ${ptLabel} in 60 seconds\n`
      + `📝 ${words} ${wordLabel} found\n\n`
      + `Same board, same 60s — beat me 👇`;
  }

  $('btn-share').addEventListener('click', async () => {
    const url = shareUrl(state.code);
    const text = shareMessage();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Lexigo', text, url });
      } catch (_) { /* user cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showToast('Result copied to clipboard');
    } catch (_) {
      showToast('Could not copy result');
    }
  });

  // ---------- boot ----------
  async function boot() {
    $('btn-daily').disabled = true;
    $('btn-daily').textContent = 'Loading…';

    const params = new URLSearchParams(location.search);
    const shared = params.get('g') ? decodeCode(params.get('g')) : null;

    showScreen('start');

    await dictReady;
    $('btn-daily').disabled = false;
    // A ?g= link that is today's daily board is treated as the daily itself (so a
    // reload mid-daily, or opening someone's daily link, shows the daily framing),
    // not an "invited" shared game.
    if (shared != null && shared !== dailyGameSeed()) {
      enterInviteMode(shared);
      renderStreakFooter();
    } else {
      renderDailyLanding();
    }
  }
  boot();
})();
