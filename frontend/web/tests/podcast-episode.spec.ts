import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, podcastCatalog } from './helpers';

test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Requires the isolated podcast fixture.');

test('单集详情可阅读长标题、下载原音频，关闭后返回原入口', async ({ page }, info) => {
  const title = '从一段声音开始：聊聊那些陪伴我们走过漫长旅途的故事，以及下一次出发的方向';
  await page.route('**/api/v1/podcasts/radio-test', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.episodes[0].title = title;
    detail.episodes[0].pub_date = 'Mon, 25 Aug 2025 12:00:00 GMT';
    await route.fulfill({ response, json: detail });
  });
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  const trigger = page.getByRole('button', { name: title, exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('2025年8月25日发布');
  await expect(dialog).toContainText('时长 0:25');
  await expect(dialog.getByRole('link', { name: '下载 MP3' })).toBeVisible();
  const save = dialog.getByRole('button', { name: '保存到服务器', exact: true });
  await save.click();
  await expect(dialog.getByRole('button', { name: '取消个人保存', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消个人保存', exact: true }).click();
  for (const width of [320, 393, 820, 1360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('wildstring-theme', value);
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
      }, theme);
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await expect(dialog.getByRole('button', { name: '关闭详情' })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: '播放单集', exact: true })).toBeInViewport();
      const overflow = await dialog.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      if (info.project.name === 'desktop' && [393, 1360].includes(width))
        await page.screenshot({ path: `../../artifacts/podcast-episode-${width}-${theme}.png` });
    }
  }
  const pending = page.waitForEvent('download');
  await dialog.getByRole('link', { name: '下载 MP3' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('第 6 集：给午后的一封声音来信.mp3');
  expect(await download.failure()).toBeNull();
  const file = await readFile((await download.path())!);
  expect(file).toEqual(
    await readFile(new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url)),
  );
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
