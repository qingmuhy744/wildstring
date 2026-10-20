import { expect, test } from '@playwright/test';
import { audio } from './helpers';

test.skip(process.env.WILDSTRING_TEST_DISC_LIBRARY !== '1', '独立分碟真实曲库夹具');
test('分碟仅作标题：连续跨碟、完整排序队列和偏好保存', async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '专辑', exact: true })
    .click();
  await page.getByLabel('列表排序').selectOption('added_at');
  await expect(page.getByRole('navigation', { name: '首字母定位' })).toHaveCount(0);
  await page.getByRole('button', { name: '打开专辑 分碟排序专辑' }).click();
  await expect(page.locator('.disc-heading')).toHaveCount(2);
  await expect(page.locator('.disc-heading').first()).toContainText('DISC 01');
  await expect(page.locator('.disc-heading').first()).toContainText('3 首');
  await expect(page.locator('.track-number')).toHaveText(['01', '02', '03', '01', '02', '03']);
  await page.getByRole('button', { name: '播放 Gamma', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect
    .poll(async () => {
      const duration = (await audio(page)).duration;
      return Number.isFinite(duration) && duration > 0;
    })
    .toBe(true);
  await page.evaluate(() => {
    const element = document.querySelector('audio')!;
    element.currentTime = element.duration - 0.15;
  });
  await expect(page.locator('.player')).toContainText('Alpha');
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.screenshot({ path: info.outputPath('disc-titles.png'), fullPage: true });
  await page.getByLabel('列表排序').selectOption('name');
  await expect(page.locator('.disc-heading')).toHaveCount(0);
  await expect(page.locator('.track-title strong')).toHaveText([
    'Alpha',
    'Beta',
    'Delta',
    'Echo',
    'Gamma',
    'Zeta',
  ]);
  await expect(page.locator('.disc-chip')).toHaveCount(6);
  await page.getByRole('button', { name: '切换为降序' }).click();
  await expect(page.locator('.track-title strong')).toHaveText([
    'Zeta',
    'Gamma',
    'Echo',
    'Delta',
    'Beta',
    'Alpha',
  ]);
  await page.getByRole('button', { name: '播放专辑', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) => key.startsWith('wildstring:playback:'));
        return key
          ? JSON.parse(localStorage.getItem(key)!).tracks.map((t: { title: string }) => t.title)
          : [];
      }),
    )
    .toEqual(['Zeta', 'Gamma', 'Echo', 'Delta', 'Beta', 'Alpha']);
  await page.getByLabel('列表排序').selectOption('track_number');
  await page.getByRole('button', { name: '切换为降序' }).click();
  await expect(page.locator('.disc-heading').first()).toContainText('DISC 02');
  await page.reload();
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '专辑', exact: true })
    .click();
  await expect(page.getByLabel('列表排序')).toHaveValue('added_at');
  await page.getByRole('button', { name: '打开专辑 分碟排序专辑' }).click();
  await expect(page.getByLabel('列表排序')).toHaveValue('track_number');
  await expect(page.locator('.disc-heading').first()).toContainText('DISC 02');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
