import { test, expect } from '@playwright/test';

// Browser flow tests — the DOM-driven paths that unit tests can't reach:
// daily start, practice, shared-code entry, and invite links. These run in a
// real browser and are intentionally OUTSIDE the pre-commit gate (too slow to
// block every commit). Run them on demand:  cd e2e && npm test

// The daily button boots disabled ("Loading…") until words.txt loads.
async function waitForReady(page) {
  await expect(page.locator('#btn-daily')).toBeEnabled({ timeout: 15_000 });
}

test('start screen loads with the daily call-to-action', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await expect(page.locator('#screen-start')).toBeVisible();
  await expect(page.locator('#btn-daily')).toContainText(/Lexigo/i);
});

test('daily flow: start puts you on a 16-tile board with a timer', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-daily').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#board .tile')).toHaveCount(16);
  // The daily is named by its number, which reads the same in every timezone.
  await expect(page.locator('#game-code-tag')).toContainText(/^LEXIGO #\d+$/);
});

test('practice flow: pick a difficulty, get a curated board with a ?g= code', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-practice').click();
  await expect(page.locator('#practice-sheet')).toBeVisible();

  await page.locator('.diff-opt[data-difficulty="hard"]').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#board .tile')).toHaveCount(16);
  await expect(page.locator('#game-difficulty-tag')).toContainText('HARD');
  await expect(page).toHaveURL(/\?g=\d{6}/);
});

test('practice difficulty is remembered and never repeats a board', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-practice').click();
  await page.locator('.diff-opt[data-difficulty="medium"]').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  const first = new URL(page.url()).searchParams.get('g');

  // "Another board" from the shuffle dialog stays in the chosen difficulty.
  await page.locator('#btn-shuffle').click();
  await page.locator('#btn-shuffle-confirm').click();
  await expect(page.locator('#game-difficulty-tag')).toContainText('MEDIUM');
  expect(new URL(page.url()).searchParams.get('g')).not.toBe(first);

  // The choice is remembered across visits — the sheet highlights it on return.
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-practice').click();
  await expect(page.locator('.diff-opt[data-difficulty="medium"]')).toHaveClass(/last/);
});

test('the done card can share the result on a fresh load, with no game in memory', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  // A daily already recorded today, as if played hours ago in another session.
  await page.evaluate(() => {
    const d = new Date();
    localStorage.setItem('lexigo:daily', JSON.stringify({
      day: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
      score: 53, words: 19, puzzle: 7, streak: 6,
    }));
  });
  await page.reload();
  await waitForReady(page);

  await expect(page.locator('#daily-done')).toBeVisible();
  await expect(page.locator('#daily-done-score')).toHaveText('You scored 53 · 19 words');

  // The message is built from the stored record, not from a live game.
  await page.evaluate(() => {
    window.__shared = null;
    navigator.share = (d) => { window.__shared = d; return Promise.resolve(); };
  });
  await page.locator('#btn-share-daily').click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared.text).toMatch(/^🔤 Lexigo #\d+ — 53 points in 60 seconds/);
  expect(shared.text).toContain('📝 19 words found');
  expect(shared.text).toContain('🔥 6 day streak');
  expect(shared.url).not.toContain('?g='); // the daily link is the bare page
});

test('the wordmark leaves the game, but only after confirming', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-daily').click();
  await expect(page.locator('#screen-play')).toBeVisible();

  // Confirming is required — a mis-tap on the header can't cost a round.
  await page.locator('#btn-brand-home').click();
  await expect(page.locator('#leave-dialog')).toBeVisible();
  await page.locator('#btn-leave-cancel').click();
  await expect(page.locator('#leave-dialog')).toBeHidden();
  await expect(page.locator('#screen-play')).toBeVisible();

  // Paused is exactly when someone wants out, so the wordmark must still work
  // with the pause overlay up.
  await page.locator('#btn-pause').click();
  await page.locator('#btn-brand-home').click();
  await expect(page.locator('#leave-dialog')).toBeVisible();

  await page.locator('#btn-leave-confirm').click();
  await expect(page.locator('#screen-start')).toBeVisible();
  await expect(page).not.toHaveURL(/\?g=/);
});

test('shared-code flow: entering a 6-digit code opens that board', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-shared-open').click();
  await expect(page.locator('#shared-sheet')).toBeVisible();

  const boxes = page.locator('#code-boxes .code-box');
  for (const [i, d] of [...'042042'].entries()) await boxes.nth(i).fill(d);

  await expect(page.locator('#btn-play-shared')).toBeEnabled();
  await page.locator('#btn-play-shared').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page).toHaveURL(/\?g=042042/);
});

test('shared suggestions: a drawn board fills the code and plays labelled', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-shared-open').click();

  const hard = page.locator('.suggest-opt[data-difficulty="hard"]');
  await expect(hard.locator('.suggest-code')).toHaveText(/^\d{6}$/);

  // Redraw deals different boards (500 per mode — one row could repeat by
  // chance, so compare all three).
  const codes = () => page.locator('.suggest-code').allTextContents();
  const before = await codes();
  await page.locator('#btn-suggest-redraw').click();
  expect(await codes()).not.toEqual(before);

  // Tapping a suggestion loads its code rather than launching the game.
  const picked = await hard.locator('.suggest-code').textContent();
  await hard.click();
  await expect(page.locator('#screen-play')).toBeHidden();
  const boxes = page.locator('#code-boxes .code-box');
  for (const [i, d] of [...picked].entries()) await expect(boxes.nth(i)).toHaveValue(d);
  await expect(hard).toHaveClass(/picked/);

  await page.locator('#btn-play-shared').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?g=${picked}`));
  // A curated code carries its difficulty into the game, however it arrived.
  await expect(page.locator('#game-difficulty-tag')).toContainText('HARD');
});

test('invite flow: a ?g= link lands on the start screen framed as that game', async ({ page }) => {
  await page.goto('/index.html?g=042042');
  await waitForReady(page);
  // Shared links show the rules first (not straight into play).
  await expect(page.locator('#screen-start')).toBeVisible();
  await expect(page.locator('#invite')).toBeVisible();
  await expect(page.locator('#invite-code')).toContainText('042042');
});
