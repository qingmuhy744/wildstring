import { expect, type Page } from '@playwright/test';

export async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(3);
}

export async function audio(page: Page) {
  return page.locator('audio').evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    time: element.currentTime,
    duration: element.duration,
    volume: element.volume,
    source: element.currentSrc,
    ended: element.ended,
  }));
}
