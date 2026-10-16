import { expect, test } from '@playwright/test';
import { audio, login } from './helpers';

test('歌词浏览不误跳转，PC 点文字跳转，触屏显式确认，空白切换', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
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
    await expect(dialog.getByRole('group', { name: '歌词跳转预览' })).toBeVisible();
    expect(await audio(page)).toEqual(before);
    await dialog.getByRole('button', { name: '选择 0:06：侧车第三行', exact: true }).click();
    expect(await audio(page)).toEqual(before);
    await dialog.getByRole('button', { name: '确认跳转到 0:06', exact: true }).click();
  } else {
    await viewport.hover();
    await page.mouse.wheel(0, 100);
    await expect(dialog.getByRole('button', { name: '跟随播放', exact: true })).toBeEnabled();
    expect(await audio(page)).toEqual(before);
    await dialog.getByRole('button', { name: '跳转到 0:06：侧车第三行', exact: true }).click();
  }
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(5.9);
  expect((await audio(page)).paused).toBe(true);
  await expect(dialog.getByRole('button', { name: '跟随播放', exact: true })).toBeDisabled();
  const blank = async () => {
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.click(bounds.x + 2, bounds.y + 2);
  };
  await blank();
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toHaveCount(0);
  // Empty space beside the visual also switches back without touching playback.
  const record = (await dialog.locator('.fullscreen-record').boundingBox())!;
  await page.mouse.click(record.x + 2, record.y + 2);
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  expect((await audio(page)).paused).toBe(true);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(5.9);
});
