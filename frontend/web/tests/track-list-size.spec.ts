import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

const KEY = 'wildstring:user-preferences:admin:wildstring:track-list-size';
async function settings(page: Page) {
  const navigation = page.getByLabel('浏览方式', { exact: true });
  if (await navigation.isVisible()) await navigation.selectOption('account');
  else await page.getByRole('button', { name: '账号设置', exact: true }).click();
  return page.getByRole('dialog', { name: '账号设置', exact: true });
}
async function choose(page: Page, value: string) {
  const dialog = await settings(page);
  await dialog.getByLabel('歌曲列表大小', { exact: true }).selectOption(value);
  await dialog.getByRole('button', { name: '关闭账号设置', exact: true }).click();
}
async function tab(page: Page, name: string) {
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function geometry(page: Page) {
  return page
    .locator('.track-row')
    .first()
    .evaluate((row) => {
      const box = row.getBoundingClientRect();
      const elements = [
        row.querySelector('.cover'),
        row.querySelector('.track-number'),
        row.querySelector('time'),
        ...row.querySelectorAll('.track-actions > button, .track-actions > details > summary'),
      ].filter((item): item is Element => !!item);
      return {
        height: box.height,
        cover: row.querySelector('.cover')?.getBoundingClientRect().width,
        titleSize: parseFloat(getComputedStyle(row.querySelector('.track-title strong')!).fontSize),
        artistSize: parseFloat(getComputedStyle(row.querySelector('.track-artist-row')!).fontSize),
        centers: elements.map((item) => {
          const rect = item.getBoundingClientRect();
          return Math.abs(rect.y + rect.height / 2 - box.y - box.height / 2);
        }),
        buttons: [...row.querySelectorAll('.track-actions .icon-button')].map((item) => ({
          width: item.getBoundingClientRect().width,
          height: item.getBoundingClientRect().height,
        })),
      };
    });
}

test('歌曲列表中号默认，小中大即时生效、居中对齐并保留播放和本机偏好', async ({ page }, info) => {
  await login(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(
      (theme) =>
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: theme })),
      theme,
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const color = await page.getByRole('navigation', { name: '首字母定位' }).evaluate((rail) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(rail).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    expect(color[3]).toBeGreaterThan(200);
    if (theme === 'light') expect(Math.min(...color.slice(0, 3))).toBeGreaterThan(200);
    else expect(Math.max(...color.slice(0, 3))).toBeLessThan(60);
  }
  const list = page.getByRole('table', { name: '歌曲列表' });
  await expect(list).toHaveAttribute('data-list-size', 'medium');
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await audio(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith('wildstring:playback:'),
        )!;
        return JSON.parse(localStorage.getItem(key)!).position;
      }),
    )
    .toBeCloseTo(before.time, 1);
  const queue = await page.evaluate(() =>
    localStorage.getItem(
      Object.keys(localStorage).find((key) => key.startsWith('wildstring:playback:'))!,
    ),
  );
  const audioElement = await page.locator('audio').elementHandle();
  for (const [size, height, cover, title, artist] of [
    ['small', 56, 36, 14, 12],
    ['medium', 68, 44, 15, 12],
    ['large', 80, 56, 18, 14],
  ] as const) {
    await choose(page, size);
    await expect(list).toHaveAttribute('data-list-size', size);
    const measured = await geometry(page);
    expect(measured.height).toBe(height);
    expect(measured.cover).toBe(cover);
    expect(measured.titleSize).toBe(title);
    expect(measured.artistSize).toBe(artist);
    expect(measured.centers.every((delta) => delta <= 1)).toBe(true);
    expect(measured.buttons.every((button) => button.width >= 44 && button.height >= 44)).toBe(
      true,
    );
    expect(await audio(page)).toEqual(before);
    expect(
      await audioElement!.evaluate((element) => element === document.querySelector('audio')),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          Object.keys(localStorage).find((key) => key.startsWith('wildstring:playback:'))!,
        ),
      ),
    ).toBe(queue);
    await page.screenshot({ path: `../../artifacts/song-list-${size}-${info.project.name}.png` });
  }
  await page.reload();
  await expect(list).toHaveAttribute('data-list-size', 'large');
  const dialog = await settings(page);
  await expect(dialog.getByLabel('歌曲列表大小', { exact: true })).toHaveValue('large');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('字号复用于专辑、艺人和歌单歌曲，专辑网格及全屏播放不受影响', async ({ page }, info) => {
  await login(page);
  const all = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const favorite = all.find((track: { title: string }) => track.title === '晴天测试曲');
  await page.request.put(`/api/v1/tracks/${favorite.id}/favorite`, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { loved: false },
  });
  await page.getByRole('button', { name: '刷新曲库', exact: false }).click();
  await tab(page, '专辑');
  const card = page.getByRole('button', { name: '打开专辑 合成测试专辑', exact: true });
  const gridBefore = await card.boundingBox();
  await choose(page, 'large');
  expect(await card.boundingBox()).toEqual(gridBefore);
  await card.click();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'large');
  expect((await geometry(page)).height).toBe(80);
  await expect(page.locator('.album-tracks .track-identity > .cover')).toHaveCount(0);
  await page.getByRole('button', { name: '返回专辑', exact: false }).click();
  await tab(page, '艺人');
  await page.getByRole('button', { name: '查看艺人 客席测试', exact: true }).click();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'large');
  expect((await geometry(page)).height).toBe(80);
  await page
    .getByRole('table')
    .getByRole('button', { name: '喜欢 晴天测试曲', exact: true })
    .click();
  await tab(page, '歌单');
  await page.getByRole('button', { name: '打开歌单 ♥ 我喜欢', exact: true }).click();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'large');
  expect((await geometry(page)).height).toBe(80);
  await page.getByRole('button', { name: '播放歌单', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  const visual = await player.locator('.playback-visual').boundingBox();
  const playback = await audio(page);
  // Exercise an actual cross-tab storage event instead of synthesizing one.
  const preferencesTab = await page.context().newPage();
  try {
    await preferencesTab.goto(page.url());
    await preferencesTab.evaluate((key) => localStorage.setItem(key, 'small'), KEY);
  } finally {
    await preferencesTab.close();
  }
  const afterVisual = (await player.locator('.playback-visual').boundingBox())!;
  expect(afterVisual.width).toBeCloseTo(visual!.width, 1);
  expect(afterVisual.height).toBeCloseTo(visual!.height, 1);
  expect((await audio(page)).source).toBe(playback.source);
  await player.getByRole('button', { name: '收起全屏播放', exact: true }).click();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'small');
  await page
    .getByRole('table')
    .getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true })
    .click();
  // An ordinary playlist uses the same table rather than a separate density control.
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const headers = { 'X-Wildstring-Client': 'web' };
  const created = await (
    await page.request.post('/api/v1/playlists', {
      headers,
      data: { name: `列表大小-${info.project.name}`, kind: 'manual' },
    })
  ).json();
  const updated = await (
    await page.request.post(`/api/v1/playlists/${created.id}/tracks`, {
      headers,
      data: { version: created.version, track_ids: [tracks[0].id] },
    })
  ).json();
  try {
    await tab(page, '歌单');
    await page.getByRole('button', { name: '刷新曲库', exact: false }).click();
    await page.getByRole('button', { name: `打开歌单 ${created.name}`, exact: true }).click();
    await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'small');
    expect((await geometry(page)).height).toBe(56);
  } finally {
    await page.request.delete(`/api/v1/playlists/${created.id}?version=${updated.version}`, {
      headers,
    });
  }
});

