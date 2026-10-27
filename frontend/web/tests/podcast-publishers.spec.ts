import { expect, test, type Page } from '@playwright/test';
import { login, section, podcastCatalog } from './helpers';

test.skip(process.env.WILDSTRING_TEST_PUBLISHERS !== '1', 'Run make test-publisher-web.');
const headers = { 'X-Wildstring-Client': 'web' };

async function reset(page: Page) {
  await login(page);
  for (const id of ['radio-test', 'publisher-second', 'publisher-unconfirmed']) {
    const current = await (await page.request.get(`/api/v1/podcasts/${id}`)).json();
    expect(
      (
        await page.request.put(`/api/v1/podcasts/${id}/publisher`, {
          headers,
          data: { version: current.podcast.publisher_version, publisher_id: null },
        })
      ).status(),
    ).toBe(200);
  }
  await podcastCatalog(page);
}

async function open(page: Page, title: string) {
  await page.locator('.podcast-card').filter({ hasText: title }).click();
  await expect(page.locator('.podcast-meta-card h3')).toHaveText(title);
}

test('手动确认、聚合本服节目、修正与解除归属，保留来源作者', async ({ page }, info) => {
  await reset(page);
  await open(page, '午后广播测试');
  await page.getByRole('button', { name: '确认出品方', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '出品方归属', exact: true });
  await expect(dialog).toContainText('来源作者：野弦测试');
  const name = `聚合测试-${info.project.name}`;
  await dialog.getByLabel('出品方名称', { exact: true }).fill(name);
  await page.screenshot({
    path: `../../artifacts/publisher-editor-light-${info.project.name}.png`,
  });
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/radio-test/publisher') && response.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const publisher = (await response.json()).podcast.publisher;
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('.podcast-card')).toHaveCount(1);
  await page.getByRole('button', { name: '← 返回电台列表', exact: true }).click();
  await open(page, '同出品方节目测试');
  await page.getByRole('button', { name: '确认出品方', exact: true }).click();
  await dialog.getByLabel('选择出品方', { exact: true }).selectOption(publisher.id);
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.podcast-card')).toHaveCount(2);
  await expect(page.locator('.podcast-card').filter({ hasText: '未确认归属节目测试' })).toHaveCount(
    0,
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `../../artifacts/publisher-${theme}-${info.project.name}.png` });
  }
  await open(page, '同出品方节目测试');
  await page.getByRole('button', { name: '修改出品方归属', exact: true }).click();
  await page.screenshot({ path: `../../artifacts/publisher-editor-dark-${info.project.name}.png` });
  await dialog.getByLabel('选择出品方', { exact: true }).selectOption('new');
  await dialog.getByLabel('出品方名称', { exact: true }).fill(`修正-${name}`);
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `修正-${name}`, exact: true })).toBeVisible();
  const oldGroup = await (
    await page.request.get(`/api/v1/podcasts/publishers/${publisher.id}`)
  ).json();
  expect(oldGroup.podcasts.map((item: { id: string }) => item.id)).toEqual(['radio-test']);
  await page.getByRole('button', { name: '修改出品方归属', exact: true }).click();
  await dialog.getByLabel('选择出品方', { exact: true }).selectOption('none');
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.podcast-publisher-affiliation')).toContainText('未确认');
  await expect(page.locator('.podcast-meta-author')).toHaveText('另一种作者署名');
});

test('并发修改要求重新读取当前归属', async ({ page }, info) => {
  await reset(page);
  await open(page, '午后广播测试');
  await page.getByRole('button', { name: '确认出品方', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '出品方归属', exact: true });
  const current = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
  expect(
    (
      await page.request.put('/api/v1/podcasts/radio-test/publisher', {
        headers,
        data: { version: current.podcast.publisher_version, name: `其他编辑-${info.project.name}` },
      })
    ).status(),
  ).toBe(200);
  await dialog.getByLabel('出品方名称', { exact: true }).fill('过期的修改');
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('归属已被修改');
  await expect(dialog.getByRole('button', { name: '确认并保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '重新读取当前归属', exact: true }).click();
  await expect(dialog).toContainText(`当前归属：其他编辑-${info.project.name}`);
  await expect(dialog.getByRole('button', { name: '确认并保存', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('听众可以查看聚合但没有修改入口', async ({ page }, info) => {
  await reset(page);
  const current = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
  expect(
    (
      await page.request.put('/api/v1/podcasts/radio-test/publisher', {
        headers,
        data: { version: current.podcast.publisher_version, name: '共享出品方' },
      })
    ).status(),
  ).toBe(200);
  const catalogPolicy = await (await page.request.get('/api/v1/podcasts/catalog-settings')).json();
  await page.request.put('/api/v1/podcasts/catalog-settings', {
    headers,
    data: { version: catalogPolicy.version, allow_user_subscriptions: true },
  });
  const username = `pub-listener-${info.project.name}`;
  expect(
    (
      await page.request.post('/api/v1/manage/users', {
        headers,
        data: { username, password: 'publisher-test-password', profile: 'listener' },
      })
    ).status(),
  ).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  expect(
    (
      await page.request.post('/api/v1/auth/login', {
        headers,
        data: { username, password: 'publisher-test-password' },
      })
    ).status(),
  ).toBe(200);
  await page.request.post('/api/v1/podcasts', {
    headers,
    data: { feed_url: current.podcast.feed_url },
  });
  await page.reload();
  await section(page, '电台 · 播客');
  await open(page, '午后广播测试');
  await expect(page.getByRole('button', { name: '修改出品方归属', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '共享出品方', exact: true }).click();
  await expect(page.locator('.podcast-card')).toHaveCount(1);
});
