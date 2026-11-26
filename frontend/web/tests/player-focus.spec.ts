import { expect, test } from '@playwright/test';
import { login, manageTab } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  test(`固定播放栏为管理表单的正反向键盘焦点留出空间（${theme}）`, async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await login(page);
    await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
    await page.locator('.player').getByRole('button', { name: '暂停', exact: true }).click();

    const name = `焦点回归书库 ${info.project.name} ${theme} ${Date.now()}`;
    const created = await page.request.post('/api/v1/book-libraries', {
      headers: { 'X-Wildstring-Client': 'web' },
      data: { name },
    });
    expect(created.status()).toBe(201);
    await manageTab(page, '书库与存储');
    const panel = page.getByRole('region', { name: '书库与存储配置', exact: true });
    await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await panel.getByRole('textbox', { name: '名称', exact: true }).focus();

    for (const key of ['Tab', 'Shift+Tab']) {
      let inspected = 0;
      for (let index = 0; index < 50; index++) {
        const focusedInPanel = await panel.evaluate((element) =>
          element.contains(document.activeElement),
        );
        if (!focusedInPanel) break;
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const focused = document.activeElement as HTMLElement;
              const rect = focused.getBoundingClientRect();
              const player = document.querySelector('.player')!.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return {
                abovePlayer: rect.bottom <= player.top,
                belowViewportTop: rect.top >= 0,
                coveredByPlayer: !!hit?.closest('.player'),
              };
            }),
          )
          .toEqual({ abovePlayer: true, belowViewportTop: true, coveredByPlayer: false });
        inspected++;
        await page.keyboard.press(key);
      }
      expect(inspected).toBeGreaterThanOrEqual(8);
      if (key === 'Tab') await page.keyboard.press('Shift+Tab');
    }
    await panel.getByRole('button', { name: '迁移书库存储', exact: true }).focus();
    await page.screenshot({ path: info.outputPath(`management-focus-${theme}.png`) });
  });
}
