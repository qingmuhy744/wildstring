import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

test.use({ actionTimeout: 7000 });

test.skip(
  process.env.WILDSTRING_TEST_TRANSCODING !== '1',
  'Run make test-transcoding-web with FFmpeg',
);
async function openPlayer(page: Page, title: string) {
  await page.getByRole('button', { name: `播放 ${title}`, exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  return page.getByRole('dialog', { name: '全屏播放', exact: true });
}

test('真实 FLAC 转 AAC，变码率与跳转保持完整进度及同一收听会话', async ({ page }, info) => {
  await login(page);
  const sessions = new Set<string>();
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/listening') && request.method() === 'POST')
      sessions.add(request.postDataJSON().session_id);
  });
  const dialog = await openPlayer(page, '夜晚测试曲');
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await dialog.getByLabel('播放音质', { exact: true }).selectOption('320');
  await expect.poll(async () => (await audio(page)).source).toContain('format=aac');
  await expect(dialog.locator('.fullscreen-quality')).toContainText('AAC 320 kbps');
  expect((await audio(page)).paused).toBe(true);
  const progress = dialog.getByLabel('播放进度', { exact: true });
  await expect(progress).toHaveAttribute('max', '25');
  await dialog.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await progress.evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '9');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await audio(page)).source).toContain('start_ms=9000');
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThanOrEqual(9);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(async () => (await audio(page)).time).toBeLessThan(3);
  await expect(dialog.getByRole('list', { name: '歌词', exact: true })).toContainText('内嵌第三行');
  await dialog.getByLabel('播放音质', { exact: true }).selectOption('128');
  await expect(dialog.locator('.fullscreen-quality')).toContainText('AAC 128 kbps');
  await expect.poll(async () => Number(await progress.inputValue())).toBeGreaterThanOrEqual(9);
  await expect(progress).toHaveAttribute('max', '25');
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await page.screenshot({ path: `../../artifacts/aac-playback-${info.project.name}.png` });
  expect(sessions.size).toBe(1);
  await dialog.getByLabel('播放音质', { exact: true }).selectOption('original');
  await expect.poll(async () => (await audio(page)).source).not.toContain('format=aac');
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(9);
  expect((await audio(page)).paused).toBe(true);
});

test('有损音源选择 AAC 仍保持原音及播放位置', async ({ page }) => {
  await login(page);
  const dialog = await openPlayer(page, '晴天测试曲');
  const before = await audio(page);
  await dialog.getByLabel('播放音质', { exact: true }).selectOption('320');
  await expect(dialog.locator('.fullscreen-quality')).toContainText('原音直放');
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect((await audio(page)).source).toBe(before.source);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(before.time);
});
