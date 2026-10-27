import { expect, test, type Page } from '@playwright/test';
import { login, section, podcastCatalog } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Requires the local podcast fixture.');

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function signOut(page: Page) {
  await page
    .getByRole('button', { name: /退出登录/ })
    .filter({ visible: true })
    .click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
}

test('两个账号分别设置同一节目的自动下载，普通用户只有个人入口', async ({
  page,
  browser,
}, info) => {
  await login(page);
  const originalDownload = await (
    await page.request.get('/api/v1/podcasts/radio-test/download-settings')
  ).json();
  const originalFollow = (await (await page.request.get('/api/v1/podcasts/radio-test')).json())
    .podcast.followed;
  const originalOwnerCache = (
    await (await page.request.get('/api/v1/podcasts/episodes/radio-1')).json()
  ).resource_playback_cached;
  const name = `auto-${Date.now()}`;
  const created = await page.request.post('/api/v1/manage/users', {
    headers,
    data: { username: name, password: 'personal-test-password', library_ids: [] },
  });
  expect(created.status()).toBe(201);
  const user = await created.json();
  const original = await (await page.request.get('/api/v1/podcasts/catalog-settings')).json();
  await page.request.put('/api/v1/podcasts/catalog-settings', {
    headers,
    data: { version: original.version, allow_user_subscriptions: true },
  });
  const otherContext = await browser.newContext({ viewport: page.viewportSize()! });
  const other = await otherContext.newPage();
  try {
    await page.request.put('/api/v1/podcasts/radio-test/follow', {
      headers,
      data: { followed: true },
    });
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await page.getByRole('button', { name: '自动下载', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '自动下载设置', exact: true });
    await dialog.getByRole('radio', { name: '最新 5 集', exact: true }).check();
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: /^我的下载/ }).click();
    await expect(
      page.getByRole('button', { name: '自动保存 · 另作手动保存', exact: true }),
    ).toHaveCount(5);
    await signIn(other, name, 'personal-test-password');
    expect(await (await other.request.get('/api/v1/podcasts')).json()).toEqual([]);
    const feed = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
    const added = await other.request.post('/api/v1/podcasts', {
      headers,
      data: { feed_url: feed.podcast.feed_url },
    });
    expect(added.status()).toBe(200);
    await section(other, '电台 · 播客');
    await expect(other.getByRole('button', { name: '本服节目', exact: true })).toHaveCount(0);
    await other.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await expect(other.getByRole('button', { name: '服务器下载设置' })).toHaveCount(0);
    await other.getByRole('button', { name: '自动下载', exact: true }).click();
    dialog = other.getByRole('dialog', { name: '自动下载设置', exact: true });
    await expect(dialog.getByRole('radio', { name: '关闭自动下载', exact: true })).toBeChecked();
    await dialog.getByRole('radio', { name: '最新 3 集', exact: true }).check();
    await dialog.getByRole('radio', { name: '释放我的自动保存', exact: true }).check();
    await other.screenshot({
      path: `../../artifacts/podcast-personal-${info.project.name}.png`,
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await (await page.request.get('/api/v1/podcasts/radio-test/download-settings')).json(),
    ).toMatchObject({ download_policy: 'latest_5', retention_policy: 'keep' });
    expect(
      await (await other.request.get('/api/v1/podcasts/radio-test/download-settings')).json(),
    ).toMatchObject({ download_policy: 'latest_3', retention_policy: 'delete_after_played' });
    await other.getByRole('button', { name: '自动下载', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: '最新 3 集', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await other.getByRole('button', { name: /^我的下载/ }).click();
    await expect(other.locator('.podcast-episode-row')).toHaveCount(3);
    const playback = await (await other.request.get('/api/v1/podcasts/playback-settings')).json();
    await other.request.put('/api/v1/podcasts/playback-settings', {
      headers,
      data: {
        version: playback.version,
        auto_cache_current: true,
        prefetch_next: false,
        network_policy: 'any',
      },
    });
    await other.getByRole('button', { name: '全部单集 7', exact: true }).click();
    const [cached] = await Promise.all([
      other.waitForResponse((response) => response.url().includes('/episodes/radio-1/stream?')),
      other
        .locator('.podcast-episode-row')
        .filter({ hasText: '第 1 集：给午后的一封声音来信' })
        .locator('.episode-play-btn')
        .click(),
    ]);
    expect(cached.status()).toBeLessThan(300);
    await other.getByRole('button', { name: '暂停', exact: true }).click();
    await other.getByRole('button', { name: /^我的下载/ }).click();
    await expect(other.locator('.podcast-episode-row')).toHaveCount(4);
    await expect(
      other.locator('.podcast-episode-row').filter({ hasText: '第 1 集' }),
    ).toContainText('播放缓存');
    expect(
      (await (await other.request.get('/api/v1/podcasts/episodes/radio-1')).json()).resource_saved,
    ).toBe(false);
    expect(
      (await (await page.request.get('/api/v1/podcasts/episodes/radio-1')).json())
        .resource_playback_cached,
    ).toBe(originalOwnerCache);
    await other
      .locator('.podcast-episode-row')
      .filter({ hasText: '第 1 集' })
      .scrollIntoViewIfNeeded();
    await other.mouse.move(0, 0);
    for (const theme of ['light', 'dark']) {
      await other.evaluate((value) => {
        localStorage.setItem('wildstring-theme', value);
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
      }, theme);
      await other.screenshot({
        path: `../../artifacts/podcast-my-downloads-${theme}-${info.project.name}.png`,
        animations: 'disabled',
      });
    }
  } finally {
    const download = await (
      await page.request.get('/api/v1/podcasts/radio-test/download-settings')
    ).json();
    await page.request.put('/api/v1/podcasts/radio-test/download-settings', {
      headers,
      data: {
        version: download.version,
        download_policy: originalDownload.download_policy,
        retention_policy: originalDownload.retention_policy,
      },
    });
    if (!originalFollow)
      await page.request.put('/api/v1/podcasts/radio-test/follow', {
        headers,
        data: { followed: false },
      });
    const current = await (await page.request.get('/api/v1/podcasts/catalog-settings')).json();
    await page.request.put('/api/v1/podcasts/catalog-settings', {
      headers,
      data: {
        version: current.version,
        allow_user_subscriptions: original.allow_user_subscriptions,
      },
    });
    await page.request.delete(`/api/v1/manage/users/${user.id}`, { headers });
    await otherContext.close();
  }
});

test('同一浏览器切换账号时，界面和离线偏好各自恢复，旧偏好只迁移一次', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('wildstring:preferences-legacy-owner')) {
      localStorage.setItem('wildstring-theme', 'dark');
      localStorage.setItem('wildstring-playback-style', 'vinyl');
      localStorage.setItem('wildstring:track-list-size', 'large');
      localStorage.setItem('wildstring:download-bitrate', '192');
    }
  });
  await login(page);
  const name = `prefs-${Date.now()}`;
  const created = await (
    await page.request.post('/api/v1/manage/users', {
      headers,
      data: { username: name, password: 'personal-test-password' },
    })
  ).json();
  await section(page, '账号设置');
  let settings = page.getByRole('dialog', { name: '账号设置', exact: true });
  await expect(settings.getByLabel('外观模式')).toHaveValue('dark');
  await expect(settings.getByLabel('播放样式')).toHaveValue('vinyl');
  await expect(settings.getByLabel('歌曲列表大小')).toHaveValue('large');
  await settings.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await section(page, '离线音乐');
  await page.getByRole('region', { name: '离线音乐', exact: true }).locator('summary').click();
  await expect(page.getByLabel('默认下载音质', { exact: true })).toHaveValue('192');
  await signOut(page);
  await signIn(page, name, 'personal-test-password');
  await section(page, '账号设置');
  settings = page.getByRole('dialog', { name: '账号设置', exact: true });
  await expect(settings.getByLabel('外观模式')).toHaveValue('system');
  await expect(settings.getByLabel('播放样式')).toHaveValue('cover');
  await expect(settings.getByLabel('歌曲列表大小')).toHaveValue('medium');
  await settings.getByLabel('外观模式').selectOption('light');
  await settings.getByLabel('播放样式').selectOption('cassette');
  await settings.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await section(page, '离线音乐');
  await page.getByRole('region', { name: '离线音乐', exact: true }).locator('summary').click();
  await expect(page.getByLabel('默认下载音质', { exact: true })).toHaveValue('0');
  await page.getByLabel('默认下载音质', { exact: true }).selectOption('320');
  await signOut(page);
  await signIn(page, 'admin', 'disposable-browser-test-password');
  await section(page, '账号设置');
  settings = page.getByRole('dialog', { name: '账号设置', exact: true });
  await expect(settings.getByLabel('外观模式')).toHaveValue('dark');
  await expect(settings.getByLabel('播放样式')).toHaveValue('vinyl');
  await expect(settings.getByLabel('歌曲列表大小')).toHaveValue('large');
  await settings.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await section(page, '离线音乐');
  await page.getByRole('region', { name: '离线音乐', exact: true }).locator('summary').click();
  await expect(page.getByLabel('默认下载音质', { exact: true })).toHaveValue('192');
  await page.request.delete(`/api/v1/manage/users/${created.id}`, { headers });
});
