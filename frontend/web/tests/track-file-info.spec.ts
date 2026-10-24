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
