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
  await expect(page.locator('#game-code-tag')).toContainText(/TODAY'S LEXIGO/i);
});

test('practice flow: new random board, shareable ?g= code in the URL', async ({ page }) => {
  await page.goto('/index.html');
  await waitForReady(page);
  await page.locator('#btn-practice').click();
  await expect(page.locator('#screen-play')).toBeVisible();
  await expect(page.locator('#board .tile')).toHaveCount(16);
  await expect(page).toHaveURL(/\?g=\d{6}/);
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

test('invite flow: a ?g= link lands on the start screen framed as that game', async ({ page }) => {
  await page.goto('/index.html?g=042042');
  await waitForReady(page);
  // Shared links show the rules first (not straight into play).
  await expect(page.locator('#screen-start')).toBeVisible();
  await expect(page.locator('#invite')).toBeVisible();
  await expect(page.locator('#invite-code')).toContainText('042042');
});
