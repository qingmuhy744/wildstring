import { expect, type Page } from '@playwright/test';
import { audio, test } from './helpers';

test.skip(process.env.WILDSTRING_TEST_LARGE_LIBRARY !== '1', '独立的大曲库夹具');

async function savedQueue(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('wildstring:playback:'));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}

test('真实257首专辑：从第201首装入末尾57首，播完使用已有推荐', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(51);
  const firstWindow = page.waitForRequest((req) => {
    const url = new URL(req.url());
    return (
      url.pathname.endsWith('/tracks') &&
      url.searchParams.get('limit') === '100' &&
      url.searchParams.get('offset') === '0'
    );
  });
  await page.getByRole('button', { name: '从头播放', exact: true }).click();
  await firstWindow;
  await expect.poll(async () => (await savedQueue(page))?.tracks.length).toBe(100);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  const browse = page.getByLabel('浏览方式', { exact: true });
  if (await browse.isVisible()) await browse.selectOption({ label: '专辑' });
  else
    await page
      .getByRole('group', { name: '曲库显示方式' })
      .getByRole('button', { name: '专辑', exact: true })
      .click();
  await page.getByRole('button', { name: '打开专辑 跨页连续专辑', exact: true }).click();
  await expect(page.locator('.pagination')).toHaveCount(0);
  const table = page.getByRole('table', { name: '歌曲列表' });
  const lastBlock = table.locator('[data-track-offset]').last();
  for (let attempt = 0; attempt < 6; attempt++) {
    const lastOffset = await lastBlock.getAttribute('data-track-offset');
    if (lastOffset === '250') break;
    await page.locator('.browse-boundary').last().scrollIntoViewIfNeeded();
    await expect(lastBlock).not.toHaveAttribute('data-track-offset', lastOffset!);
  }
  await expect(lastBlock).toHaveAttribute('data-track-offset', '250');
  await expect(table).toHaveAttribute('aria-rowcount', '258');
  await table.locator('[data-track-offset="200"]').scrollIntoViewIfNeeded();
  const endOfBlock = table.getByRole('row').filter({ hasText: '跨页测试曲 225' });
  await endOfBlock.getByRole('button').last().focus();
  await page.keyboard.press('Tab');
  await expect(
    table.getByRole('button', { name: '播放 跨页测试曲 226', exact: true }),
  ).toBeFocused();
  await expect.poll(() => table.locator('.track-row').count()).toBeLessThan(125);
  const requests: number[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/albums\/[^/]+\/tracks$/.test(url.pathname) && url.searchParams.get('limit') === '57')
      requests.push(Number(url.searchParams.get('offset')));
  });
  await page.getByRole('button', { name: '播放 跨页测试曲 201', exact: true }).click();
  await expect.poll(async () => (await savedQueue(page))?.tracks.length).toBe(57);
  await expect.poll(async () => (await savedQueue(page))?.index).toBe(0);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(requests).toEqual([]); // The entire tail is already in the displayed album.
  const tracks = (await savedQueue(page)).tracks;
  expect(new Set(tracks.map((track: { id: string }) => track.id)).size).toBe(57);
  await page.locator('audio').evaluate((element) => element.dispatchEvent(new Event('ended')));
  await expect.poll(async () => (await savedQueue(page))?.index).toBe(1);
  await expect.poll(async () => (await audio(page)).source).toContain(tracks[1].id);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  const queue = page.getByRole('complementary', { name: '播放队列', exact: true });
  await expect(queue.getByRole('heading')).toContainText('播完进入心动模式');
  const source = await (await page.request.get('/api/v1/tracks?limit=2')).json();
  let cachedReads = 0;
  const generationCalls: string[] = [];
  page.on('request', (req) => {
    if (/\/recommendations\/daily(?:\/refresh)?$/.test(new URL(req.url()).pathname))
      generationCalls.push(req.url());
  });
  await page.route('**/api/v1/recommendations/daily/cached', (route) => {
    cachedReads++;
    return cachedReads === 1
      ? route.fulfill({
          json: {
            date: '2020-01-01',
            items: source.items.map((track: { id: string }) => ({ track })),
          },
        })
      : route.fulfill({ status: 204 });
  });
  await queue.locator('li .track-title').last().click();
  await expect.poll(async () => (await audio(page)).source).toContain(tracks[56].id);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.locator('audio').evaluate((element) => element.dispatchEvent(new Event('ended')));
  await expect(queue.getByRole('heading')).toHaveText(/心动模式\s*2$/);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const path = info.outputPath(`heart-queue-${theme}.png`);
    await page.screenshot({ path });
    await info.attach(`heart-queue-${theme}`, { path, contentType: 'image/png' });
  }
  await queue.locator('li .track-title').last().click();
  await expect.poll(async () => (await savedQueue(page))?.index).toBe(1);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  const finalTrack = (await savedQueue(page)).tracks[1];
  await expect.poll(async () => (await audio(page)).source).toContain(finalTrack.id);
  await expect
    .poll(() =>
      page
        .locator('audio')
        .evaluate((a: HTMLAudioElement) => Number.isFinite(a.duration) && a.readyState >= 2),
    )
    .toBe(true);
  // Let the final audio element actually finish so the empty response leaves it stopped.
  await page.locator('audio').evaluate((a: HTMLAudioElement) => {
    a.currentTime = a.duration - 0.1;
  });
  await expect.poll(() => cachedReads).toBe(2);
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  expect((await savedQueue(page)).tracks.length).toBe(2);
  expect(generationCalls).toEqual([]);
});
