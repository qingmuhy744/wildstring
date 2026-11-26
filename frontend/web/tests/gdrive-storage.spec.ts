import { expect, type Page, type TestInfo } from '@playwright/test';
import { audio, manageTab, section, test } from './helpers';

test.skip(
  process.env.WILDSTRING_TEST_GDRIVE !== '1',
  'Requires the loopback Google Drive fixture.',
);

async function visual(page: Page, info: TestInfo, state: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await page.screenshot({
      animations: 'disabled',
      scale: 'css',
      path: info.outputPath(`drive-${state}-${theme}.png`),
    });
  }
}

test('Google Drive 绑定、建库、同步、缓存和同源播放与阅读', async ({ page, isMobile }, info) => {
  test.setTimeout(75_000);
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  // The consent UI is fixture-only. Authorization completion uses the real callback,
  // browser cookie and client header, then exchanges tokens with the loopback provider.
  await page.route('https://accounts.google.com/o/oauth2/v2/auth?*', async (route) => {
    const request = new URL(route.request().url());
    expect(request.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.readonly',
    );
    const callback = new URL('/api/v1/remote-storage/callback', page.url());
    expect(request.searchParams.get('redirect_uri')).toBe(callback.href);
    callback.searchParams.set('state', request.searchParams.get('state')!);
    callback.searchParams.set('code', 'browser-test-code');
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
  let loaded!: () => void;
  const pending = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  await page.route(
    '**/api/v1/remote-storage/accounts',
    async (route) => {
      await pending;
      await route.fulfill({ json: { items: [] } });
    },
    { times: 1 },
  );
  await manageTab(page, '存储与曲库');
  const accounts = page.getByRole('region', { name: 'Google Drive 账号', exact: true });
  try {
    await expect(accounts.getByRole('status')).toContainText('正在读取 Google Drive 账号');
    await visual(page, info, 'loading');
  } finally {
    loaded();
  }
  await expect(accounts.getByText('尚未添加 Google Drive 账号。')).toBeVisible();
  await visual(page, info, 'empty');
  const accountName = `测试云端目录 ${info.project.name}`;
  await expect(accounts.getByRole('button', { name: '添加账号' })).toBeVisible();
  await accounts.getByRole('button', { name: '添加账号' }).click();
  await accounts.getByLabel('账号名称').fill(accountName);
  await accounts.getByLabel('授权模式').selectOption('drive_readonly');
  await accounts.getByLabel('Client ID').fill('browser-client-id');
  await accounts.getByLabel('Client secret').fill('browser-fixture-secret');
  await accounts.getByRole('button', { name: '保存账号' }).scrollIntoViewIfNeeded();
  await visual(page, info, 'account');
  await accounts.getByRole('button', { name: '保存账号' }).click();
  const account = accounts.locator('.drive-account-row').filter({ hasText: accountName });
  await account.getByRole('button', { name: '连接 Google Drive' }).click();
  await expect(accounts.getByText('Google Drive 已连接。', { exact: true })).toBeVisible();
  await account.getByRole('button', { name: '测试连接' }).click();
  await expect(accounts.getByText('连接正常。', { exact: true })).toBeVisible();

  const music = page.getByRole('region', { name: '音乐库配置', exact: true });
  const musicName = `我的云端音乐 ${info.project.name}`;
  await music.getByLabel('存储后端').selectOption('gdrive');
  await music.getByLabel('Google Drive 账号').selectOption({ label: accountName });
  await music.getByLabel('Drive 文件夹 ID').fill('cloud-music');
  await expect(music.getByLabel('本机缓存上限（MB）')).toHaveValue('2048');
  await music.getByLabel('库名称', { exact: true }).fill(musicName);
  await music.getByRole('button', { name: '保存音乐库', exact: true }).click();
  const musicControls = music.getByRole('region', { name: 'Google Drive', exact: true });
  await expect(musicControls.getByText('尚未同步。')).toBeVisible();
  await musicControls.getByRole('button', { name: '同步 Google Drive' }).click();
  await expect(musicControls.getByText('同步完成。')).toBeVisible();
  await expect(musicControls.getByText(/^最近同步/)).toBeVisible();

  await section(page, '全部歌曲');
  await page.getByLabel('选择音乐库', { exact: true }).selectOption({ label: musicName });
  await page.getByRole('button', { name: '播放 云端测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0);
  const streamURL = new URL((await audio(page)).source);
  expect(streamURL.origin).toBe(new URL(page.url()).origin);
  expect(streamURL.pathname).toMatch(/^\/api\/v1\/tracks\/[a-f0-9]+\/stream$/);
  expect((await page.request.get(streamURL.href)).ok()).toBeTruthy();

  await manageTab(page, '存储与曲库');
  await music.getByRole('button', { name: new RegExp(musicName) }).click();
  await expect(musicControls.getByRole('button', { name: '清理缓存' })).toBeEnabled();
  await musicControls.scrollIntoViewIfNeeded();
  await visual(page, info, 'music');
  await musicControls.getByRole('button', { name: '清理缓存' }).click();
  await expect(musicControls.getByText('当前占用 0 MB')).toBeVisible();
  await musicControls.getByLabel('本机缓存上限（MB）').fill('0');
  await musicControls.getByRole('button', { name: '保存缓存上限' }).click();
  await expect(musicControls.getByText('缓存上限已保存。')).toBeVisible();

  const books = page.getByRole('region', { name: '书库与存储配置', exact: true });
  const bookName = `我的云端书库 ${info.project.name}`;
  await manageTab(page, '书库与存储');
  await books.getByLabel('存储后端').selectOption('gdrive');
  await books.getByLabel('Google Drive 账号').selectOption({ label: accountName });
  await books.getByLabel('Drive 文件夹 ID').fill('cloud-books');
  await books.getByRole('textbox', { name: '名称', exact: true }).fill(bookName);
  await books.getByRole('button', { name: '新建书库', exact: true }).click();
  const bookControls = books.getByRole('region', { name: 'Google Drive', exact: true });
  await bookControls.getByRole('button', { name: '同步 Google Drive' }).click();
  await expect(bookControls.getByText('同步完成。')).toBeVisible();
  await bookControls.scrollIntoViewIfNeeded();
  await visual(page, info, 'books');

  await section(page, '书架');
  const [bookLibraryId] = await page
    .getByLabel('书库', { exact: true })
    .selectOption({ label: bookName });
  await page
    .locator('.bookshelf-grid')
    .getByRole('button', { name: /云端读本/ })
    .click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '云端读本', exact: true });
  const { items: cloudBooks } = await (
    await page.request.get(`/api/v1/books?library_id=${bookLibraryId}`)
  ).json();
  const ebook = cloudBooks.find((item: { title: string }) => item.title === '云端读本');
  const original = await page.request.get(`/api/v1/books/${ebook.id}/ebook/download`);
  expect(original.ok()).toBeTruthy();
  expect((await original.body()).subarray(0, 2).toString()).toBe('PK');
  await expect(reader.getByRole('article')).toBeVisible();
  await expect(reader.getByRole('article').locator('p').first()).not.toBeEmpty();
  await reader.getByRole('button', { name: '返回书籍' }).click();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page
    .locator('.bookshelf-grid')
    .getByRole('button', { name: /云端听书/ })
    .click();
  await page.getByRole('button', { name: '收听', exact: true }).click();
  const audiobook = page.locator('audio[src*="/audiobook/files/0/stream"]');
  await expect(audiobook).toHaveCount(1);
  await expect
    .poll(() => audiobook.evaluate((el: HTMLAudioElement) => el.currentTime))
    .toBeGreaterThan(0);

  await manageTab(page, '书库与存储');
  await books.getByRole('button', { name: new RegExp(bookName) }).click();
  await expect(bookControls.getByRole('button', { name: '清理缓存' })).toBeEnabled();
  await bookControls.getByRole('button', { name: '清理缓存' }).click();
  await expect(bookControls.getByText('当前占用 0 MB')).toBeVisible();

  await manageTab(page, '存储与曲库');
  await music.getByRole('button', { name: new RegExp(musicName) }).click();
  await page.route(
    '**/api/v1/remote-storage/sync',
    (route) =>
      route.fulfill({
        status: 503,
        json: { detail: 'remote_storage_rate_limited' },
      }),
    { times: 1 },
  );
  await musicControls.getByRole('button', { name: '同步 Google Drive' }).click();
  await expect(musicControls.getByRole('alert')).toContainText('正在限流');
  await musicControls.scrollIntoViewIfNeeded();
  await visual(page, info, 'error');
  await account.getByRole('button', { name: '解除授权' }).click();
  await expect(account.getByRole('button', { name: '重新授权' })).toBeVisible();
  await expect(musicControls.getByRole('button', { name: '重新授权' })).toBeVisible();
  await musicControls.scrollIntoViewIfNeeded();
  await visual(page, info, 'reconnect');
});
