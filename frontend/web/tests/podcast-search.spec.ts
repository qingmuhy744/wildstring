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
  return page.getByRole('region', { name: '搜索或添加节目', exact: true });
}

test('探索区域热门节目，预览前后均不入库', async ({ page }, info) => {
  const regions: string[] = [];
  let additions = 0;
  const discoveries = Array.from({ length: 24 }, (_, index) => ({
    ...fireside,
    itunes_id: String(1183662640 + index),
    title: index ? `探索节目 ${index + 1}` : fireside.title,
    feed_url: `https://podcast.example.com/feed/${index}.xml`,
  }));
  await page.route('**/api/v1/podcasts/discover**', (route) => {
    regions.push(new URL(route.request().url()).searchParams.get('region') || 'default');
    return route.fulfill({ json: searchBody('', { regions: ['tw'], results: discoveries }) });
  });
  await page.route('**/api/v1/podcasts/preview', (route) => route.fulfill({ json: previewBody }));
  await page.route('**/api/v1/podcasts', (route) => {
    if (route.request().method() === 'POST') additions++;
    return route.fallback();
  });
  await login(page);
  await podcastCatalog(page);
  await page.getByRole('button', { name: '探索播客', exact: true }).click();
  const panel = page.getByRole('region', { name: '探索播客', exact: true });
  await expect(panel.locator('.podcast-search-card')).toHaveCount(24);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel.getByLabel('节目名称或 RSS 地址')).not.toBeFocused();
  const widths = info.project.name === 'desktop' ? [1360, 820] : [393, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 820 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      const input = (await panel.getByLabel('节目名称或 RSS 地址').boundingBox())!;
      const filters = (await panel.locator('.podcast-search-filters').boundingBox())!;
      expect(
        input.y + input.height + 8 <= filters.y || input.x + input.width + 8 <= filters.x,
      ).toBe(true);
      expect(filters.x + filters.width).toBeLessThanOrEqual(width);
      await expect(panel.getByLabel('探索区域')).toBeVisible();
      await page.screenshot({ path: `../../artifacts/podcast-explore-${width}-${theme}.png` });
    }
  }
  await panel.getByLabel('探索区域').selectOption('tw');
  await expect.poll(() => regions).toEqual(['default', 'tw']);
  await panel.locator('.podcast-search-card').last().click();
  const preview = panel.getByRole('region', { name: '节目预览' });
  await expect(preview).toContainText('第一集：预览单集');
  await expect(preview).toBeFocused();
  await page.screenshot({
    path: `../../artifacts/podcast-explore-preview-${info.project.name}.png`,
  });
  await preview.getByRole('button', { name: '返回结果', exact: false }).click();
  await expect(panel.locator('.podcast-search-card').last()).toBeFocused();
  await expect(panel.getByLabel('探索区域')).toHaveValue('tw');
  expect(additions).toBe(0);
  await panel.getByRole('button', { name: '返回电台', exact: false }).click();
  await expect(panel).toHaveCount(0);
});

test('关键词防抖搜索，合并多区结果并标注区域与成人内容', async ({ page }) => {
  const queries: string[] = [];
  await page.route('**/api/v1/podcasts/search?**', async (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    queries.push(q);
    await route.fulfill({ json: searchBody(q) });
  });
  const panel = await openSearch(page);
  const input = panel.getByLabel('节目名称或 RSS 地址');
  await input.pressSequentially('声东击西', { delay: 40 });
  await expect(panel.locator('.podcast-search-card')).toHaveCount(2);
  expect(queries).toEqual(['声东击西']);
  const first = panel.locator('.podcast-search-card').first();
  await expect(first).toContainText('434 集');
  await expect(first.locator('.podcast-search-region')).toHaveText(['美国', '台湾', '中国大陆']);
  await expect(panel.locator('.podcast-search-card').nth(1)).toContainText('成人');
  await expect(panel).toContainText('美国 · 台湾 · 中国大陆');
});

test('探索榜单超时可原地重试，也可重新点击热门探索刷新', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/v1/podcasts/discover**', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 504, json: { detail: { code: 'podcast_search_timeout' } } })
      : route.fulfill({ json: searchBody('', { results: [fireside] }) });
  });
  await login(page);
  await podcastCatalog(page);
  await page.getByRole('button', { name: '探索播客', exact: true }).click();
  const panel = page.getByRole('region', { name: '探索播客', exact: true });
  await expect(panel.getByRole('alert')).toContainText('热门榜单暂时无法加载');
  await panel.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.podcast-search-card')).toHaveCount(1);
  expect(requests).toBe(2);
  await panel.getByRole('button', { name: '热门探索', exact: true }).click();
  await expect.poll(() => requests).toBe(3);
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
  const panel = await openSearch(page);
  await panel.getByLabel('节目名称或 RSS 地址').fill('声东击西');
  await panel.locator('.podcast-search-card').first().click();
  const preview = panel.getByRole('region', { name: '节目预览' });
  await expect(preview).toContainText('第一集：预览单集');
  await expect(preview).toContainText('共 434 集');
  await expect(preview.locator('.podcast-search-description')).toHaveText(
    '一档关注社会与文化的中文播客。每周更新',
  );
  expect(previews).toEqual([{ feed_url: fireside.feed_url, itunes_id: '1183662640' }]);
  await preview.getByRole('button', { name: '添加并关注' }).click();
  await expect(panel).toHaveCount(0);
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
  const panel = await openSearch(page);
  await panel.getByLabel('节目名称或 RSS 地址').fill('https://etw.fm/rss');
  await expect(panel).toContainText('已识别为 RSS 地址');
  const preview = panel.getByRole('region', { name: '节目预览' });
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
  const panel = await openSearch(page);
  const input = panel.getByLabel('节目名称或 RSS 地址');
  await input.fill('王局');
  await expect(panel.getByRole('alert')).toContainText('Apple 播客目录暂时限制了搜索');
  await expect(panel.getByRole('alert')).toContainText('约 42 秒后可重试');
  await input.fill('王局拍案');
  await expect(panel.getByRole('status')).toContainText('部分区域暂时无法搜索：中国大陆');
  await input.fill('没有这个节目');
  await expect(panel).toContainText('没有找到与「没有这个节目」相关的节目');
});
