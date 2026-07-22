import {
  GAME_SECONDS,
  randomSeed, encodeSeed, decodeCode,
  dayKey, dailyPuzzleNumber, dailyGameSeed,
  msToNextLocalMidnight, formatCountdown,
  generateBoard, tileCenter, isAdjacent,
  scoreForWord, findAllBoardWords,
  streakIfAlive, nextStreak,
} from './core.js';

(() => {
  'use strict';

  // ---------- app-local constants ----------
  // Pure game logic (dice, rng, seeds, scoring, board search) lives in core.js
  // so it can be unit-tested with `node --test`. Only DOM/storage-bound state
  // stays here. These two keys are localStorage-only, so they stay app-local.
  const BEST_SCORE_KEY = 'lexigo:best-score';

  // ---------- daily puzzle (local date) ----------
  const DAILY_KEY = 'lexigo:daily';

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
    return streakIfAlive(loadDaily());
  }
  // Record today's daily result once; keep the first attempt if replayed.
  function recordDailyResult(score, words, puzzle) {
    const today = dayKey();
    const stored = loadDaily();
    if (stored && stored.day === today) return; // already recorded today
    saveDaily({ day: today, score, words, puzzle, streak: nextStreak(stored) });
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
      const all = findAllBoardWords(boardLetters, WORDS);
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
    else startGame(dailyGameSeed(WORDS), 'daily');
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
    if (shared != null && shared !== dailyGameSeed(WORDS)) {
      enterInviteMode(shared);
      renderStreakFooter();
    } else {
      renderDailyLanding();
    }
  }
  boot();
})();
