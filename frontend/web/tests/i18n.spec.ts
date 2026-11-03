import { expect, test, type Page } from '@playwright/test';
import { section } from './helpers';

test.use({ locale: 'en-US' });

const headers = { 'X-Wildstring-Client': 'web' };
const shots = process.env.WILDSTRING_I18N_SCREENSHOTS;

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: /Open library/ }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function openAccount(page: Page, name: string) {
  const mobile = page.locator('select.mobile-section');
  if (await mobile.isVisible()) await mobile.selectOption('account');
  else await page.locator('.sidebar .account-entry').click();
  const dialog = page.getByRole('region', { name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Appearance & language/ }).click();
  return dialog;
}

test('interface language follows the browser, then the account setting', async ({
  page,
  browser,
}, info) => {
  await signIn(page);
  try {
    let dialog = await openAccount(page, 'Personal settings');
    const language = dialog.getByLabel('Interface language');
    await expect(language).toHaveValue('auto');
    if (shots) {
      await language.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/${info.project.name}-account-en.png` });
    }

    await language.selectOption('zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    dialog = page.getByRole('region', { name: '个人设置' });
    await expect(dialog.getByRole('heading', { name: '外观与语言' })).toBeVisible();
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
      await second.getByLabel('Username', { exact: true }).fill('admin');
      await second.getByLabel('Password', { exact: true }).fill('disposable-browser-test-password');
      await second.getByRole('button', { name: /Open library/ }).click();
      await expect(second.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await expect(second.getByRole('table', { name: '歌曲列表' })).toBeVisible();
    } finally {
      await other.close();
    }

    await dialog.getByLabel('界面语言').selectOption('auto');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('region', { name: 'Personal settings', exact: true }),
    ).toBeVisible();
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
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password-for-i18n-test');
  await page.getByRole('button', { name: /Open library/ }).click();
  await expect(page.locator('.error, [role="alert"]').first()).toBeVisible();
  await expect(page.locator('.error, [role="alert"]').first()).not.toContainText(/[\u4e00-\u9fff]/);
});

test('recommendation page, preferences and charts are translated', async ({ page }, info) => {
  await signIn(page);
  await section(page, 'For you');
  const panel = page.getByRole('region', { name: 'Music discovery', exact: true });
  await expect(
    panel.getByRole('heading', { name: 'What are we listening to today?' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Play picks', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'New batch', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Select tracks', exact: true })).toBeVisible();
  await expect(panel.locator('.daily-hero-copy h2')).not.toHaveText(/[\u4e00-\u9fff]/);
  await expect(panel.locator('.daily-hero-copy .muted')).not.toHaveText(/[\u4e00-\u9fff]/);
  await expect(panel.locator('.daily-track')).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-discover-en.png` });

  await panel.getByText('Recommendation preferences', { exact: true }).click();
  await expect(panel.getByText('Library pick sources', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Tracks per day')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save preferences', exact: true })).toBeVisible();

  await panel.getByRole('button', { name: 'Listening charts', exact: true }).click();
  const charts = page.getByRole('region', { name: 'Listening charts', exact: true });
  await expect(charts.getByRole('heading', { name: 'The ones on repeat.' })).toBeVisible();
  await expect(charts.getByRole('button', { name: 'Play chart', exact: true })).toBeVisible();
  await expect(
    charts.getByRole('button', { name: 'Community repeats', exact: true }),
  ).toBeVisible();

  await panel.getByRole('button', { name: 'New finds', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New finds', exact: true })).toContainText(
    'Sounds not on your shelves yet.',
  );
});

test('assistant chat uses English labels and fallback text', async ({ page }, info) => {
  await signIn(page);
  await section(page, 'Music assistant');
  const panel = page.getByRole('region', { name: 'AI music assistant', exact: true });
  await expect(
    panel.getByRole('heading', { name: "Let's talk about what you want to hear." }),
  ).toBeVisible();
  const composer = panel.getByLabel('Message for the assistant');
  await expect(composer).toBeVisible();
  await composer.fill('calm music for tonight');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.workspace-message.assistant')).toContainText(
    'Local keyword search. No model was called.',
  );
  await expect(panel.getByText('Local keyword search · no model called')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-assistant-en.png` });
});

test('AI find uses English fallback titles', async ({ page }) => {
  await signIn(page);
  const current = await (await page.request.get('/api/v1/recommendations/preferences')).json();
  await page.route('**/api/v1/recommendations/preferences', (route) =>
    route.fulfill({ json: { ...current, sources: ['personal', 'discovery'] } }),
  );
  await page.route('**/api/v1/ai/discover', (route) =>
    route.fulfill({ json: { title: '曲库里的发现', items: [], mode: 'local' } }),
  );
  await section(page, 'For you');
  const panel = page.getByRole('region', { name: 'Music discovery', exact: true });
  await panel.locator('.ai-discover > summary').click();
  await panel.getByLabel('Find tracks or build a playlist').fill('calm');
  await panel.getByRole('button', { name: 'Generate picks', exact: true }).click();
  await expect(panel.locator('.ai-discover h3')).toHaveText('Local library finds');
});
