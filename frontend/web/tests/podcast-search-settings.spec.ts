import { expect, test, type Page } from '@playwright/test';
import { login, section } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };

async function signInAs(page: Page, username: string, profile: string) {
  const libraries = await (await page.request.get('/api/v1/libraries')).json();
  const created = await page.request.post('/api/v1/manage/users', {
    headers,
    data: {
      username,
      password: `${username}-password-1`,
      profile,
      library_ids: libraries.map((library: { id: string }) => library.id),
    },
  });
  expect(created.status()).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  const signedIn = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { username, password: `${username}-password-1` },
  });
  expect(signedIn.status()).toBe(200);
  await page.reload();
}

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

test('所有者可调整播客搜索区域与成人内容过滤', async ({ page }) => {
  await login(page);
  await section(page, '管理');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const card = page.getByRole('region', { name: '播客目录搜索', exact: true });
  const regions = card.getByRole('list', { name: '搜索区域' });
  await expect(regions.getByRole('listitem')).toHaveText([/美国/, /台湾/, /中国大陆/]);
  await expect(card).toContainText('（当前使用默认）');

  await card.getByRole('button', { name: '移除美国' }).click();
  await card.getByRole('button', { name: '下移台湾' }).click();
  await card.getByLabel('添加区域').selectOption('hk');
  await card.getByRole('button', { name: '添加', exact: true }).click();
  await expect(regions.getByRole('listitem')).toHaveText([/中国大陆/, /台湾/, /香港/]);
  const explicit = card.getByRole('checkbox', { name: '从搜索结果中隐藏含成人内容的节目' });
  await expect(explicit).not.toBeChecked();
  await explicit.check();
  await card.getByRole('button', { name: '保存播客搜索设置' }).click();
  await expect(card.getByRole('status')).toHaveText('播客搜索设置已保存。');

  const saved = await (await page.request.get('/api/v1/podcasts/search-settings')).json();
  expect(saved.regions).toEqual(['cn', 'tw', 'hk']);
  expect(saved.filter_explicit).toBe(true);
  expect(saved.custom_regions).toBe(true);

  await explicit.uncheck();
  await card.getByRole('button', { name: '恢复默认区域' }).click();
  await expect(card.getByRole('status')).toHaveText('播客搜索设置已保存。');
  await expect(regions.getByRole('listitem')).toHaveText([/美国/, /台湾/, /中国大陆/]);
  const reset = await (await page.request.get('/api/v1/podcasts/search-settings')).json();
  expect(reset).toMatchObject({
    regions: ['us', 'tw', 'cn'],
    custom_regions: false,
    filter_explicit: false,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('曲库管理员可管理播客搜索设置与去重，其他实例设置仍只对所有者开放', async ({ page }, info) => {
  await login(page);
  await signInAs(page, `curator-${info.project.name}`, 'librarian');
  await section(page, '管理');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('region', { name: '播客去重与回填', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '播客添加权限', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI 模型连接', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '服务状态', exact: true })).toHaveCount(0);
  for (const name of ['用户', '诊断']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }

  const card = page.getByRole('region', { name: '播客目录搜索', exact: true });
  const explicit = card.getByRole('checkbox', { name: '从搜索结果中隐藏含成人内容的节目' });
  await explicit.check();
  await card.getByRole('button', { name: '保存播客搜索设置' }).click();
  await expect(card.getByRole('status')).toHaveText('播客搜索设置已保存。');
  expect(
    (await (await page.request.get('/api/v1/podcasts/search-settings')).json()).filter_explicit,
  ).toBe(true);
  // Leave the shared test server on its defaults for the other projects.
  await explicit.uncheck();
  await card.getByRole('button', { name: '恢复默认区域' }).click();
  await expect(card.getByRole('status')).toHaveText('播客搜索设置已保存。');
  expect(await (await page.request.get('/api/v1/podcasts/search-settings')).json()).toMatchObject({
    custom_regions: false,
    filter_explicit: false,
  });
  expect((await page.request.get('/api/v1/podcasts/identity/duplicates')).status()).toBe(200);
});

test('编辑者看不到设置页，也不能修改播客搜索设置', async ({ page }, info) => {
  await login(page);
  await signInAs(page, `writer-${info.project.name}`, 'editor');
  await section(page, '管理');
  await expect(page.getByRole('heading', { name: '曲库管理', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  const current = await (await page.request.get('/api/v1/podcasts/search-settings')).json();
  expect(current.can_manage).toBe(false);
  const denied = await page.request.put('/api/v1/podcasts/search-settings', {
    headers,
    data: { version: current.version, regions: ['jp'], filter_explicit: true },
  });
  expect(denied.status()).toBe(403);
  expect((await page.request.get('/api/v1/podcasts/identity/backfill')).status()).toBe(403);
});
