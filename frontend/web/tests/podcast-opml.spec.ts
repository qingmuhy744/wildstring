import { expect, test, type Route } from '@playwright/test';
import { login, podcastCatalog } from './helpers';

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

const feeds = Array.from({ length: 12 }, (_, index) => ({
  title: `导入节目 ${index + 1}`,
  feed_url: `https://feeds.example.com/show-${index + 1}.xml`,
  html_url: '',
  in_catalog: index === 0,
  followed: index === 0,
  catalog_podcast_id: index === 0 ? 'radio-test' : null,
}));

const opml = `<?xml version="1.0"?><opml version="2.0"><body>${feeds
  .map((feed) => `<outline type="rss" text="${feed.title}" xmlUrl="${feed.feed_url}"/>`)
  .join('')}</body></opml>`;

test('OPML 导入先预览、可勾选，再分批导入并逐条显示结果', async ({ page }) => {
  const parsedBodies: string[] = [];
  const batches: string[][] = [];
  await page.route('**/api/v1/podcasts/opml/parse', async (route: Route) => {
    parsedBodies.push(route.request().postDataJSON().content);
    await route.fulfill({ json: { feeds, invalid: 1, duplicates: 2 } });
  });
  await page.route('**/api/v1/podcasts/opml/import', async (route: Route) => {
    const urls: string[] = route
      .request()
      .postDataJSON()
      .feeds.map((f: any) => f.feed_url);
    batches.push(urls);
    await route.fulfill({
      json: {
        results: urls.map((url) =>
          url.endsWith('show-3.xml')
            ? { feed_url: url, status: 'failed', code: 'podcast_feed_fetch_failed' }
            : {
                feed_url: url,
                status: 'added',
                podcast_id: url,
                title: feeds.find((f) => f.feed_url === url)!.title,
              },
        ),
      },
    });
  });
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcasts-header').getByRole('button', { name: '导入 OPML' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 OPML' });
  await dialog.getByLabel('选择 OPML 文件').setInputFiles({
    name: 'subscriptions.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from(opml),
  });
  await expect(dialog.getByRole('status')).toHaveText(
    '共 12 个节目，已合并 2 个重复项，忽略 1 个无效地址',
  );
  expect(parsedBodies[0]).toContain('show-12.xml');
  const list = dialog.getByRole('region', { name: 'OPML 节目列表' });
  const followed = list.getByRole('checkbox', { name: /导入节目 1\b/ });
  await expect(followed).toBeDisabled();
  await expect(followed).not.toBeChecked();
  await list.getByRole('checkbox', { name: /导入节目 12/ }).uncheck();
  await dialog.getByRole('button', { name: '导入所选（10）' }).click();

  const results = dialog.getByRole('region', { name: '导入结果' });
  await expect(results.getByRole('status')).toHaveText('导入完成：成功 9 个，失败 1 个');
  expect(batches).toEqual([feeds.slice(1, 11).map((feed) => feed.feed_url)]);
  await expect(results).toContainText('导入节目 3');
  await expect(results).toContainText('失败：无法获取这个 RSS 源，请检查地址或稍后重试。');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toBeHidden();
});

test('导入超过一批时按 10 个一批提交', async ({ page }) => {
  const many = Array.from({ length: 23 }, (_, index) => ({
    ...feeds[1],
    title: `批量 ${index}`,
    feed_url: `https://feeds.example.com/batch-${index}.xml`,
  }));
  const sizes: number[] = [];
  await page.route('**/api/v1/podcasts/opml/parse', (route) =>
    route.fulfill({ json: { feeds: many, invalid: 0, duplicates: 0 } }),
  );
  await page.route('**/api/v1/podcasts/opml/import', async (route) => {
    const batch = route.request().postDataJSON().feeds;
    sizes.push(batch.length);
    await route.fulfill({
      json: {
        results: batch.map((f: any) => ({
          feed_url: f.feed_url,
          status: 'followed',
          podcast_id: f.feed_url,
        })),
      },
    });
  });
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcasts-header').getByRole('button', { name: '导入 OPML' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 OPML' });
  await dialog.getByLabel('选择 OPML 文件').setInputFiles({
    name: 'big.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from('<opml/>'),
  });
  await dialog.getByRole('button', { name: '导入所选（23）' }).click();
  await expect(dialog.getByRole('status')).toHaveText('导入完成：成功 23 个，失败 0 个');
  expect(sizes).toEqual([10, 10, 3]);
});

test('解析失败时显示中文错误', async ({ page }) => {
  await page.route('**/api/v1/podcasts/opml/parse', (route) =>
    route.fulfill({ status: 422, json: { detail: 'podcast_opml_empty' } }),
  );
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcasts-header').getByRole('button', { name: '导入 OPML' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 OPML' });
  await dialog.getByLabel('选择 OPML 文件').setInputFiles({
    name: 'empty.opml',
    mimeType: 'text/x-opml',
    buffer: Buffer.from('<opml/>'),
  });
  await expect(dialog.getByRole('alert')).toHaveText('这个 OPML 文件里没有找到任何 RSS 节目。');
  await expect(dialog.getByRole('button', { name: /导入所选/ })).toBeDisabled();
});

test('导出 OPML 下载当前账号关注的节目', async ({ page }) => {
  await login(page);
  await podcastCatalog(page);
  const link = page.locator('.podcasts-header').getByRole('link', { name: '导出 OPML' });
  await expect(link).toHaveAttribute('href', '/api/v1/podcasts/opml/export');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('wildstring-podcasts.opml');
  const response = await page.request.get('/api/v1/podcasts/opml/export');
  expect(response.ok()).toBe(true);
  const text = await response.text();
  expect(text).toContain('<opml version="2.0">');
});
