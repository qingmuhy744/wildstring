import { expect, test } from '@playwright/test';
import { audio, login } from './helpers';
import { readFile } from 'node:fs/promises';

test('长按动画或歌词查看大封面，松手不切换或跳转，返回保持原播放状态', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('wildstring-playback-style', 'vinyl'));
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  // Duration fills in once metadata loads; keep the baseline stable before comparing.
  await expect.poll(async () => Number.isFinite((await audio(page)).duration)).toBe(true);
  const before = await audio(page);
  const preview = page.getByRole('dialog', { name: '大封面', exact: true });
  const hold = async (x: number, y: number) => {
    if (info.project.name === 'mobile') {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      await page.waitForTimeout(650);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(650);
      await page.mouse.up();
    }
  };
  // Hold actual lyric text as well as the visual; releasing must not invoke its short click.
  const lyric = player.locator('.lyric-line[aria-current=true]');
  await lyric.scrollIntoViewIfNeeded();
  const line = (await lyric.boundingBox())!;
  await hold(line.x + line.width / 2, line.y + line.height / 2);
  await expect(preview).toBeVisible();
  const image = preview.locator('img');
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveCSS('object-fit', 'contain');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    preview.getByRole('link', { name: '下载封面', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('晴天测试曲-封面.jpg');
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 2)]).toEqual([255, 216]);
  await expect(preview).toBeVisible();
  expect(await audio(page)).toEqual(before);
  await preview.getByRole('button', { name: '关闭大封面' }).click();
  await expect(preview).toHaveCount(0);
  await expect(player.locator('.lyric-scroll')).toBeVisible();
  await player.getByRole('button', { name: '显示歌词', exact: true }).click();
  const visual = (await player.locator('.playback-visual').boundingBox())!;
  await hold(visual.x + visual.width / 2, visual.y + visual.height / 2);
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/player-artwork-preview-${info.project.name}.png`,
  });
  if (info.project.name === 'mobile') await preview.click({ position: { x: 3, y: 3 } });
  else await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(player).toBeVisible();
  await expect(player.locator('.lyric-scroll')).toHaveCount(0);
  expect(await audio(page)).toEqual(before);
  // Movement cancels an impending hold rather than opening artwork after a drag.
  await page.mouse.move(visual.x + visual.width / 2, visual.y + visual.height / 2);
  await page.mouse.down();
  await page.mouse.move(visual.x + visual.width / 2, visual.y + visual.height / 2 - 50);
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(player.locator('.lyric-scroll')).toHaveCount(0);
  expect(await audio(page)).toEqual(before);
});

test('歌词浏览：触屏滑动后确认跳转，桌面点击行直接跳转，空白不切换', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  // Duration fills in once metadata loads; keep the baseline stable before comparing.
  await expect.poll(async () => Number.isFinite((await audio(page)).duration)).toBe(true);
  const before = await audio(page);
  const viewport = dialog.locator('.lyric-scroll');
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();

  if (info.project.name === 'mobile') {
    const bounds = (await viewport.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width * 0.5;
    const y = bounds.y + bounds.height * 0.8;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - (bounds.height * 0.65 * step) / 8 }],
      });
      await page.waitForTimeout(30);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    const confirm = dialog.getByRole('group', { name: '歌词跳转预览' }).getByRole('button');
    await expect(confirm).toBeVisible();
    expect(await audio(page)).toEqual(before);
    await confirm.click();
  } else {
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.15, {
      steps: 10,
    });
    await page.mouse.up();
    await expect(dialog.getByRole('group', { name: '歌词跳转预览' })).toHaveCount(0);
    expect(await audio(page)).toEqual(before);
    await dialog.getByRole('button', { name: /^跳转到.*侧车第三行/ }).click();
  }
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(5.9);
  expect((await audio(page)).paused).toBe(true);
  await expect(dialog.getByRole('button', { name: '跟随播放', exact: true })).toBeDisabled();
  await page.waitForTimeout(350);
  if (info.project.name === 'mobile') {
    await dialog
      .getByRole('button', { name: /^切换到封面/ })
      .first()
      .click();
    await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
    await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  } else {
    const targetLine = dialog.getByRole('button', { name: /^跳转到/ }).last();
    await targetLine.click();
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(5.9);
  }
  const blank = async () => {
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.click(bounds.x + 2, bounds.y + 2);
  };
  await blank();
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  // Empty space beside the visual or lyrics must not exit fullscreen
  const record = (await dialog.locator('.fullscreen-record').boundingBox())!;
  await page.mouse.click(record.x + 2, record.y + 2);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '收起全屏播放', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(reopened).toBeVisible();
  const visual = reopened.locator('.playback-visual');
  await visual.click();
  await visual.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: '大封面', exact: true });
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: '关闭大封面' }).click();
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  expect((await audio(page)).paused).toBe(true);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(5.9);
});

test('短歌词整块居中且不滚动，只有当前行高亮', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  // The synthetic LRC has four lines: equal padding, no scrollable range, no drift.
  const metrics = await dialog.locator('.lyric-scroll').evaluate((node) => {
    const list = node.querySelector('ol')!;
    return {
      top: parseFloat(getComputedStyle(list).paddingTop),
      bottom: parseFloat(getComputedStyle(list).paddingBottom),
      scrollTop: node.scrollTop,
      max: node.scrollHeight - node.clientHeight,
    };
  });
  expect(metrics.max).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.top - metrics.bottom)).toBeLessThan(1);
  expect(metrics.scrollTop).toBe(0);
  await expect(dialog.locator('[aria-current="true"]')).toHaveCount(1);
});

test('长歌词开头从上方显示、末尾可居中，逐字着色只在当前行', async ({ page }) => {
  const lines = Array.from({ length: 10 }, (_, index) => ({
    time_ms: index * 1000,
    text: `第 ${index + 1} 行歌词`,
    words: [
      { start_ms: index * 1000, end_ms: index * 1000 + 400, text: `第 ${index + 1} ` },
      { start_ms: index * 1000 + 400, end_ms: index * 1000 + 900, text: '行歌词' },
    ],
  }));
  await page.route('**/api/v1/tracks/*/lyrics', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'synced', source: 'sidecar_lrc', source_url: null, lines }),
    }),
  );
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const scroll = dialog.locator('.lyric-scroll');
  // Opening lines stay at the top instead of being forced into the viewport center.
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(dialog.locator('.lyric-word')).toHaveCount(2);
  await expect(dialog.locator('[aria-current="true"]')).toHaveCount(1);
  // The bottom half-screen padding lets the last line still reach the center.
  await dialog.getByRole('button', { name: /^跳转到.*第 10 行歌词/ }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(8.9);
  await expect(dialog.locator('[aria-current="true"]')).toHaveText(/第 10 行歌词/);
  const distance = () =>
    scroll.evaluate((node) => {
      const line = node.querySelector('[aria-current="true"]') as HTMLElement;
      return Math.abs(
        line.offsetTop + line.clientHeight / 2 - node.scrollTop - node.clientHeight / 2,
      );
    });
  await expect.poll(distance).toBeLessThan(24);
});

test('播放中滚动停止后自动恢复跟随，暂停不恢复，按钮可立即恢复', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  const follow = dialog.getByRole('button', { name: '跟随播放', exact: true });
  const scroll = dialog.locator('.lyric-scroll');
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  await expect(follow).toBeDisabled();
  await scroll.hover();
  await page.mouse.wheel(0, 200);
  await expect(follow).toBeEnabled();
  await expect(follow).toBeDisabled({ timeout: 5000 });
  // Pausing suspends the timer, so browsing stays where the user left it.
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await scroll.hover();
  await page.mouse.wheel(0, 200);
  await expect(follow).toBeEnabled();
  await page.waitForTimeout(2500);
  await expect(follow).toBeEnabled();
  await follow.click();
  await expect(follow).toBeDisabled();
});
