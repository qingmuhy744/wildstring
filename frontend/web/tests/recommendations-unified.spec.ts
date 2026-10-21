import { section } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import { login, audio } from './helpers';
const headers = { 'X-Wildstring-Client': 'web' };
const localSources = ['personal', 'community', 'discovery', 'revisit'];

async function fixture(page: Page) {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  let preferences: any = {
    version: 1,
    use_ai: false,
    use_lastfm: false,
    count: 20,
    connection_id: 'local',
    sources: localSources,
    lastfm_tags: [],
    external_enabled: false,
    external_refresh_days: 7,
    external_sources: ['lastfm_charts', 'lastfm_tags', 'lastfm_artists'],
    external_use_ai: false,
  };
  const daily: any = {
    id: 'daily-synthetic',
    date: '2026-10-18',
    engine: 'local',
    connection_id: 'local',
    items: tracks.map((track: any, i: number) => ({
      track,
      reason: i ? '本站用户汇总常听，与本地探索一起保留。' : '来自你最近反复听的歌曲。',
      source_ids: i ? ['community', 'discovery'] : ['personal', 'revisit'],
    })),
    source_status: [
      { id: 'personal', status: 'ok', matched: 2 },
      { id: 'community', status: 'ok', matched: 2 },
    ],
    warnings: [],
    degraded: false,
  };
  const calls = {
    save: [] as any[],
    daily: [] as any[],
    discover: [] as any[],
    external: 0,
    rank: [] as string[],
  };
  const connection = (id: string, scope: string, shared: boolean) => ({
    id,
    name: id === 'mine' ? '我的连接' : id === 'shared' ? '全站共享' : '原有实例',
    scope,
    shared,
    model: 'synthetic-model',
    enabled: true,
    daily_call_budget: 20,
    daily_calls_used: 4,
    daily_calls_remaining: 16,
    my_usage: { calls: 2 },
    read_only: id !== 'mine',
    can_manage: id === 'mine',
  });
  await page.route('**/api/v1/agent/connections?*', (route) =>
    route.fulfill({
      json: {
        items: [
          connection('mine', 'personal', false),
          connection('shared', 'instance', true),
          connection('legacy', 'instance', true),
        ],
        total: 3,
        limit: 100,
        offset: 0,
      },
    }),
  );
  await page.route('**/api/v1/recommendations/preferences', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      calls.save.push(body);
      preferences = { ...body, version: preferences.version + 1 };
    }
    return route.fulfill({ json: preferences });
  });
  await page.route('**/api/v1/recommendations/daily', (route) => route.fulfill({ json: daily }));
  await page.route('**/api/v1/recommendations/daily/refresh', (route) => {
    calls.daily.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        ...daily,
        engine: 'local',
        degraded: true,
        warnings: [{ source: 'ai', code: 'daily_budget_exceeded' }],
      },
    });
  });
  await page.route('**/api/v1/ai/discover', (route) => {
    calls.discover.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        ...daily,
        title: '已核对的真实曲库候选',
        mode: 'local',
        degraded: true,
        warnings: [{ source: 'ai', code: 'daily_budget_exceeded' }],
      },
    });
  });
  await section(page, '每日推荐 · AI');
  return {
    tracks,
    calls,
    getPreferences: () => preferences,
    setPreferences: (value: any) => {
      preferences = value;
    },
    daily,
  };
}

