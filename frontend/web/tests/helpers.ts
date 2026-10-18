import { expect, type Page } from '@playwright/test';

export async function section(page: Page, name: string) {
  if (name === '通知中心') {
    await page.getByRole('button', { name, exact: true }).click();
    return;
  }
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible()) {
    await page.getByLabel('浏览方式', { exact: true }).selectOption({ label: name });
    return;
  }
  const sidebar = page.locator('.sidebar');
  const target = sidebar.getByRole('button', { name: new RegExp(`^${name}(?: |$)`) });
  if (!(await target.isVisible())) {
    const group = ['待确认草案', '巡检与任务', '助手设置'].includes(name) ? '助手工具' : '更多音乐';
    await sidebar.getByText(group, { exact: true }).click();
  }
  await target.click();
}

export async function login(page: Page, options: { automaticSync?: boolean } = {}) {
  if (!options.automaticSync)
    await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
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
