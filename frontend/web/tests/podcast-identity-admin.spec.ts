import { expect, test } from '@playwright/test';
import { login, section } from './helpers';

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

const show = (id: string, feed: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: '声东击西',
  author: 'ETW Studio',
  feed_url: feed,
  itunes_id: '1183662640',
  followers: 1,
  episodes: 3,
  downloaded: 1,
  redirects: false,
  ...extra,
});

const verified = {
  confidence: 'verified',
  reasons: ['feed', 'itunes_id', 'title'],
  itunes_id: '1183662640',
  suggested_keep_id: 'fireside',
  podcasts: [
    show('etw', 'https://etw.fm/rss', { redirects: true, followers: 2 }),
    show('fireside', 'https://feeds.fireside.fm/shengdongjixi/rss'),
  ],
};

const possible = {
  confidence: 'possible',
  reasons: ['title'],
  itunes_id: null,
  suggested_keep_id: 'w1',
  podcasts: [
    show('w1', 'https://a.example.com/wangju.xml', { title: '王局拍案', itunes_id: null }),
    show('w2', 'https://b.example.com/wangju.xml', { title: '王局拍案', itunes_id: null }),
  ],
};

const idle = {
  running: false,
  last_run: null,
  total: 4,
  with_itunes_id: 0,
  unchecked: 4,
  counts: { unchecked: 4 },
};

test('所有者回填 Apple 编号，只合并已核实的重复节目', async ({ page }) => {
  let status: Record<string, unknown> = idle;
  let duplicates: unknown[] = [{ ...possible }];
  let merged: unknown = null;
  let polls = 0;
  await page.route('**/api/v1/podcasts/identity/backfill', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ limit: 200, retry_unmatched: false });
      status = { ...idle, running: true, processed: 1, matched: 1, no_match: 0, failed: 0 };
      return route.fulfill({ status: 202, json: status });
    }
    polls += 1;
    if (status.running && polls > 2) {
      const run = {
        processed: 4,
        matched: 2,
        no_match: 2,
        failed: 0,
        ambiguous: 0,
        trigger: 'manual',
        duplicates: { verified: 1, possible: 1 },
      };
      status = { ...idle, with_itunes_id: 2, unchecked: 0, last_run: run };
      duplicates = [verified, possible];
    }
    return route.fulfill({ json: status });
  });
  await page.route('**/api/v1/podcasts/identity/duplicates', (route) =>
    route.fulfill({ json: { duplicates, verified: 0, possible: 0 } }),
  );
  await page.route('**/api/v1/podcasts/identity/merge', async (route) => {
    merged = route.request().postDataJSON();
    duplicates = [possible];
    return route.fulfill({
      json: {
        kept_id: 'fireside',
        merged_id: 'etw',
        episodes_moved: 1,
        episodes_matched: 2,
        progress_moved: 1,
        progress_replaced: 1,
        downloads_moved: 2,
        follows_moved: 2,
      },
    });
  });

  await login(page);
  await section(page, '管理');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const card = page.getByRole('region', { name: '播客去重与回填', exact: true });
  await expect(card).toContainText('共 4 个节目，已有 Apple 编号 0 个，待检查 4 个。');
  const list = card.getByRole('list', { name: '重复节目' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('疑似');
  await expect(list).toContainText('可信度不足，不会合并');
  await expect(list.getByRole('button')).toHaveCount(0);

  await card.getByRole('button', { name: '开始回填' }).click();
  await expect(card.getByRole('status', { name: '回填进度' })).toContainText(
    '上次回填：检查 4 个，匹配 2，未找到 2，失败 0；发现已核实重复 1 组、疑似 1 组，待管理员确认',
    { timeout: 15000 },
  );
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const pair = list.getByRole('listitem').first();
  await expect(pair).toContainText('已核实');
  await expect(pair).toContainText('（已重定向）');
  // The server picks the keeper (the feed that does not redirect); there is no choice to make.
  await expect(pair.getByRole('radio')).toHaveCount(0);
  await expect(
    pair.getByRole('group', { name: '「声东击西」https://feeds.fireside.fm/shengdongjixi/rss' }),
  ).toContainText('将保留');
  await expect(
    pair.getByRole('group', { name: '「声东击西」https://etw.fm/rss' }),
  ).not.toContainText('将保留');

  await pair.getByRole('button', { name: '合并…' }).click();
  await pair.getByRole('button', { name: '确认合并' }).click();
  await expect(card.getByText('已合并：移入 1 集，对齐 2 集')).toBeVisible();
  expect(merged).toEqual({ podcast_ids: ['etw', 'fireside'] });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('回填和重复节目接口真实可用', async ({ page }) => {
  await login(page);
  const status = await page.request.get('/api/v1/podcasts/identity/backfill');
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ running: false });
  const report = await page.request.get('/api/v1/podcasts/identity/duplicates');
  expect(report.status()).toBe(200);
  expect(await report.json()).toHaveProperty('duplicates');
});

test('启动后自动回填的结果标注来源，重复节目等待确认', async ({ page }) => {
  await page.route('**/api/v1/podcasts/identity/backfill', (route) =>
    route.fulfill({
      json: {
        ...idle,
        with_itunes_id: 2,
        unchecked: 0,
        last_run: {
          processed: 4,
          matched: 2,
          no_match: 2,
          failed: 0,
          ambiguous: 0,
          trigger: 'auto',
          duplicates: { verified: 1, possible: 1 },
        },
      },
    }),
  );
  await page.route('**/api/v1/podcasts/identity/duplicates', (route) =>
    route.fulfill({ json: { duplicates: [verified, possible], verified: 1, possible: 1 } }),
  );
  await login(page);
  await section(page, '管理');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const card = page.getByRole('region', { name: '播客去重与回填', exact: true });
  await expect(card.getByRole('status', { name: '回填进度' })).toContainText(
    '上次回填（启动后自动）：检查 4 个，匹配 2',
  );
  await expect(card.getByRole('status', { name: '回填进度' })).toContainText('待管理员确认');
  await expect(card.getByRole('list', { name: '重复节目' }).getByRole('listitem')).toHaveCount(2);
});
