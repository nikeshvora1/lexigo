# Testing

Two tiers. The fast one gates every commit; the browser one runs on demand.

## Tier 1 — logic unit tests (the commit gate) · zero-dependency

Pure game logic lives in [`core.js`](core.js) (dice, seeded RNG, seed encode/decode,
daily/streak rules, scoring, board word-search). It's a plain ES module with no
DOM access, so it runs under Node's built-in test runner — no npm, no
`node_modules`.

```sh
node --test          # run the whole suite (~0.2s)
```

Tests live in [`test/core.test.js`](test/core.test.js).

### Pre-commit hook

The versioned hook in [`hooks/pre-commit`](hooks/pre-commit) runs `node --test`
(plus a syntax check of `core.js` and `app.js`) and blocks the commit on
failure. Enable it once per clone:

```sh
sh hooks/setup.sh    # sets core.hooksPath=hooks and marks the hook executable
```

To bypass in a pinch: `git commit --no-verify`.

## Tier 2 — browser flow tests (opt-in) · needs Playwright

The DOM-driven flows (daily start, practice, shared-code entry, invite links)
are tested in a real browser with Playwright, isolated in [`e2e/`](e2e/) so the
game itself stays dependency-free. These are **not** in the commit gate — browser
tests are too slow/flaky to block every commit; run them before releasing or in CI.

```sh
cd e2e
npm install                 # first time only
npm run install-browsers    # first time only — downloads Chromium
npm test
```

Specs: [`e2e/flows.spec.js`](e2e/flows.spec.js). The Playwright config serves the
repo root with `python3 -m http.server`, so no extra server code is needed.

## Where new logic should go

Put anything testable and DOM-free in `core.js` and export it; add a case to
`test/core.test.js`. Keep `app.js` for wiring (DOM, timers, `localStorage`,
pointer events). That split is what keeps the commit gate fast and dependency-free.
