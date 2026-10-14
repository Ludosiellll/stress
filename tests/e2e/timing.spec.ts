import { expect, test } from './fixtures';

/** The probe presses this long after every onset. */
const PRESS_DELAY_MS = 300;
/** Allowed timer slop on top of one frame (the press is scheduled from the onset frame's callback). */
const SLOP_MS = 5;

/**
 * Browser timing accuracy (Task 17): the probe page plays one ПЗМР block of 10 trials through the real
 * ReactionView. A setTimeout of 300 ms started from the stimulus callback sends Space; the recorded RT
 * (press event.timeStamp − onset frame timestamp) must lie in [300, 300 + frame + 5] ms. The onset is the
 * timestamp of the frame the stimulus was drawn in and the callback runs inside that frame, so the
 * measured RT can exceed 300 ms by at most the time from the frame start to the callback, under a frame.
 */
test('pzmr block in the browser records RT within one frame of the true delay', async ({ page }) => {
  await page.goto('/?e2e=1&probe=pzmr');
  const probe = page.locator('[data-frame-ms]');
  await expect(probe).toBeVisible();
  const frameMs = Number(await probe.getAttribute('data-frame-ms'));
  expect(frameMs).toBeGreaterThan(0);

  await page.evaluate((delay) => {
    window.__trainer?.onStimulus(() => {
      setTimeout(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
      }, delay);
    });
  }, PRESS_DELAY_MS);
  await page.getByRole('button', { name: 'Начать замер' }).click();
  await page.waitForFunction(() => window.__trainer?.lastResults != null, null, { timeout: 30_000 });
  await expect(probe).toHaveAttribute('data-probe-status', 'done');

  const results = await page.evaluate(() => window.__trainer?.lastResults ?? []);
  const rts = results.map((r) => r.rtMs);
  console.log(`frame ${frameMs.toFixed(3)} ms; RT ${rts.map((rt) => (rt === null ? 'null' : rt.toFixed(2))).join(', ')}`);

  expect(results).toHaveLength(10);
  expect(results.map((r) => r.outcome)).toEqual(Array<string>(10).fill('hit'));
  for (const rt of rts) {
    expect(rt).not.toBeNull();
    expect(rt).toBeGreaterThanOrEqual(PRESS_DELAY_MS);
    expect(rt).toBeLessThanOrEqual(PRESS_DELAY_MS + frameMs + SLOP_MS);
  }
});
