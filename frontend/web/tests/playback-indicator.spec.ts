import { expect, test, type Page } from '@playwright/test';
import { audio, login, section } from './helpers';
import type { Playlist, Track } from '../src/api';

const headers = { 'X-Wildstring-Client': 'web' };
async function playlists(page: Page) {
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '歌单', exact: true })
    .click();
}
async function paused(page: Page) {
  const player = page.getByRole('region', { name: '音乐播放器', exact: true });
  const pause = player.getByRole('button', { name: '暂停', exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  await expect(player.getByRole('button', { name: '播放', exact: true })).toBeVisible();
}

test('播放标识在歌单和我喜欢中随真实播放、暂停、切歌变化，队列按条目标记', async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items as Track[];
  const favorites = new Set<string>(
    (await (await page.request.get('/api/v1/favorites/ids')).json()).ids,
  );
  const first = tracks[0],
    second = tracks[1];
  let list: Playlist | undefined;
  const player = page.getByRole('region', { name: '音乐播放器', exact: true });
  try {
    const created = await page.request.post('/api/v1/playlists', {
      headers,
      data: { name: `播放标识-${info.project.name}`, kind: 'manual' },
    });
    expect(created.ok()).toBe(true);
    list = await created.json();
    const added = await page.request.post(`/api/v1/playlists/${list!.id}/tracks`, {
      headers,
      data: { version: list!.version, track_ids: tracks.map((t) => t.id) },
    });
    expect(added.ok()).toBe(true);
    list = await added.json();
    for (const track of tracks)
      expect(
        (
          await page.request.put(`/api/v1/tracks/${track.id}/favorite`, {
            headers,
            data: { loved: true },
          })
        ).ok(),
      ).toBe(true);
    await page.getByRole('button', { name: /^刷新曲库/ }).click();
    await playlists(page);
    await page.getByRole('button', { name: `打开歌单 ${list!.name}`, exact: true }).click();
    const table = page.getByRole('table', { name: '歌曲列表' });
    await table.getByRole('button', { name: `播放 ${first.title}`, exact: true }).click();
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
    const current = table.locator('.track-row[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-browse-id', first.id);
    await expect(current.getByRole('img', { name: '正在播放', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        current
          .locator('.playback-indicator > span')
          .first()
          .evaluate((e) => getComputedStyle(e).animationName),
      )
      .not.toBe('none');
    await paused(page);
    await expect(current.getByRole('img', { name: '已暂停', exact: true })).toBeVisible();
    await expect(current.locator('.playback-indicator')).toHaveAttribute('data-animate', 'false');
    await expect(page.locator('.toast')).toBeHidden();
    await current.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../artifacts/now-playing-playlist-${info.project.name}-light.png`,
      fullPage: true,
    });
    await player.getByRole('button', { name: '下一首', exact: true }).click();
    await expect(current).toHaveAttribute('data-browse-id', second.id);
    await paused(page);
    await playlists(page);
    await page.getByRole('button', { name: '打开歌单 ♥ 我喜欢', exact: true }).click();
    await table.getByRole('button', { name: `播放 ${first.title}`, exact: true }).click();
    await expect(current).toHaveAttribute('data-browse-id', first.id);
    await expect(current.getByRole('img', { name: '正在播放', exact: true })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() =>
        current
          .locator('.playback-indicator > span')
          .first()
          .evaluate((e) => getComputedStyle(e).animationName),
      )
      .toBe('none');
    await paused(page);
    await expect(page.locator('.toast')).toBeHidden();
    await current.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../artifacts/now-playing-favorites-${info.project.name}-dark.png`,
      fullPage: true,
    });
    await table.getByRole('button', { name: `歌曲操作 ${first.title}`, exact: true }).click();
    await page.getByRole('button', { name: `将 ${first.title} 加入队列`, exact: true }).click();
    await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
    const queue = page.getByRole('complementary', { name: '播放队列', exact: true });
    await expect(queue.getByRole('listitem')).toHaveCount(3);
    await queue.getByRole('listitem').last().locator('.track-title').click();
    await expect(queue.locator('li[aria-current="true"]')).toHaveCount(1);
    await expect(queue.getByRole('listitem').last()).toHaveAttribute('aria-current', 'true');
    await expect(queue.getByRole('listitem').first()).not.toHaveAttribute('aria-current');
    await page.getByRole('button', { name: '关闭队列', exact: true }).click();
    await paused(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    if (list) {
      const latest = await (await page.request.get(`/api/v1/playlists/${list.id}`)).json();
      await page.request.delete(`/api/v1/playlists/${list.id}?version=${latest.version}`, {
        headers,
      });
    }
    for (const track of tracks)
      await page.request.put(`/api/v1/tracks/${track.id}/favorite`, {
        headers,
        data: { loved: favorites.has(track.id) },
      });
  }
});

test('播放标识在每日推荐中跟随切歌并在缓冲、后台和暂停时停止动画', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await login(page);
  await section(page, '每日推荐 · AI');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  const rows = panel.locator('.daily-track');
  await expect(rows).toHaveCount(2);
  const second = await rows.nth(1).locator('.track-title strong').innerText();
  await panel.getByRole('button', { name: '播放推荐', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  const current = panel.locator('.daily-track.is-current');
  await expect(current).toHaveCount(1);
  await expect(current.getByRole('img', { name: '正在播放', exact: true })).toBeVisible();
  await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('waiting')));
  await expect(current.getByRole('img', { name: '缓冲中', exact: true })).toBeVisible();
  await expect(current.locator('.playback-indicator')).toHaveAttribute('data-animate', 'false');
  await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('playing')));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(current.locator('.playback-indicator')).toHaveAttribute('data-animate', 'false');
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(current.locator('.playback-indicator')).toHaveAttribute('data-animate', 'true');
  await page
    .getByRole('region', { name: '音乐播放器', exact: true })
    .getByRole('button', { name: '下一首', exact: true })
    .click();
  await expect(current.locator('.track-title strong')).toHaveText(second);
  await expect(current.locator('.track-title')).toHaveAttribute('aria-current', 'true');
  await paused(page);
  // A delayed waiting event must not turn a paused track back into buffering.
  await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('waiting')));
  await expect(current.getByRole('img', { name: '已暂停', exact: true })).toBeVisible();
  await expect(page.locator('.toast')).toBeHidden();
  await current.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../artifacts/now-playing-daily-${info.project.name}-light.png`,
    fullPage: true,
  });
});
