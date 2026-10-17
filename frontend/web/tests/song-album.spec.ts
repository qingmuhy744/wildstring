import { expect, test } from '@playwright/test';
import { audio, login } from './helpers';

test('歌曲菜单图标与文字对齐，深浅色及窄屏保持控件可达', async ({ page }, info) => {
  await login(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) =>
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value })),
      theme,
    );
    const actions = page.getByRole('table').getByRole('row').nth(1).locator('.track-actions');
    const centers = await actions.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { y: box.y + box.height / 2, width: box.width, height: box.height };
      }),
    );
    expect(Math.abs(centers[0].y - centers[1].y)).toBeLessThanOrEqual(1);
    expect(centers[0].width).toBe(centers[1].width);
    expect(centers[0].height).toBe(centers[1].height);
    await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
    const menu = page.getByRole('group', { name: '操作 晴天测试曲', exact: true });
    const alignment = await menu.locator(':scope > button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const icon = button.querySelector('svg')!.getBoundingClientRect();
        const text = button.querySelector('span')!.getBoundingClientRect();
        return {
          iconX: icon.x,
          textX: text.x,
          centerOffset: Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2),
        };
      }),
    );
    expect(new Set(alignment.map((item) => item.iconX)).size).toBe(1);
    expect(new Set(alignment.map((item) => item.textX)).size).toBe(1);
    expect(alignment.every((item) => item.centerOffset <= 1)).toBe(true);
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({
      path: `../../artifacts/song-actions-${theme}-${info.project.name}.png`,
    });
    await page.keyboard.press('Escape');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('从艺人歌曲打开完整所属专辑，清除艺人与搜索限制', async ({ page }) => {
  await login(page);
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '艺人', exact: true })
    .click();
  await page.getByRole('button', { name: '查看艺人 客席测试', exact: true }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  const target = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (track: { title: string }) => track.title === '晴天测试曲',
  );
  const request = page.waitForRequest((item) => item.url().endsWith(`/albums/${target.album_id}`));
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '查看所属专辑', exact: true }).click();
  await request;
  await expect(page.getByRole('heading', { name: '合成测试专辑', exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('table')).toContainText('夜晚测试曲');
  await expect(page.getByRole('button', { name: '返回专辑', exact: false })).toBeVisible();
  await page.getByRole('button', { name: '返回专辑', exact: false }).click();
  await expect(page.getByRole('heading', { name: '客席测试', exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
});

test('播放页点击专辑名后继续播放，队列和进度不重置', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-panel', 'cover');
  const before = await audio(page);
  await dialog.getByRole('button', { name: '查看所属专辑 合成测试专辑', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '合成测试专辑', exact: true })).toBeVisible();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(before.time);
  expect((await audio(page)).source).toBe(before.source);
  expect((await audio(page)).paused).toBe(false);
  await page.screenshot({ path: `../../artifacts/song-album-${info.project.name}.png` });
  await page.getByRole('button', { name: '返回播放', exact: false }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-panel', 'cover');
  expect((await audio(page)).source).toBe(before.source);
  await dialog.getByRole('button', { name: '收起全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  await expect(
    page.getByRole('complementary', { name: '播放队列', exact: true }).getByRole('listitem'),
  ).toHaveCount(2);
});

test('专辑不可用时保留当前页面，可重试打开', async ({ page }, info) => {
  await login(page);
  const target = (await (await page.request.get('/api/v1/tracks')).json()).items[0];
  const route = `**/api/v1/albums/${target.album_id}`;
  await page.route(route, (request) =>
    request.fulfill({ status: 404, json: { detail: 'album_not_found' } }),
  );
  if (info.project.name === 'desktop') {
    await page
      .getByRole('table')
      .getByRole('button', { name: '查看所属专辑 合成测试专辑', exact: true })
      .first()
      .click();
  } else {
    await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
    await page.getByRole('button', { name: '查看所属专辑', exact: true }).click();
  }
  await expect(page.locator('.toast')).toContainText('所属专辑已变化或不可用');
  await expect(page.getByRole('heading', { name: '收藏的声音。', exact: true })).toBeVisible();
  await page.unroute(route);
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '查看所属专辑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '合成测试专辑', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放专辑', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.route(route, (request) =>
    request.fulfill({ status: 404, json: { detail: 'album_not_found' } }),
  );
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '查看所属专辑 合成测试专辑', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('所属专辑已变化或不可用');
  await expect(dialog).toBeVisible();
});
