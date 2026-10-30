import { expect, test } from '@playwright/test';
import { login, section } from './helpers';

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
