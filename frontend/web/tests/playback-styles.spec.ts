import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

async function chooseStyle(page: Page, value: string) {
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  if (await player.isVisible()) await player.getByRole('button', { name: '收起全屏播放' }).click();
  const navigation = page.getByLabel('浏览方式', { exact: true });
  if (await navigation.isVisible()) await navigation.selectOption('account');
  else await page.getByRole('button', { name: '账号设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '账号设置', exact: true });
  await settings.getByLabel('播放样式', { exact: true }).selectOption(value);
  await settings.getByRole('button', { name: '关闭账号设置' }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(player.getByLabel('播放样式', { exact: true })).toHaveCount(0);
}

test('三种样式共用音频，暂停保留进度，开关歌词不重开串流', async ({ page }, info) => {
  let streams = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/stream'))
      streams++;
  });
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.3);
  const element = await page.locator('audio').elementHandle();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  const visual = dialog.locator('.playback-visual');
  await expect(visual).toHaveAttribute('data-style', 'cover');
  await expect(dialog.getByLabel('播放样式')).toHaveCount(0);
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const paused = await audio(page);
  const reads = streams;
  for (const value of ['vinyl', 'cassette', 'cover', 'vinyl']) {
    await chooseStyle(page, value);
    await expect(visual).toHaveAttribute('data-style', value);
    await expect(visual).toHaveAttribute('data-moving', 'false');
    expect(await audio(page)).toEqual(paused);
  }
  expect(await element!.evaluate((node) => node === document.querySelector('audio'))).toBe(true);
  await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
  await page.screenshot({ path: `../../artifacts/player-vinyl-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '切换封面与歌词', exact: true }).click();
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  expect(await audio(page)).toEqual(paused);
  expect(streams).toBe(reads);

  await dialog.getByRole('button', { name: '播放', exact: true }).click();
  await expect(visual).toHaveAttribute('data-moving', 'true');
  const phase = () => visual.evaluate((node) => node.style.getPropertyValue('--spin'));
  const initial = await phase();
  await expect.poll(phase).not.toBe(initial);
  await chooseStyle(page, 'cassette');
  await expect(visual).toHaveAttribute('data-moving', 'true');
  await page.screenshot({ path: `../../artifacts/player-cassette-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(visual).toHaveAttribute('data-moving', 'false');
  const stopped = await phase();
  await page.waitForTimeout(150);
  expect(await phase()).toBe(stopped);
  await dialog.getByRole('button', { name: '收起全屏播放' }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(visual).toHaveAttribute('data-style', 'cassette');
  await expect.poll(phase).toBe(stopped);
  expect(streams).toBe(reads);

  await page.reload();
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('account');
  else await page.getByRole('button', { name: '账号设置', exact: true }).click();
  const account = page.getByRole('dialog', { name: '账号设置', exact: true });
  await expect(account.getByLabel('播放样式', { exact: true })).toHaveValue('cassette');
  await account.getByLabel('播放样式', { exact: true }).selectOption('cover');
});

test('减少动态、页面隐藏与缓冲会停止拟物动画，恢复后继续播放', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('wildstring-playback-style', 'invalid-old-style'),
  );
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(dialog.locator('.playback-visual')).toHaveAttribute('data-style', 'cover');
  await chooseStyle(page, 'vinyl');
  const visual = dialog.locator('.playback-visual');
  await expect(visual).toHaveAttribute('data-moving', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(visual).toHaveAttribute('data-moving', 'false');
  expect((await audio(page)).paused).toBe(false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(visual).toHaveAttribute('data-moving', 'true');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(visual).toHaveAttribute('data-moving', 'false');
  const hiddenPhase = await visual.evaluate((node) => node.style.getPropertyValue('--spin'));
  await page.waitForTimeout(150);
  expect(await visual.evaluate((node) => node.style.getPropertyValue('--spin'))).toBe(hiddenPhase);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    document.querySelector('audio')!.dispatchEvent(new Event('waiting'));
  });
  await expect(visual).toHaveAttribute('data-moving', 'false');
  await page.evaluate(() => document.querySelector('audio')!.dispatchEvent(new Event('playing')));
  await expect(visual).toHaveAttribute('data-moving', 'true');
  expect((await audio(page)).paused).toBe(false);
});

test('拟物样式在手机、桌面和窄横屏保持视觉与控制可达', async ({ page }, info) => {
  test.setTimeout(60_000);
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
  for (const value of ['vinyl', 'cassette']) {
    await chooseStyle(page, value);
    await expect(dialog.locator('.playback-visual')).toBeVisible();
    if (
      (await dialog
        .getByRole('button', { name: '显示歌词', exact: true })
        .getAttribute('aria-pressed')) === 'true'
    )
      await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
    const stage = (await dialog.locator('.playback-visual').boundingBox())!;
    const cover = (await dialog.locator('.fullscreen-cover').boundingBox())!;
    expect(cover.width).toBeLessThanOrEqual(stage.width * (value === 'cassette' ? 0.16 : 0.55));
    if (value === 'vinyl') expect(cover.width).toBeGreaterThan(stage.width * 0.45);
    expect(cover.x).toBeGreaterThanOrEqual(stage.x);
    expect(cover.y).toBeGreaterThanOrEqual(stage.y);
    expect(cover.x + cover.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
    await page.screenshot({ path: `../../artifacts/player-${value}-${info.project.name}.png` });
  }
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 740, height: 390 },
    { width: 900, height: 410 },
  ]) {
    await page.setViewportSize(viewport);
    const controls = [
      dialog.getByRole('button', { name: '播放', exact: true }),
      dialog.getByLabel('播放进度'),
    ];
    for (const value of ['vinyl', 'cassette']) {
      await chooseStyle(page, value);
      if (
        (await dialog
          .getByRole('button', { name: '显示歌词', exact: true })
          .getAttribute('aria-pressed')) === 'true'
      )
        await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
      for (const control of controls) {
        await expect(control).toBeVisible();
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      if (viewport.width > viewport.height) {
        const visual = (await dialog.locator('.playback-visual').boundingBox())!;
        const transport = (await dialog.locator('.transport').boundingBox())!;
        expect(visual.width).toBeGreaterThan(viewport.height * 0.55);
        expect(visual.x + visual.width).toBeLessThan(transport.x);
        await page.screenshot({
          path: `../../artifacts/player-${value}-landscape-${info.project.name}-${viewport.width}.png`,
        });
        await dialog.getByRole('button', { name: '显示歌词', exact: true }).click();
        await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible();
      }
    }
  }
});
