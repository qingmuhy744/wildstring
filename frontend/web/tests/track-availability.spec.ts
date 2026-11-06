import { test, expect } from '@playwright/test';
import { login, audio } from './helpers';

test('失效歌曲保留提示、手动点击不换歌、播放全部跳过并可恢复', async ({ page }, info) => {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const missing = tracks[0];
  const playable = tracks[1];
  let restored = false;
  await page.route('**/api/v1/tracks?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    expect(new URL(route.request().url()).searchParams.get('include_unavailable')).toBe('true');
    await route.fulfill({
      response,
      json: {
        ...body,
        items: body.items.map((track: { id: string }) =>
          track.id === missing.id
            ? { ...track, status: restored ? 'available' : 'missing' }
            : track,
        ),
      },
    });
  });
  await page.reload();
  await expect(page.locator('.track-unavailable')).toContainText('文件缺失');
  await page.getByRole('button', { name: `播放 ${missing.title}`, exact: true }).click();
  await expect(page.locator('.toast')).toContainText('文件缺失');
  expect((await audio(page)).paused).toBe(true);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toContain(playable.id);
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: `播放 ${missing.title}`, exact: true }).click();
  await expect(page.locator('.toast')).toContainText('文件缺失');
  expect((await audio(page)).source).toContain(playable.id);
  await page.screenshot({ path: `../../artifacts/track-unavailable-${info.project.name}.png` });
  restored = true;
  await page.reload();
  await expect(page.getByRole('table', { name: '歌曲列表' })).toContainText(missing.title);
  await expect(page.locator('.track-unavailable')).toHaveCount(0);
});
