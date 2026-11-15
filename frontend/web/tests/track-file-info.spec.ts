import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('歌曲菜单打开文件属性与路径弹窗，展示相对与物理路径并支持重排', async ({ page }, info) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items[0];

  let reorganized = false;
  await page.route(`**/api/v1/tracks/${track.id}/file-info`, async (route) => {
    return route.fulfill({
      json: {
        track_id: track.id,
        format: 'flac',
        size_bytes: 25480000,
        path: '原艺人/原专辑/CD01/01 - 歌曲.flac',
        absolute_path: '/music/原艺人/原专辑/CD01/01 - 歌曲.flac',
        suggested_path: reorganized
          ? '原艺人/原专辑/CD01/01 - 歌曲.flac'
          : '新艺人/新专辑/CD01/05 - 新歌.flac',
        in_sync: reorganized,
        file_exists: true,
      },
    });
  });

  await page.route(`**/api/v1/manage/tracks/${track.id}/reorganize-file`, async (route) => {
    reorganized = true;
    return route.fulfill({
      json: {
        status: 'reorganized',
        changed: true,
        old_path: '原艺人/原专辑/CD01/01 - 歌曲.flac',
        new_path: '新艺人/新专辑/CD01/05 - 新歌.flac',
        moved_sidecars: ['原艺人/原专辑/CD01/01 - 歌曲.lrc'],
      },
    });
  });

  // Open track actions menu
  const trackRow = page.locator('.track-row, .track-item').filter({ hasText: track.title }).first();
  await trackRow.getByLabel(`歌曲操作 ${track.title}`).click();

  // Click file info menu item
  await page.getByRole('button', { name: '文件属性与路径' }).click();

  // Dialog should be visible
  const dialog = page.locator('.track-file-info-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('歌曲文件与属性');
  await expect(dialog).toContainText(track.title);
  await expect(dialog).toContainText('FLAC');
  await expect(dialog).toContainText('24.30 MB');
  await expect(dialog).toContainText('原艺人/原专辑/CD01/01 - 歌曲.flac');
  await expect(dialog).toContainText('/music/原艺人/原专辑/CD01/01 - 歌曲.flac');

  // Shows desynced warning
  await expect(dialog).toContainText('物理路径与最新元数据未对齐');
  await expect(dialog).toContainText('新艺人/新专辑/CD01/05 - 新歌.flac');

  // Click reorganize button
  await dialog.getByRole('button', { name: '按最新元数据重排物理文件' }).click();

  // Action message shown and status synced
  await expect(dialog).toContainText('物理文件已规范重排到新路径');
  await expect(dialog).toContainText('已对齐最新元数据');

  // Close dialog
  await dialog.locator('.file-info-footer button').click();
  await expect(dialog).toBeHidden();
});

test('真实接口下所有者可见服务器物理路径，普通听众隐藏宿主机路径', async ({ page }, info) => {
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await login(page);

  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const track = tracks[0];
  const libraries = await (await page.request.get('/api/v1/libraries')).json();
  const headers = { 'X-Wildstring-Client': 'web' };

  const ownerInfoRes = await page.request.get(`/api/v1/tracks/${track.id}/file-info`);
  expect(ownerInfoRes.ok()).toBe(true);
  const ownerInfo = await ownerInfoRes.json();
  expect(ownerInfo.absolute_path).toBeTruthy();
  expect(ownerInfo.absolute_path).toBe(ownerInfo.full_path);

  const openFileInfoDialog = async () => {
    const trackRow = page
      .locator('.track-row, .track-item')
      .filter({ hasText: track.title })
      .first();
    await trackRow.getByLabel(`歌曲操作 ${track.title}`).click();
    await page.getByRole('button', { name: '文件属性与路径' }).click();
    const dialog = page.locator('.track-file-info-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  };

  // Owner sees relative path and host absolute physical path.
  const ownerDialog = await openFileInfoDialog();
  await expect(ownerDialog).toContainText('托管曲库相对路径');
  await expect(ownerDialog).toContainText(ownerInfo.path);
  await expect(ownerDialog).toContainText('服务器绝对物理路径');
  await expect(ownerDialog).toContainText(ownerInfo.absolute_path);

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.screenshot({
      path: `../../artifacts/file-info-owner-${info.project.name}-${theme}.png`,
    });
  }
  await ownerDialog.locator('.file-info-footer button').click();
  await expect(ownerDialog).toBeHidden();

  // Create a granted listener account and switch session.
  const username = `fi-${info.project.name}-${Date.now().toString(36)}`;
  const password = 'listener-file-info-password';
  const created = await page.request.post('/api/v1/manage/users', {
    headers,
    data: {
      username,
      password,
      profile: 'listener',
      library_ids: libraries.map((library: { id: string }) => library.id),
    },
  });
  expect(created.status()).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  const signedIn = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { username, password },
  });
  expect(signedIn.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(3);

  const listenerInfoRes = await page.request.get(`/api/v1/tracks/${track.id}/file-info`);
  expect(listenerInfoRes.ok()).toBe(true);
  const listenerInfo = await listenerInfoRes.json();
  expect(listenerInfo.absolute_path).toBeNull();
  expect(listenerInfo.full_path).toBeNull();
  expect(listenerInfo.library_root).toBeNull();
  expect(listenerInfo.source_path).toBeNull();
  expect(listenerInfo.path).toBe(ownerInfo.path);

  const listenerDialog = await openFileInfoDialog();
  await expect(listenerDialog).toContainText('托管曲库相对路径');
  await expect(listenerDialog).toContainText(ownerInfo.path);
  await expect(listenerDialog.getByText('服务器绝对物理路径')).toHaveCount(0);
  await expect(listenerDialog).not.toContainText(ownerInfo.absolute_path);

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.screenshot({
      path: `../../artifacts/file-info-listener-${info.project.name}-${theme}.png`,
    });
  }
  await listenerDialog.locator('.file-info-footer button').click();
  await expect(listenerDialog).toBeHidden();
});
