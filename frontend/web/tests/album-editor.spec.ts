import { expect, test, type Locator, type Page } from '@playwright/test';
import { login, section } from './helpers';

async function checkFixedActions(dialog: Locator, primary: Locator) {
  const body = dialog.locator('.scroll-dialog-body');
  const close = dialog.locator('.dialog-close');
  const before = await close.boundingBox();
  const actionBefore = await primary.boundingBox();
  expect(
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    }),
  ).toBeGreaterThan(0);
  expect(await close.boundingBox()).toEqual(before);
  expect(await primary.boundingBox()).toEqual(actionBefore);
  await expect(close).toBeInViewport();
  await expect(primary).toBeInViewport();
}

async function screenshotThemes(page: Page, name: string) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) =>
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value })),
      theme,
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: `../../artifacts/${name}-${theme}.png` });
  }
}

test('专辑编辑滚到末尾仍能保存和关闭，未保存时询问', async ({ page }, info) => {
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1360, height: 600 },
  );
  await login(page);

  // 切换到专辑视图
  await section(page, '专辑');

  const albumCard = page.locator('.album-card').first();
  await expect(albumCard).toBeVisible();

  // 右键或通过操作按钮打开专辑卡片操作菜单
  const actionBtn = albumCard.locator('.album-card-action');
  await actionBtn.click();

  // 菜单应弹出
  const menu = page.locator('.playlist-context');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('编辑专辑与封面');

  // 点击编辑专辑与封面
  await menu.getByRole('menuitem', { name: '编辑专辑与封面' }).click();

  // 专辑编辑弹窗应弹出
  const dialog = page.getByRole('dialog', { name: '编辑专辑', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('专辑名称 (ALBUM)');
  await expect(dialog).toContainText('专辑艺人 (ALBUMARTIST)');
  await expect(dialog).toContainText('发行日期 (DATE)');

  // 展开高级标签
  await dialog.getByRole('button', { name: '展开唱片厂牌、编号与高级标签' }).click();
  await expect(dialog).toContainText('唱片厂牌 (LABEL / ORGANIZATION)');
  await expect(dialog).toContainText('唱片编号 (CATALOGNUMBER)');
  await expect(dialog).toContainText('总碟数 (DISCTOTAL)');

  await checkFixedActions(dialog, dialog.locator('.scroll-dialog-footer .primary'));
  await screenshotThemes(page, `album-editor-fixed-${info.project.name}`);
  const title = dialog.getByRole('textbox', { name: '专辑名称 (ALBUM)', exact: true });
  await title.fill('未保存的合成专辑名称');
  page.once('dialog', async (confirm) => {
    expect(confirm.message()).toBe('放弃未保存的更改？');
    await confirm.dismiss();
  });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(title).toHaveValue('未保存的合成专辑名称');
  page.once('dialog', (confirm) => confirm.accept());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('歌曲编辑的关闭和预览操作保持可达，歌词草稿也会受保护', async ({ page }, info) => {
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1360, height: 600 },
  );
  await login(page);
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  const preview = dialog.getByRole('button', { name: '预览修改', exact: true });
  await expect(preview).toBeEnabled();
  await checkFixedActions(dialog, preview);
  await screenshotThemes(page, `track-editor-fixed-${info.project.name}`);
  await dialog.getByRole('button', { name: '查看文件属性与物理重排', exact: true }).click();
  const fileInfo = page.getByRole('dialog', { name: '歌曲文件与属性', exact: true });
  await expect(fileInfo.getByText('文件状态', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fileInfo).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '歌词', exact: true }).click();
  const lyrics = dialog.getByLabel('歌词内容', { exact: true });
  await lyrics.fill('未保存的合成歌词');
  page.once('dialog', async (confirm) => {
    expect(confirm.message()).toBe('放弃未保存的更改？');
    await confirm.dismiss();
  });
  await page.keyboard.press('Escape');
  await expect(lyrics).toHaveValue('未保存的合成歌词');
  page.once('dialog', (confirm) => confirm.accept());
  await dialog.getByRole('button', { name: '关闭歌曲编辑', exact: true }).click();
  await expect(dialog).toBeHidden();
});
