import { expect, test, type Page } from '@playwright/test';
import { audio } from './helpers';

test.skip(process.env.WILDSTRING_TEST_LARGE_LIBRARY !== '1', '独立的大曲库夹具');

async function savedQueue(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('wildstring:playback:'));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}

test('真实257首专辑：跨API分页收齐队列，从第201首连续播放到202首', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await savedQueue(page))?.tracks.length).toBe(259);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  const browse = page.getByLabel('浏览方式', { exact: true });
  if (await browse.isVisible()) await browse.selectOption({ label: '专辑' });
  else
    await page
      .getByRole('group', { name: '曲库显示方式' })
      .getByRole('button', { name: '专辑', exact: true })
      .click();
  await page.getByRole('button', { name: /跨页连续专辑/ }).click();
  await expect(page.locator('.pagination')).toHaveCount(0);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.getByRole('button', { name: '播放 跨页测试曲 201', exact: true }).count()) break;
    const before = await page.getByRole('table').getByRole('row').count();
    await page.locator('.browse-boundary').last().scrollIntoViewIfNeeded();
    await expect
      .poll(async () => await page.getByRole('table').getByRole('row').count())
      .toBeGreaterThan(before);
  }
  const requests: number[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/albums\/[^/]+\/tracks$/.test(url.pathname) && url.searchParams.get('limit') === '200')
      requests.push(Number(url.searchParams.get('offset')));
  });
  await page.getByRole('button', { name: '播放 跨页测试曲 201', exact: true }).click();
  await expect.poll(async () => (await savedQueue(page))?.tracks.length).toBe(257);
  await expect.poll(async () => (await savedQueue(page))?.index).toBe(200);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(requests).toEqual([0, 200]);
  const tracks = (await savedQueue(page)).tracks;
  expect(new Set(tracks.map((track: { id: string }) => track.id)).size).toBe(257);
  await page.locator('audio').evaluate((element) => element.dispatchEvent(new Event('ended')));
  await expect.poll(async () => (await savedQueue(page))?.index).toBe(201);
  await expect.poll(async () => (await audio(page)).source).toContain(tracks[201].id);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
});
