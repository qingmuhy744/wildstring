import { expect, test, type Page } from '@playwright/test';
import { audio, login, podcastCatalog } from './helpers';

test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Use make test-podcast-web.');

async function show(page: Page) {
  await login(page);
  const path = '/api/v1/podcasts/episodes/radio-6/progress';
  const old = await (await page.request.get(path)).json();
  const saved = await page.request.put(path, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: {
      session_id: crypto.randomUUID(),
      device_id: 'presentation-fixture',
      base_version: old.version,
      sequence: 1,
      position_seconds: 0,
      duration_seconds: 25,
      event: 'play',
      intent: 'restart',
    },
  });
  expect(saved.ok()).toBeTruthy();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
}

test('待播三态保留单集与下一行的边界', async ({ page }, info) => {
  await show(page);
  for (const dark of [false, true]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value ? 'dark' : 'light';
    }, dark);
    const row = page.locator('.podcast-episode-row').first();
    await row.scrollIntoViewIfNeeded();
    const button = row.locator('.episode-queue-btn');
    const before = await row.boundingBox();
    const following = await page.locator('.podcast-episode-row').nth(1).boundingBox();
    for (let state = 0; state < 3; state++) {
      if (state === 1) await button.click();
      if (state === 2) {
        await row.locator('.episode-play-btn').click();
        await expect.poll(async () => (await audio(page)).paused).toBe(false);
        await expect(button).toBeDisabled();
      }
      const bounds = await row.boundingBox();
      const next = await page.locator('.podcast-episode-row').nth(1).boundingBox();
      expect(bounds?.height).toBeCloseTo(before!.height, 1);
      expect(next!.y - bounds!.y).toBeCloseTo(following!.y - before!.y, 1);
      await page.screenshot({ path: info.outputPath(`queue-${dark}-${state}.png`) });
    }
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    // Reopen the page with a fresh player for the second theme, without changing the account's data.
    if (!dark) {
      await page.reload();
      await podcastCatalog(page);
      await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    }
  }
});

for (const reduced of [false, true]) {
  test(`播放按钮逐帧稳定并遵守减少动态效果 ${reduced}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await show(page);
    await page.locator('.episode-play-btn').first().click();
    await expect.poll(async () => (await audio(page)).paused).toBe(false);
    const button = page.getByRole('button', { name: '暂停', exact: true });
    await expect
      .poll(() =>
        button.locator('.glyph-pause').evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBe(1);
    const samples = await button.evaluate(async (element) => {
      const glyph = element.querySelector('.playback-glyph')!;
      const frames: {
        time: number;
        edges: number[];
        play: number;
        pause: number;
        state: string;
      }[] = [];
      const started = performance.now();
      (element as HTMLButtonElement).click();
      await new Promise<void>((resolve) => {
        function sample(now: number) {
          const r = element.getBoundingClientRect();
          frames.push({
            time: now - started,
            edges: [r.left, r.top, r.right, r.bottom],
            play: Number(getComputedStyle(glyph.querySelector('.glyph-play')!).opacity),
            pause: Number(getComputedStyle(glyph.querySelector('.glyph-pause')!).opacity),
            state: glyph.getAttribute('data-state')!,
          });
          if (now - started < 500) requestAnimationFrame(sample);
          else resolve();
        }
        requestAnimationFrame(sample);
      });
      return frames;
    });
    expect(samples.length).toBeGreaterThan(5);
    for (const frame of samples) expect(frame.edges).toEqual(samples[0].edges);
    const target = samples.filter((frame) => frame.state === 'play');
    expect(target.length).toBeGreaterThan(0);
    if (reduced) expect(target.every((frame) => frame.play === 1 && frame.pause === 0)).toBe(true);
    else
      expect(target.filter((frame) => frame.play > 0 && frame.play < 1).length).toBeGreaterThan(3);
    expect(
      samples
        .filter((frame) => frame.time > 350)
        .every((frame) => frame.play === 1 && frame.pause === 0),
    ).toBe(true);
    await info.attach('transport-frames', {
      body: JSON.stringify(samples),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath(`transport-reduced-${reduced}.png`) });
  });
}
