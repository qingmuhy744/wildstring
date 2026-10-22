import { expect, test } from '@playwright/test';
import { login, section } from './helpers';

test('主题表单可读，默认连接参数与折叠导航一致', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'desktop') {
    const sidebar = page.locator('.sidebar');
    await expect(sidebar.getByRole('button', { name: '通知中心', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: '助手设置', exact: true })).toBeHidden();
    await expect(sidebar.getByRole('button', { name: '音乐助手', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '通知中心', exact: true })).toBeVisible();
  await section(page, '助手设置');
  await expect(page.getByLabel('单次输出 Token 上限')).toHaveValue('8192');
  await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('low');
  await expect(page.getByLabel('超时（秒）', { exact: true })).toHaveValue('90');
  await page.getByRole('button', { name: '对话历史', exact: true }).click();
  const input = page.getByLabel('助手历史保留天数');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const contrast = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value: string) => {
        const channels = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await input.fill('21');
    await expect(input).toHaveValue('21');
    await page.screenshot({
      path: `../../artifacts/052-verification/settings-${info.project.name}-${theme}.png`,
      fullPage: true,
    });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('推荐用临时歌单展示，更多菜单支持右键与偏好反馈', async ({ page }, info) => {
  await login(page);
  // Keep this visual interaction from changing the shared fixture's later recommendations.
  let dismissed = false;
  await page.route('**/api/v1/recommendations/feedback', (route) => {
    dismissed = route.request().postDataJSON().action === 'dismiss_track';
    return route.fulfill({ status: 204 });
  });
  await section(page, '每日推荐 · AI');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  const row = panel.locator('.daily-track').first();
  await expect(row).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(row.locator('.favorite-button')).toHaveCount(0);
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '不感兴趣', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '不感兴趣', exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/052-verification/daily-menu-${info.project.name}.png`,
    fullPage: false,
  });
  const title = (await row.locator('strong').innerText()).trim();
  await page.getByRole('menuitem', { name: '不感兴趣', exact: true }).click();
  await expect(
    panel.locator('.daily-track').filter({ has: page.getByText(title, { exact: true }) }),
  ).toHaveCount(0);
  expect(dismissed).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('迟到的设置回读不会覆盖已输入的保留天数', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/agent/assistant-preferences', async (route) => {
    await gate;
    return route.fulfill({
      json: { retention_days: 30, context_summary: true, long_term_memory: true },
    });
  });
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '对话历史', exact: true }).click();
  const input = page.getByLabel('助手历史保留天数');
  await input.fill('21');
  release!();
  await expect(page.getByRole('button', { name: '保存保留时间', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('21');
});

test('用户可以在账号设置中修改个人资料（登录 ID、昵称和邮箱）', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'mobile') {
    await page.getByLabel('浏览方式', { exact: true }).selectOption({ label: '账号设置' });
  } else {
    await page.getByRole('button', { name: '账号设置', exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: '账号设置', exact: true });
  await expect(dialog).toBeVisible();
  const form = dialog.getByRole('form', { name: '个人资料', exact: true });
  await expect(form).toBeVisible();
  const usernameInput = form.getByLabel('登录 ID');
  const displayNameInput = form.getByLabel('昵称');
  const emailInput = form.getByLabel('邮箱（仅作资料）');
  await expect(usernameInput).toHaveValue('admin');
  await displayNameInput.fill('管理员野弦');
  await emailInput.fill('admin@example.com');
  await form.getByRole('button', { name: '保存个人资料', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText('个人资料已保存。');
  await dialog.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await expect(dialog).toBeHidden();
});