test('多个网页同步歌曲列表大小，非法值和清除偏好回到中号', async ({ page }) => {
  await login(page);
  const other = await page.context().newPage();
  try {
    await other.goto('/');
    await expect(other.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
    await choose(page, 'large');
    await expect(other.getByRole('table')).toHaveAttribute('data-list-size', 'large');
    await tab(page, '专辑');
    await expect(page.locator('.album-grid')).toBeVisible();
    await expect(page.locator('.track-list')).toHaveCount(0);
    await choose(other, 'small');
    await tab(page, '歌曲');
    await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'small');
    await other.evaluate((key) => localStorage.setItem(key, 'unsupported-size'), KEY);
    await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
    await other.reload();
    await expect(other.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
    await choose(page, 'small');
    await expect(other.getByRole('table')).toHaveAttribute('data-list-size', 'small');
    await other.evaluate((key) => localStorage.removeItem(key), KEY);
    await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
    await choose(page, 'large');
    await expect(other.getByRole('table')).toHaveAttribute('data-list-size', 'large');
    await other.evaluate(() => localStorage.clear());
    await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
  } finally {
    await other.close();
  }
});

test('存储不可用时仍即时切换，改变大小不会将滚动位置重置到顶部', async ({ page }) => {
  await page.addInitScript((key) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Blocked', 'SecurityError');
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Blocked', 'SecurityError');
      return set.call(this, name, value);
    };
  }, KEY);
  await login(page);
  await page.setViewportSize({ width: 390, height: 540 });
  const dialog = await settings(page);
  await page.evaluate(() => window.scrollTo(0, 20));
  const scroll = await page.evaluate(() => scrollY);
  expect(scroll).toBeGreaterThan(0);
  await dialog.getByLabel('歌曲列表大小', { exact: true }).selectOption('small');
  await expect(page.locator('.track-list')).toHaveAttribute('data-list-size', 'small');
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await dialog.getByLabel('歌曲列表大小', { exact: true }).selectOption('large');
  await dialog.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'large');
  const again = await settings(page);
  await expect(again.getByLabel('歌曲列表大小', { exact: true })).toHaveValue('large');
  await page.reload();
  await expect(page.getByRole('table')).toHaveAttribute('data-list-size', 'medium');
});