test('统一连接和来源：保存不执行模型，显式请求共用连接与额度', async ({ page }, info) => {
  const { calls, getPreferences } = await fixture(page);
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  await expect(panel.getByRole('button', { name: '播放推荐', exact: true })).toBeEnabled();
  await page.screenshot({
    path: `../../artifacts/recommendations-daily-${info.project.name}-light.png`,
    fullPage: true,
  });
  await panel.locator('.ai-discover > summary').click();
  const selector = panel.getByLabel('这次找歌使用的连接', { exact: true });
  await expect(selector).toHaveValue('local');
  await expect(selector.locator('option')).toHaveCount(4);
  await selector.selectOption('shared');
  await expect(panel.locator('.model-budget').first()).toContainText('今日剩余 16 次');
  await panel.getByText('推荐偏好', { exact: true }).click();
  await expect(panel.getByLabel('找歌与推荐模型连接', { exact: true })).toHaveValue('shared');
  await panel.getByLabel('我常听', { exact: true }).uncheck();
  await panel.getByLabel('Last.fm 公共标签', { exact: true }).check();
  await panel
    .getByLabel('Last.fm 推荐标签', { exact: true })
    .pressSequentially('rock, indie, jazz');
  await expect(panel.getByLabel('Last.fm 推荐标签', { exact: true })).toHaveValue(
    'rock, indie, jazz',
  );
  await panel.getByLabel('每日首数', { exact: true }).fill('12');
  await panel.getByLabel('启用库外收歌建议', { exact: true }).check();
  await panel.getByLabel('收歌建议更新频率', { exact: true }).selectOption('14');
  await panel.getByRole('button', { name: '保存推荐偏好', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('偏好已保存');
  expect(calls.discover).toHaveLength(0);
  expect(calls.daily).toHaveLength(0);
  expect(calls.external).toBe(0);
  expect(getPreferences()).toMatchObject({
    connection_id: 'shared',
    use_ai: true,
    count: 12,
    lastfm_tags: ['rock', 'indie', 'jazz'],
    external_refresh_days: 14,
    external_use_ai: false,
  });
  expect(getPreferences().sources).not.toContain('personal');
  await panel.getByRole('button', { name: '换一批', exact: true }).click();
  await expect.poll(() => calls.daily.length).toBe(1);
  expect(calls.daily[0]).toEqual({ connection_id: 'shared', sources: getPreferences().sources });
  await panel.getByLabel('找歌或生成歌单', { exact: true }).fill('合成测试曲');
  await panel.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => calls.discover.length).toBe(1);
  expect(calls.discover[0]).toMatchObject({
    connection_id: 'shared',
    prompt: '合成测试曲',
    limit: 30,
  });
  const preview = panel.getByLabel('歌单候选预览');
  await preview.getByText('部分来源不可用，查看推荐依据', { exact: true }).click();
  await expect(preview).toContainText('模型额度不足');
  await selector.selectOption('local');
  await expect(panel.getByLabel('找歌与推荐模型连接', { exact: true })).toHaveValue('local');
  await expect(panel.getByLabel('使用已选模型整理收歌建议')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('个人与大家排行按真实范围请求，跨页队列完整且不展示账号', async ({ page }) => {
  const { tracks, calls } = await fixture(page);
  const ranked = Array.from({ length: 23 }, (_, i) => ({
    rank: i + 1,
    track: {
      ...tracks[i % 2],
      id: `rank-${i}`,
      title: `排行合成歌曲 ${String(i + 1).padStart(2, '0')}`,
    },
    play_count: 23 - i,
    listened_ms: (23 - i) * 60000,
    reason: '曲库用户汇总的实际收听记录',
  }));
  await page.route('**/api/v1/recommendations/rankings?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    calls.rank.push(q.toString());
    const offset = Number(q.get('offset')),
      limit = Number(q.get('limit'));
    return route.fulfill({
      json: {
        items: ranked.slice(offset, offset + limit),
        total: 23,
        limit,
        offset,
        scope: q.get('scope'),
        period: q.get('period'),
        metric: q.get('metric'),
        generated_at: '2026-10-18T08:00:00Z',
      },
    });
  });
  await page.getByRole('button', { name: '收听排行', exact: true }).click();
  const panel = page.getByRole('region', { name: '收听排行', exact: true });
  await expect(panel.locator('.ranking-track')).toHaveCount(20);
  const titleBox = await panel.locator('.ranking-track .track-title').first().boundingBox();
  const rowBox = await panel.locator('.ranking-track').first().boundingBox();
  expect(titleBox!.width).toBeGreaterThan(120);
  expect(rowBox!.height).toBeLessThan(180);
  await panel.getByRole('button', { name: '大家常听', exact: true }).click();
  await panel.getByLabel('排行时间范围').selectOption('7d');
  await panel.getByLabel('排行指标').selectOption('listened_ms');
  await expect.poll(() => calls.rank.at(-1)).toContain('metric=listened_ms');
  await expect(panel).toContainText('不展示个人记录');
  await expect(panel).not.toContainText('qingmuhy');
  await panel.getByRole('button', { name: '播放排行', exact: true }).click();
  await expect.poll(() => calls.rank.some((query) => query.includes('limit=100'))).toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => Object.values(localStorage).some((value) => value.includes('rank-22'))),
    )
    .toBe(true);
  await panel.getByRole('button', { name: '查看更多排行 · 20 / 23', exact: true }).click();
  await expect(panel.locator('.ranking-track')).toHaveCount(23);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('库外收歌建议只给线索，想收跨批保留，失败回滚与库内播放区分', async ({ page }, info) => {
  const { tracks, getPreferences, setPreferences } = await fixture(page);
  setPreferences({ ...getPreferences(), external_enabled: true, external_refresh_days: 0 });
  await section(page, '全部歌曲');
  await section(page, '每日推荐 · AI');
  const outside = {
    external_id: 'lastfm:outside',
    name: '晚风里的新线索',
    artists: ['合成推荐艺人'],
    album: '尚未收藏的合成专辑',
    source_url: 'https://www.last.fm/music/Wildstring+Fixture/_/Outside',
    reason: '结合你最近的摇滚收听与真实公开标签，留作下一次收歌的线索。',
    evidence: [{ source: 'Last.fm 标签', summary: '公开标签 rock，不代表新近发行。' }],
    local_track: null,
    wanted: false,
  };
  const imported = {
    ...outside,
    external_id: 'lastfm:local',
    name: tracks[0].title,
    local_track: tracks[0],
    reason: '这条线索已经匹配到你的曲库。',
  };
  let wanted: any[] = [];
  let batch: any = {
    id: 'external-1',
    items: [outside, imported],
    wanted_items: wanted,
    generated_at: '2026-10-18T08:00:00Z',
    next_refresh_at: null,
    status: 'ready',
    cached: true,
    stale: false,
    warnings: [],
    degraded: false,
    source_status: [
      { id: 'lastfm_tags', status: 'ok', candidate_count: 3, matched: 1, unmatched: 2 },
    ],
    connection_id: 'local',
  };
  let failDismiss = false,
    refreshCount = 0;
  await page.route('**/api/v1/recommendations/external', (route) =>
    route.fulfill({ json: { ...batch, wanted_items: wanted } }),
  );
  await page.route('**/api/v1/recommendations/external/refresh', (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    refreshCount++;
    batch = {
      ...batch,
      id: 'external-2',
      items: [{ ...outside, external_id: 'lastfm:another', name: '下一盒磁带的声音' }],
    };
    return route.fulfill({ json: { ...batch, wanted_items: wanted } });
  });
  await page.route('**/api/v1/recommendations/external/feedback', (route) => {
    const body = route.request().postDataJSON();
    if (failDismiss && body.action === 'dismiss')
      return route.fulfill({
        status: 503,
        headers: { 'X-Wildstring-Trace-Id': 'trace-external-feedback' },
        json: { detail: 'external_temporarily_unavailable' },
      });
    const item = [...batch.items, ...wanted].find(
      (entry) => entry.external_id === body.external_id,
    );
    wanted = wanted.filter((value) => value.external_id !== body.external_id);
    if (body.action === 'want') wanted.push({ ...item, wanted: true });
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: '发现新音乐', exact: true }).click();
  const panel = page.getByRole('region', { name: '发现新音乐', exact: true });
  await expect(panel.locator('.external-suggestion')).toHaveCount(2);
  const card = panel
    .locator('.external-suggestion')
    .filter({ has: page.getByRole('heading', { name: outside.name, exact: true }) });
  await expect(card.getByRole('button', { name: /播放/ })).toHaveCount(0);
  await expect(card.getByRole('link', { name: '查看 Last.fm 资料 ↗' })).toHaveAttribute(
    'href',
    outside.source_url,
  );
  await expect(
    panel.getByRole('button', { name: `播放已入库 ${tracks[0].title}`, exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        },
      },
    }),
  );
  await card.getByRole('button', { name: '复制歌名与艺人', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已复制');
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    '合成推荐艺人 - 晚风里的新线索',
  );
  await card.getByRole('button', { name: '想收这首', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已记在想收清单');
  await panel.getByRole('button', { name: '换一批收歌建议', exact: true }).click();
  await expect.poll(() => refreshCount).toBe(1);
  await panel.getByRole('button', { name: '我想收 · 1', exact: true }).click();
  await expect(panel.getByRole('heading', { name: outside.name, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '全部线索', exact: true }).click();
  failDismiss = true;
  const other = panel
    .locator('.external-suggestion')
    .filter({ has: page.getByRole('heading', { name: '下一盒磁带的声音', exact: true }) });
  await other.getByRole('button', { name: '不再推荐', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('trace-external-feedback');
  await expect(other).toBeVisible();
  await expect(panel.getByRole('button', { name: '我想收 · 1', exact: true })).toBeVisible();
  await panel.getByText('推荐来自哪里', { exact: true }).click();
  await expect(panel).toContainText('未匹配 2 首');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.evaluate((element) =>
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 24),
  );
  await page.screenshot({
    path: `../../artifacts/recommendations-external-${info.project.name}-light.png`,
    fullPage: false,
  });
  await page.evaluate(() => {
    localStorage.setItem('wildstring-theme', 'dark');
    window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: 'dark' }));
  });
  await page.screenshot({
    path: `../../artifacts/recommendations-external-${info.project.name}-dark.png`,
    fullPage: false,
  });
});

test('统一连接管理入口与旧实例配置都在助手设置中', async ({ page }) => {
  await fixture(page);
  await page.getByText('推荐偏好', { exact: true }).click();
  await page
    .getByRole('region', { name: '音乐发现' })
    .getByRole('button', { name: '管理模型连接 ↗', exact: true })
    .first()
    .click();
  const panel = page.getByRole('region', { name: '助手与通知设置', exact: true });
  await expect(panel).toContainText('模型连接');
  await expect(panel.getByText('原有实例连接（兼容配置）', { exact: true })).toBeVisible();
  await panel.getByText('原有实例连接（兼容配置）', { exact: true }).click();
  await expect(panel.getByLabel('AI 服务配置', { exact: true })).toBeVisible();
});

test('真实后端：账号推荐设置、本地请求和收听排行可回读', async ({ page }, info) => {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const existing = await (await page.request.get('/api/v1/recommendations/preferences')).json();
  const saved = await page.request.put('/api/v1/recommendations/preferences', {
    headers,
    data: {
      ...existing,
      connection_id: 'local',
      use_ai: false,
      count: 6,
      sources: localSources,
      external_enabled: false,
      external_use_ai: false,
    },
  });
  expect(saved.ok()).toBe(true);
  await section(page, '每日推荐 · AI');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  await panel.locator('.ai-discover > summary').click();
  await expect(panel.getByLabel('这次找歌使用的连接', { exact: true })).toHaveValue('local');
  await panel.getByText('推荐偏好', { exact: true }).click();
  await panel.getByLabel('每日首数', { exact: true }).fill('8');
  await panel.getByRole('button', { name: '保存推荐偏好', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('偏好已保存');
  expect((await (await page.request.get('/api/v1/recommendations/preferences')).json()).count).toBe(
    8,
  );
  await panel.getByRole('button', { name: '换一批', exact: true }).click();
  await expect(panel.getByRole('button', { name: '播放推荐', exact: true })).toBeEnabled();
  const batch = await (await page.request.get('/api/v1/recommendations/daily')).json();
  expect(batch.connection_id).toBe('local');
  expect(
    batch.items.every((item: any) => tracks.some((track: any) => track.id === item.track.id)),
  ).toBe(true);
  const listen = await page.request.post('/api/v1/listening', {
    headers,
    data: {
      session_id: crypto.randomUUID(),
      track_id: tracks[0].id,
      listened_ms: 6000,
      state: 'paused',
    },
  });
  expect(listen.ok()).toBe(true);
  await panel.getByText('推荐偏好', { exact: true }).click();
  await panel.getByRole('button', { name: '收听排行', exact: true }).click();
  const ranking = page.getByRole('region', { name: '收听排行', exact: true });
  await expect(ranking.locator('.ranking-track')).not.toHaveCount(0);
  await expect(ranking).toContainText(tracks[0].title);
  await panel.locator('.ai-discover > summary').click();
  await ranking.evaluate((element) =>
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 24),
  );
  await page.screenshot({
    path: `../../artifacts/recommendations-real-rankings-${info.project.name}.png`,
    fullPage: false,
  });
  await ranking.getByRole('button', { name: '播放排行', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toContain(tracks[0].id);
});

test('旧服务端只本地回退，不会默用全局付费模型', async ({ page }) => {
  const { setPreferences } = await fixture(page);
  setPreferences({ version: 1, use_ai: true, use_lastfm: false, count: 5 });
  let modelCalls = 0;
  await page.route('**/api/v1/agent/connections?*', (route) =>
    route.fulfill({ status: 404, json: { detail: 'not_found' } }),
  );
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/ai\/discover|\/daily\/refresh/.test(request.url()))
      modelCalls++;
  });
  await section(page, '全部歌曲');
  await section(page, '每日推荐 · AI');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  await panel.getByText('推荐偏好', { exact: true }).click();
  await expect(panel).toContainText('尚未提供统一连接');
  await panel.getByRole('button', { name: '换一批', exact: true }).click();
  await expect(panel.getByRole('button', { name: '播放推荐', exact: true })).toBeEnabled();
  await panel.locator('.ai-discover > summary').click();
  await panel.getByLabel('找歌或生成歌单', { exact: true }).fill('晴天');
  await panel.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(panel.getByLabel('歌单候选预览')).toContainText('晴天测试曲');
  expect(modelCalls).toBe(0);
});

test('真实后端：切换账号后推荐偏好与私人连接隔离', async ({ page }, info) => {
  await login(page);
  const username = `recommend-user-${info.project.name}`,
    password = 'synthetic-private-password';
  const created = await page.request.post('/api/v1/manage/users', {
    headers,
    data: { username, password, profile: 'listener' },
  });
  expect(created.ok()).toBe(true);
  const model = await page.request.post('/api/v1/agent/connections', {
    headers,
    data: {
      name: `私人推荐连接-${info.project.name}`,
      base_url: 'https://model.example.invalid/v1',
      model: 'synthetic-unused',
      daily_call_budget: 0,
    },
  });
  expect(model.ok()).toBe(true);
  const preferences = await (await page.request.get('/api/v1/recommendations/preferences')).json();
  expect(
    (
      await page.request.put('/api/v1/recommendations/preferences', {
        headers,
        data: {
          ...preferences,
          count: 11,
          connection_id: 'local',
          use_ai: false,
          external_enabled: false,
          lastfm_tags: ['private-admin-preference'],
        },
      })
    ).ok(),
  ).toBe(true);
  await section(page, '每日推荐 · AI');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  await panel.getByText('推荐偏好', { exact: true }).click();
  await expect(panel.getByLabel('每日首数', { exact: true })).toHaveValue('11');
  await expect(
    panel
      .getByLabel('找歌与推荐模型连接')
      .locator('option')
      .filter({ hasText: `私人推荐连接-${info.project.name}` }),
  ).toHaveCount(1);
  await page
    .getByRole('button', { name: /^退出登录/ })
    .first()
    .click();
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表', exact: true })).toBeVisible();
  await section(page, '每日推荐 · AI');
  await page.getByText('推荐偏好', { exact: true }).click();
  await expect(panel.getByLabel('每日首数', { exact: true })).toHaveValue('20');
  await expect(panel.getByLabel('Last.fm 推荐标签', { exact: true })).toHaveValue('');
  await expect(
    panel
      .getByLabel('找歌与推荐模型连接')
      .locator('option')
      .filter({ hasText: `私人推荐连接-${info.project.name}` }),
  ).toHaveCount(0);
  await expect(panel.getByLabel('找歌与推荐模型连接')).toHaveValue('local');
});
