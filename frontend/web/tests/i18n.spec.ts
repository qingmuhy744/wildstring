import { expect, test, type Page } from '@playwright/test';

test.use({ locale: 'en-US' });

const headers = { 'X-Wildstring-Client': 'web' };
const shots = process.env.WILDSTRING_I18N_SCREENSHOTS;

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: /Open library/ }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function openAccount(page: Page, name: string) {
  const mobile = page.locator('select.mobile-section');
  if (await mobile.isVisible()) await mobile.selectOption('account');
  else await page.locator('.sidebar .account-entry').click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('interface language follows the browser, then the account setting', async ({
  page,
  browser,
}, info) => {
  await signIn(page);
  try {
    let dialog = await openAccount(page, 'Account settings');
    const language = dialog.getByLabel('Interface language');
    await expect(language).toHaveValue('auto');
    if (shots) {
      await language.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/${info.project.name}-account-en.png` });
    }

    await language.selectOption('zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    dialog = page.getByRole('dialog', { name: '账号设置' });
    await expect(dialog.getByRole('heading', { name: '账号设置' })).toBeVisible();
    await expect
      .poll(
        async () => (await (await page.request.get('/api/v1/auth/status')).json()).user.language,
      )
      .toBe('zh');
    if (shots) {
      await dialog.getByLabel('界面语言').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/${info.project.name}-account-zh.png` });
    }

    // Another device with an English browser follows the account once signed in.
    const other = await browser.newContext({ locale: 'en-US', viewport: page.viewportSize()! });
    try {
      const second = await other.newPage();
      await second.goto('/');
      await expect(second.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await second.getByLabel('Password', { exact: true }).fill('disposable-browser-test-password');
      await second.getByRole('button', { name: /Open library/ }).click();
      await expect(second.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await expect(second.getByRole('table', { name: '歌曲列表' })).toBeVisible();
    } finally {
      await other.close();
    }

    await dialog.getByLabel('界面语言').selectOption('auto');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('dialog', { name: 'Account settings' })).toBeVisible();
  } finally {
    await page.request.put('/api/v1/auth/preferences', { headers, data: { language: 'auto' } });
  }
});

test('unsupported browser languages fall back to English', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: /Open library/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('error codes are translated for English', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password-for-i18n-test');
  await page.getByRole('button', { name: /Open library/ }).click();
  await expect(page.locator('.error, [role="alert"]').first()).toBeVisible();
  await expect(page.locator('.error, [role="alert"]').first()).not.toContainText(/[\u4e00-\u9fff]/);
});
