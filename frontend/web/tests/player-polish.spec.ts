import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('全屏播放控件对齐、模式图标易点击，空白点击不收起歌词', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  const mode = player.getByRole('button', { name: /播放模式：/ });
  await mode.click();
  await mode.click();
  await mode.click();
  await expect(mode).toHaveAttribute('aria-label', '播放模式：随机播放');
  const bounds = (await mode.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  const icon = (await mode.locator('svg').boundingBox())!;
  expect(icon.width).toBeGreaterThanOrEqual(24);
  expect(icon.height).toBeGreaterThanOrEqual(24);
  const blank = (await player.locator('.lyric-scroll').boundingBox())!;
  await page.mouse.click(blank.x + 2, blank.y + 2);
  await expect(player.getByRole('list', { name: '歌词', exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `../../artifacts/fullscreen-controls-${info.project.name}.png` });
});
