import { expect, test, type Page, type Route } from '@playwright/test';
import { login, podcastCatalog } from './helpers';

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

const fireside = {
  itunes_id: '1183662640',
  title: '声东击西',
  author: '声东击西',
  artwork_url: '',
  feed_url: 'https://feeds.fireside.fm/shengdongjixi/rss',
  genres: ['Society & Culture'],
  episode_count: 434,
  explicit: false,
  latest_release_at: '2026-10-28T22:00:00Z',
  page_url: 'https://podcasts.apple.com/us/podcast/id1183662640',
  regions: ['us', 'tw', 'cn'],
  in_catalog: false,
  catalog_podcast_id: null,
  followed: false,
};

const anchor = {
  ...fireside,
  itunes_id: '1590000001',
  title: '声东击西小杨说',
  author: '小杨',
  feed_url: 'https://anchor.fm/s/example/podcast/rss',
  episode_count: 12,
  explicit: true,
  regions: ['us', 'tw'],
};

const searchBody = (query: string, extra: Record<string, unknown> = {}) => ({
  query,
  provider: 'itunes',
  regions: ['us', 'tw', 'cn'],
  failed_regions: [],
  cached: false,
  explicit_hidden: 0,
  results: [fireside, anchor],
  ...extra,
});

const previewBody = {
  feed_url: fireside.feed_url,
  resolved_feed_url: fireside.feed_url,
  title: '声东击西',
  author: '声东击西',
  description: '<p>一档关注<b>社会与文化</b>的中文播客。<br />每周更新</p>',
  cover_url: '',
  episode_count: 434,
  latest_episodes: [
    { title: '第一集：预览单集', pub_date: '2026-10-28T22:00:00Z', duration_seconds: 3600 },
    { title: '第二集：更早的单集', pub_date: '2026-10-21T22:00:00Z', duration_seconds: 2400 },
  ],
  in_catalog: false,
  catalog_podcast_id: null,
  followed: false,
};

async function openSearch(page: Page) {
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcasts-header').getByRole('button', { name: '+ 添加节目' }).click();
  return page.getByRole('dialog', { name: '搜索或添加节目' });
}

test('关键词防抖搜索，合并多区结果并标注区域与成人内容', async ({ page }) => {
  const queries: string[] = [];
  await page.route('**/api/v1/podcasts/search?**', async (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    queries.push(q);
    await route.fulfill({ json: searchBody(q) });
  });
  const dialog = await openSearch(page);
  const input = dialog.getByLabel('节目名称或 RSS 地址');
  await input.pressSequentially('声东击西', { delay: 40 });
  await expect(dialog.locator('.podcast-search-card')).toHaveCount(2);
  expect(queries).toEqual(['声东击西']);
  const first = dialog.locator('.podcast-search-card').first();
  await expect(first).toContainText('434 集');
  await expect(first.locator('.podcast-search-region')).toHaveText(['美国', '台湾', '中国大陆']);
  await expect(dialog.locator('.podcast-search-card').nth(1)).toContainText('成人');
  await expect(dialog).toContainText('美国 · 台湾 · 中国大陆');
});

test('预览不落库，确认后带 itunes_id 添加并打开节目', async ({ page }) => {
  await page.route('**/api/v1/podcasts/search?**', (route) =>
    route.fulfill({ json: searchBody('声东击西') }),
  );
  const previews: unknown[] = [];
  await page.route('**/api/v1/podcasts/preview', async (route) => {
    previews.push(route.request().postDataJSON());
    await route.fulfill({ json: previewBody });
  });
  let created: unknown = null;
  await page.route('**/api/v1/podcasts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON();
    const detail = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
    await route.fulfill({ json: detail });
  });
  const dialog = await openSearch(page);
  await dialog.getByLabel('节目名称或 RSS 地址').fill('声东击西');
  await dialog.locator('.podcast-search-card').first().click();
  const preview = dialog.getByRole('region', { name: '节目预览' });
  await expect(preview).toContainText('第一集：预览单集');
  await expect(preview).toContainText('共 434 集');
  await expect(preview.locator('.podcast-search-description')).toHaveText(
    '一档关注社会与文化的中文播客。每周更新',
  );
  expect(previews).toEqual([{ feed_url: fireside.feed_url, itunes_id: '1183662640' }]);
  await preview.getByRole('button', { name: '添加并关注' }).click();
  await expect(dialog).toHaveCount(0);
  expect(created).toEqual({ feed_url: fireside.feed_url, itunes_id: '1183662640' });
  await expect(page.locator('.podcast-meta-card h3')).toHaveText('午后广播测试');
});

test('粘贴 RSS 地址时直接预览，不调用目录搜索', async ({ page }) => {
  let searched = 0;
  await page.route('**/api/v1/podcasts/search?**', (route) => {
    searched += 1;
    return route.fulfill({ json: searchBody('x') });
  });
  await page.route('**/api/v1/podcasts/preview', (route) =>
    route.fulfill({ json: { ...previewBody, in_catalog: true, catalog_podcast_id: 'radio-test' } }),
  );
  const dialog = await openSearch(page);
  await dialog.getByLabel('节目名称或 RSS 地址').fill('https://etw.fm/rss');
  await expect(dialog).toContainText('已识别为 RSS 地址');
  const preview = dialog.getByRole('region', { name: '节目预览' });
  await expect(preview.getByRole('button', { name: '关注并打开' })).toBeVisible();
  expect(searched).toBe(0);
});

test('限流、部分区域失败与无结果都有明确提示', async ({ page }) => {
  let call = 0;
  await page.route('**/api/v1/podcasts/search?**', (route) => {
    call += 1;
    if (call === 1)
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '42' },
        json: { detail: { code: 'podcast_search_upstream_rate_limited', retry_after: 42 } },
      });
    if (call === 2)
      return route.fulfill({
        json: searchBody('王局拍案', {
          failed_regions: [{ region: 'cn', code: 'timeout' }],
          results: [fireside],
        }),
      });
    return route.fulfill({ json: searchBody('没有这个节目', { results: [] }) });
  });
  const dialog = await openSearch(page);
  const input = dialog.getByLabel('节目名称或 RSS 地址');
  await input.fill('王局');
  await expect(dialog.getByRole('alert')).toContainText('Apple 播客目录暂时限制了搜索');
  await expect(dialog.getByRole('alert')).toContainText('约 42 秒后可重试');
  await input.fill('王局拍案');
  await expect(dialog.getByRole('status')).toContainText('部分区域暂时无法搜索：中国大陆');
  await input.fill('没有这个节目');
  await expect(dialog).toContainText('没有找到与「没有这个节目」相关的节目');
});
