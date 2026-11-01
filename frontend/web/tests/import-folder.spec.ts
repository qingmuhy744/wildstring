import { expect, test, type Page } from '@playwright/test';
import { login, manageTab } from './helpers';

const sources = [
  { id: 'source-a', name: '磁盘 A', path: '/imports/a' },
  { id: 'source-b', name: '磁盘 B', path: '/imports/b' },
];

async function mockSources(page: Page) {
  await page.route('**/api/v1/manage/library/sources', (route) =>
    route.fulfill({ json: { items: sources } }),
  );
  // A failed trash request must not prevent browsing an import source.
  await page.route('**/api/v1/manage/library/trash', (route) =>
    route.fulfill({ status: 503, json: { detail: 'trash_temporarily_unavailable' } }),
  );
}

test('切换来源、浏览子目录、预览与导入保持同一范围，取消不改变选择', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockSources(page);
  const folders: string[] = [];
  await page.route('**/api/v1/manage/library/folders?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const source_id = params.get('source_id')!;
    const path = params.get('path')!;
    folders.push(`${source_id}:${path}`);
    return route.fulfill({
      json: {
        source_id,
        path,
        items:
          path === '.'
            ? [{ name: '新发行', path: '新发行', kind: 'folder' }]
            : [
                {
                  name: '第一首.flac',
                  path: `${path}/第一首.flac`,
                  kind: 'file',
                  importable: true,
                },
                {
                  name: '第二首.flac',
                  path: `${path}/第二首.flac`,
                  kind: 'file',
                  importable: true,
                },
                { name: 'cover.jpg', path: `${path}/cover.jpg`, kind: 'file' },
              ],
      },
    });
  });
  const previews: unknown[] = [];
  await page.route('**/api/v1/manage/library/import/preview', (route) => {
    const selection = route.request().postDataJSON();
    previews.push(selection);
    return route.fulfill({
      json: {
        ...selection,
        count: 2,
        files: ['新发行/第一首.flac', '新发行/第二首.flac'],
        pending_markers: [],
      },
    });
  });
  const imports: unknown[] = [];
  await page.route('**/api/v1/manage/library/import', (route) => {
    imports.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { id: 'scoped-import', status: 'queued' } });
  });
  await login(page);
  await manageTab(page, '导入与整理');
  const workspace = page.getByRole('region', { name: '导入来源工作台', exact: true });
  await expect(workspace.locator('.source-folder-selection')).toContainText('磁盘 A');
  expect(folders).toEqual([]);
  await workspace.getByRole('button', { name: '浏览文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择导入文件夹', exact: true });
  await expect(dialog.getByRole('button', { name: /^新发行(?: 文件夹)?$/ })).toBeVisible();
  if (info.project.name === 'desktop')
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(900);
  await dialog.getByRole('combobox', { name: '导入来源', exact: true }).selectOption('source-b');
  await expect.poll(() => folders).toContain('source-b:.');
  await dialog.getByRole('button', { name: /^新发行(?: 文件夹)?$/ }).click();
  await expect(dialog.getByLabel('来源内路径', { exact: true })).toHaveValue('新发行');
  await dialog.getByRole('button', { name: '上一级', exact: true }).click();
  await expect(dialog.getByLabel('来源内路径', { exact: true })).toHaveValue('.');
  await dialog.getByLabel('来源内路径', { exact: true }).fill('新发行');
  await dialog.getByRole('button', { name: '打开路径', exact: true }).click();
  await expect(dialog.getByText('第二首.flac', { exact: true })).toBeVisible();
  await dialog.getByLabel('筛选当前文件夹', { exact: true }).fill('第一');
  await expect(dialog.getByText('第二首.flac', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('筛选当前文件夹', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '预览此文件夹', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('2 个音频文件');
  expect(previews).toEqual([{ source_id: 'source-b', path: '新发行' }]);
  expect(imports).toEqual([]);
  await page.screenshot({ path: `../../artifacts/import-folder-${info.project.name}.png` });
  // Editing the path without opening it must not silently change the confirmed scope.
  await dialog.getByLabel('来源内路径', { exact: true }).fill('未打开的目录');
  await dialog.getByRole('button', { name: '选择此文件夹', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(workspace.locator('.source-folder-selection')).toContainText('/imports/b/新发行');
  await expect(workspace.locator('.source-preview')).toContainText('2 个音频文件');
  await workspace.getByRole('button', { name: '浏览文件夹', exact: true }).click();
  await dialog.getByRole('navigation').getByRole('button', { name: '磁盘 B', exact: true }).click();
  await expect(dialog.getByLabel('来源内路径', { exact: true })).toHaveValue('.');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(workspace.locator('.source-folder-selection')).toContainText('/imports/b/新发行');
  await workspace.getByRole('button', { name: '导入所选文件夹', exact: true }).click();
  await expect.poll(() => imports).toEqual([{ source_id: 'source-b', path: '新发行' }]);
  expect(errors).toEqual([]);
});

test('目录读取失败可重试，窄屏与明暗主题不会遮挡选择按钮', async ({ page }, info) => {
  await mockSources(page);
  let failed = true;
  await page.route('**/api/v1/manage/library/folders?**', (route) => {
    if (failed) return route.fulfill({ status: 404, json: { detail: 'source_folder_not_found' } });
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        source_id: params.get('source_id'),
        path: params.get('path'),
        items: Array.from({ length: 30 }, (_, index) => ({
          name: `用于检查长名称与横向空间的专辑 ${index + 1}`,
          path: `专辑${index + 1}`,
          kind: 'folder',
        })),
      },
    });
  });
  await login(page);
  await manageTab(page, '导入与整理');
  await page.getByRole('button', { name: '浏览文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择导入文件夹', exact: true });
  await expect(dialog.getByRole('alert')).toBeVisible();
  const confirm = dialog.getByRole('button', { name: '选择此文件夹', exact: true });
  await expect(confirm).toBeDisabled();
  failed = false;
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  const widths = info.project.name === 'desktop' ? [1360, 820] : [393, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 820 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expect(confirm).toBeInViewport();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: `../../artifacts/import-folder-${width}-${theme}.png` });
    }
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.source-folder-selection')).toContainText('/imports/a');
});
